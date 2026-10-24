const os           = require('os');
const EventEmitter = require('events');
const { request, ApiError } = require('./api');

const SYNC_MS        = 120_000;
const MAX_BACKOFF_MS = 600_000;
const LIMITS         = { seg: 300, act: 1000, app: 1500 };

class Sync extends EventEmitter {
  constructor({ config, queue, tracker, shots, appVersion }) {
    super();
    Object.assign(this, { config, queue, tracker, shots, appVersion });
    this.online = null;
    this.lastSyncAt = null;
    this.failures = 0;
    this.timer = null;
    this.inFlight = null;
  }

  get token() { return this.config.get('token'); }

  start() { this.schedule(1000); }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), ms);
  }

  // Status changed: tell the server within a few seconds instead of waiting for the next 2-minute sync
  soon() { this.schedule(3000); }

  run() {
    if (!this.inFlight) this.inFlight = this.attempt().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async attempt() {
    try {
      if (!this.token) {
        const status = await this.register();
        this.setOnline(true);
        if (status !== 'approved') return this.schedule(status === 'pending' ? SYNC_MS : 30 * 60_000);
      }
      const more = await this.syncOnce();
      await this.uploadScreenshots();
      this.failures = 0;
      this.setOnline(true);
      this.schedule(more ? 2000 : SYNC_MS);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && this.token) {
        // Token no longer valid (revoked, or rotated by a re-install): ask the server what this computer is now
        this.config.set({ token: null });
        return this.schedule(1000);
      }
      this.failures++;
      this.setOnline(false, err.message);
      this.schedule(Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(this.failures - 1, 5)));
    }
  }

  async register() {
    const res = await request('/v2/register', {
      method: 'POST',
      secret: true,
      body: {
        device_id:       this.config.get('device_id'),
        name:            this.config.get('username'),
        hostname:        os.hostname(),
        platform:        process.platform,
        app_version:     this.appVersion,
        consent_version: this.config.get('consent_version'),
      },
    });
    const patch = { reg_status: res.status, token: res.token || null };
    if (res.user) patch.user_name = res.user.name;
    // Only notify about decisions made after this computer joined
    if (res.token && !this.config.get('decisions_since')) patch.decisions_since = new Date().toISOString();
    this.config.set(patch);
    this.emit('status', res.status);
    return res.status;
  }

  async syncOnce() {
    this.tracker.pushSnapshot();
    const batch = this.queue.take(LIMITS);
    const res = await request('/v2/sync', {
      method: 'POST',
      token: this.token,
      body: {
        client_now:      new Date().toISOString(),
        app_version:     this.appVersion,
        segments:        batch.segments,
        activity:        batch.activity,
        apps:            batch.apps,
        live:            this.tracker.live(),
        decisions_since: this.config.get('decisions_since') || null,
      },
    });
    this.queue.ack(batch.revs);
    const wasPending = this.config.get('reg_status') !== 'approved';
    this.config.set({
      settings:        res.settings,
      projects:        res.projects,
      user_name:       res.user.name,
      decisions_since: res.decisions_cursor,
      reg_status:      'approved',
    });
    this.lastSyncAt = Date.now();
    if (wasPending) this.emit('status', 'approved');
    this.emit('synced', res);
    if (res.decisions && res.decisions.length) this.emit('decisions', res.decisions);
    return batch.segments.length >= LIMITS.seg || batch.activity.length >= LIMITS.act || batch.apps.length >= LIMITS.app;
  }

  async uploadScreenshots() {
    await this.shots.uploadOutbox(async meta => {
      try {
        await request('/v2/screenshots', { method: 'POST', token: this.token, body: meta, timeoutMs: 120_000 });
      } catch (err) {
        // The server refused this image for good (too big, bad data): drop it instead of retrying forever
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && ![401, 408, 429].includes(err.status)) return;
        throw err;
      }
    });
  }

  setOnline(online, error) {
    const changed = this.online !== online;
    this.online = online;
    this.lastError = online ? null : error;
    if (changed) this.emit('status', this.config.get('reg_status'));
  }

  requireToken() {
    if (!this.token) throw new ApiError(0, this.config.get('reg_status') === 'pending'
      ? 'This computer is waiting for approval.'
      : 'Not connected to the server yet.');
  }

  async fetchSessions(from, to) {
    this.requireToken();
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    return (await request('/v2/me/sessions?' + q, { token: this.token })).sessions;
  }

  async fetchAdjustments() {
    this.requireToken();
    return (await request('/v2/me/adjustments', { token: this.token })).adjustments;
  }

  async requestAdjustment({ client_id, session_id, note }) {
    this.requireToken();
    await this.run();   // the segment must reach the server before it can be referenced
    const body = session_id ? { session_id, note } : { client_id, note };
    return (await request('/v2/adjustments', { method: 'POST', token: this.token, body })).adjustment;
  }
}

module.exports = Sync;
