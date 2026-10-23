/**
 * Activity tracker — detects active/idle sessions via mouse + keyboard events
 * and powerMonitor (sleep/lock). Runs in the renderer process.
 */

const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS  = 30 * 1000;      // check every 30s

class ActivityTracker {
  constructor({ onSession, username, backendUrl, apiSecret }) {
    this.onSession   = onSession;
    this.username    = username;
    this.backendUrl  = backendUrl;
    this.apiSecret   = apiSecret;

    this.sessionStart  = Date.now();
    this.lastActivity  = Date.now();
    this.currentStatus = 'active';
    this.timer         = null;
  }

  start() {
    // Track mouse and keyboard activity
    document.addEventListener('mousemove',  () => this._bump(), { passive: true });
    document.addEventListener('mousedown',  () => this._bump(), { passive: true });
    document.addEventListener('keydown',    () => this._bump(), { passive: true });
    document.addEventListener('wheel',      () => this._bump(), { passive: true });

    this.timer = setInterval(() => this._check(), POLL_INTERVAL_MS);
    this._check();
  }

  stop() {
    clearInterval(this.timer);
    // Flush current session
    this._flush(this.currentStatus);
  }

  _bump() {
    const now = Date.now();
    if (this.currentStatus === 'idle') {
      // Was idle — close idle session, start new active session
      this._flush('idle');
      this.sessionStart  = now;
      this.currentStatus = 'active';
    }
    this.lastActivity = now;
  }

  _check() {
    const idleMs = Date.now() - this.lastActivity;
    if (idleMs >= IDLE_THRESHOLD_MS && this.currentStatus === 'active') {
      // Just went idle — close active session at the point idling began
      const idleStartedAt = this.lastActivity;
      this._flush('active', new Date(this.sessionStart), new Date(idleStartedAt));
      this.sessionStart  = idleStartedAt;
      this.currentStatus = 'idle';
    }
  }

  _flush(status, start, end) {
    const s = start || new Date(this.sessionStart);
    const e = end   || new Date();
    const durationMs = e - s;
    if (durationMs < 30_000) return; // ignore < 30s sessions

    const session = {
      username:  this.username,
      startTime: s.toISOString(),
      endTime:   e.toISOString(),
      duration:  Math.round(durationMs / 60000), // minutes
      status,
    };

    this.onSession(session);
    this._post(session);
  }

  async _post(session) {
    try {
      await fetch(`${this.backendUrl}/session`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-secret': this.apiSecret },
        body:    JSON.stringify(session),
      });
    } catch (e) {
      console.warn('Failed to post session:', e.message);
    }
  }
}

module.exports = ActivityTracker;
