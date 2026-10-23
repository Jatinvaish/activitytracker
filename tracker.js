const { ipcRenderer } = require('electron');

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
    // DOM events: extra precision when window is visible
    document.addEventListener('mousemove', () => this._bumpLocal(), { passive: true });
    document.addEventListener('mousedown', () => this._bumpLocal(), { passive: true });
    document.addEventListener('keydown',   () => this._bumpLocal(), { passive: true });
    document.addEventListener('wheel',     () => this._bumpLocal(), { passive: true });

    // Poll system idle time — works even when window is hidden
    this.timer = setInterval(() => this._check(), POLL_INTERVAL_MS);
    this._check();
  }

  stop() {
    clearInterval(this.timer);
    this._flush(this.currentStatus);
  }

  // Called from DOM events (window visible) — updates lastActivity immediately
  _bumpLocal() {
    this.lastActivity = Date.now();
    if (this.currentStatus === 'idle') {
      this._flush('idle');
      this.sessionStart  = this.lastActivity;
      this.currentStatus = 'active';
    }
  }

  async _check() {
    try {
      // Ask main process for real system idle time — works when window is hidden
      const idleSecs    = await ipcRenderer.invoke('get-idle-time');
      const systemIdleMs = idleSecs * 1000;

      // If the system was active recently, sync our lastActivity
      if (systemIdleMs < POLL_INTERVAL_MS) {
        this.lastActivity = Date.now() - systemIdleMs;
      }
    } catch {}

    const idleMs = Date.now() - this.lastActivity;

    if (idleMs >= IDLE_THRESHOLD_MS && this.currentStatus === 'active') {
      // Transition: active → idle
      const idleStartedAt = new Date(this.lastActivity);
      this._flush('active', new Date(this.sessionStart), idleStartedAt);
      this.sessionStart  = this.lastActivity;
      this.currentStatus = 'idle';

    } else if (idleMs < IDLE_THRESHOLD_MS && this.currentStatus === 'idle') {
      // Transition: idle → active (caught via system idle time when window hidden)
      this._flush('idle');
      this.sessionStart  = Date.now();
      this.currentStatus = 'active';
    }
  }

  _flush(status, start, end) {
    const s = start || new Date(this.sessionStart);
    const e = end   || new Date();
    const durationMs = e - s;
    if (durationMs < 30_000) return; // ignore < 30s

    const session = {
      username:  this.username,
      startTime: s.toISOString(),
      endTime:   e.toISOString(),
      duration:  Math.round(durationMs / 60000),
      status,
    };

    this.onSession(session);
    this._post(session);

    // Reset session start for next segment
    this.sessionStart = e.getTime();
  }

  async _post(session) {
    try {
      await fetch(`${this.backendUrl}/session`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-secret': this.apiSecret },
        body:    JSON.stringify(session),
      });
    } catch (err) {
      console.warn('Session post failed:', err.message);
    }
  }
}

module.exports = ActivityTracker;
