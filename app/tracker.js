const crypto       = require('crypto');
const EventEmitter = require('events');

const SLOT_MS            = 10 * 60_000;
const HOUR_MS            = 3600_000;
const APP_SAMPLE_SECS    = 5;
const MEETING_CHECK_SECS = 15;
const FROZEN_GAP_MS      = 30_000;

const iso = ms => new Date(ms).toISOString();
const pad = n => String(n).padStart(2, '0');
function localDay(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function startOfDay(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

// Modes: active (incl. meetings), idle, away (locked/asleep), break (employee pressed Break).
// Every mode change closes the current segment and opens a new one; segments are what the server stores.
class Tracker extends EventEmitter {
  constructor({ power, now = Date.now, queue, store, sampleApp, inMeeting, getSettings }) {
    super();
    Object.assign(this, { power, now, queue, store, sampleApp, inMeeting, getSettings });
    this.running = false;
    this.mode = 'stopped';
    this.seg = null;
    this.projectId = store.get('project_id') || null;
    this.segments = new Map();     // today's segments by client_id (local + other devices from the server)
    this.serverInfo = new Map();   // client_id → { id, adjustments } for segments the server knows
    this.slots = new Map();        // today's 10-min activity slots on this device
    this.appHours = new Map();     // current hour's app usage, uploaded per hour
    this.todayApps = new Map();    // today's app usage for the employee's own view
    this.currentApp = null;
    this.meetingActive = false;
    this.forcedAway = false;
    this.ticks = 0;
  }

  settings() { return this.getSettings(); }
  thresholdMs() { return this.settings().idle_threshold_mins * 60_000; }

  start() {
    if (this.running) return;
    this.running = true;
    const now = this.now();
    this.day = localDay(now);
    this.lastTick = now;
    this.recoverCrash();
    this.loadQueuedToday();
    const locked = this.power.getSystemIdleState(1) === 'locked';
    const idle = this.power.getSystemIdleTime() * 1000 >= this.thresholdMs();
    this.open(locked ? 'away' : idle ? 'idle' : 'active', now);
    this.timer = setInterval(() => this.tick(), 1000);
    this.emit('change');
  }

  // A segment that was still open when the app last died (crash, power cut) — close it where it stopped
  recoverCrash() {
    const open = this.store.get('open_segment');
    if (!open) return;
    this.queue.put('seg', open.client_id, { ...open, is_open: false, end_reason: 'crash' });
    this.store.set({ open_segment: null });
  }

  loadQueuedToday() {
    for (const { data } of Object.values(this.queue.items.seg)) {
      if (localDay(Date.parse(data.start_time)) === this.day) this.segments.set(data.client_id, { ...data, source: 'local' });
    }
  }

  tick() {
    const now = this.now();
    const prevTick = this.lastTick;
    this.lastTick = now;
    this.ticks++;

    // The process was frozen (sleep/hibernate without an event): that time was away, not idle
    if (now - prevTick > FROZEN_GAP_MS && this.mode !== 'away' && this.mode !== 'break') {
      this.switchTo('away', { at: prevTick + 1000, endReason: 'sleep' });
    }
    if (localDay(now) !== this.day) this.rollDay(now);

    if (this.mode === 'break') return this.afterTick(now);

    if (this.forcedAway || this.power.getSystemIdleState(1) === 'locked') {
      if (this.mode !== 'away') this.switchTo('away', { endReason: this.forcedAway ? 'sleep' : 'lock' });
      return this.afterTick(now);
    }

    const idleMs = this.power.getSystemIdleTime() * 1000;
    const threshold = this.thresholdMs();
    const meeting = this.meetingActive && this.settings().meeting_detection;

    if (this.mode === 'away') this.switchTo(idleMs < threshold ? 'active' : 'idle', { endReason: 'unlock' });

    if (this.mode === 'active') {
      this.count(now, idleMs < 1000);
      if (idleMs >= threshold) {
        if (meeting) {
          if (this.seg.category !== 'meeting') this.switchTo('active', { at: now - idleMs, category: 'meeting', endReason: 'meeting' });
        } else if (this.seg.category === 'meeting') {
          this.switchTo('idle', { endReason: 'meeting_end' });
        } else {
          this.switchTo('idle', { at: now - idleMs, endReason: 'idle', uncount: true });
        }
      } else if (this.seg.category === 'meeting' && !meeting) {
        this.switchTo('active', { endReason: 'meeting_end' });
      }
    } else if (this.mode === 'idle') {
      if (idleMs < threshold) {
        this.maybePrompt(this.switchTo('active', { at: now - idleMs, endReason: 'return' }));
      } else if (meeting) {
        this.switchTo('active', { category: 'meeting', endReason: 'meeting' });
      }
    }

    // Mic/camera only matter once input has stopped, or while a meeting segment is running
    if (this.settings().meeting_detection && (idleMs >= 60_000 || (this.seg && this.seg.category === 'meeting'))) {
      if (this.ticks % MEETING_CHECK_SECS === 0) this.inMeeting().then(v => { this.meetingActive = v; }).catch(() => {});
    } else {
      this.meetingActive = false;
    }

    this.afterTick(now);
  }

  afterTick(now) {
    if (this.mode === 'active' && this.settings().app_tracking) {
      if (this.ticks % APP_SAMPLE_SECS === 0 && !this.sampling) {
        this.sampling = true;
        Promise.resolve(this.sampleApp())
          .then(r => { if (r && this.mode === 'active') { this.currentApp = r; this.addAppTime(this.now(), r, APP_SAMPLE_SECS); } })
          .catch(() => {})
          .finally(() => { this.sampling = false; });
      }
    } else {
      this.currentApp = null;
    }
    if (this.ticks % 30 === 0) this.persistOpen(now);
    this.emit('tick');
  }

  count(now, hadInput) {
    this.seg.total++;
    if (hadInput) this.seg.active++;
    const slotStart = Math.floor(now / SLOT_MS) * SLOT_MS;
    if (slotStart !== this.curSlot) {
      if (this.curSlot !== undefined) this.queueSlot(this.curSlot);
      this.curSlot = slotStart;
    }
    let slot = this.slots.get(slotStart);
    if (!slot) { slot = { active: 0, total: 0 }; this.slots.set(slotStart, slot); }
    slot.total++;
    if (hadInput) slot.active++;
  }

  // Seconds counted as "active" while waiting for the idle threshold had no input; move them out
  uncount(secs) {
    this.seg.total = Math.max(this.seg.active, this.seg.total - secs);
    let left = secs;
    for (const start of [...this.slots.keys()].sort((a, b) => b - a)) {
      if (left <= 0) break;
      const s = this.slots.get(start);
      const take = Math.min(left, s.total - s.active);
      s.total -= take;
      left -= take;
      if (start !== this.curSlot) this.queueSlot(start);
    }
  }

  queueSlot(start) {
    const s = this.slots.get(start);
    if (s && s.total) this.queue.put('act', String(start), { slot_start: iso(start), active_secs: s.active, total_secs: s.total });
  }

  addAppTime(now, r, secs) {
    const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
    if (this.curHour !== undefined && hour !== this.curHour) this.queueAppHours(true);
    this.curHour = hour;
    const key = `${hour}|${r.app}|${r.label}`;
    const entry = this.appHours.get(key) || { hour_start: iso(hour), app: r.app, label: r.label, seconds: 0 };
    entry.seconds += secs;
    this.appHours.set(key, entry);
    const tKey = `${r.app}|${r.label}`;
    this.todayApps.set(tKey, (this.todayApps.get(tKey) || 0) + secs);
  }

  queueAppHours(clear) {
    for (const [key, entry] of this.appHours) this.queue.put('app', key, { ...entry });
    if (clear) this.appHours.clear();
  }

  open(mode, at, category) {
    const status = mode === 'break' ? 'away' : mode;
    this.mode = mode;
    this.seg = {
      client_id:  crypto.randomUUID(),
      start:      at,
      status,
      category:   category || null,
      project_id: status === 'active' ? this.projectId : null,
      active: 0, total: 0,
    };
  }

  record(seg, end, isOpen, endReason) {
    return {
      client_id:    seg.client_id,
      start_time:   iso(seg.start),
      end_time:     iso(end),
      status:       seg.status,
      category:     seg.category,
      note:         seg.note || null,
      project_id:   seg.project_id,
      activity_pct: seg.status === 'active' && seg.total ? Math.round(seg.active / seg.total * 100) : null,
      end_reason:   endReason || null,
      is_open:      isOpen,
      source:       'local',
    };
  }

  wire(rec) {
    const { source, ...data } = rec;
    return data;
  }

  close(at, endReason) {
    const rec = this.record(this.seg, at, false, endReason);
    if (at - this.seg.start >= 1000) {
      this.segments.set(rec.client_id, rec);
      this.queue.put('seg', rec.client_id, this.wire(rec));
    }
    return rec;
  }

  switchTo(mode, opts = {}) {
    const now = this.now();
    const at = Math.max(this.seg.start, Math.min(opts.at ?? now, now));
    if (opts.uncount) this.uncount(Math.round((now - at) / 1000));
    const closed = this.close(at, opts.endReason);
    this.open(mode, at, opts.category);
    this.emit('change');
    return closed;
  }

  maybePrompt(idleRec) {
    const after = this.settings().prompt_after_idle_mins;
    const mins = (Date.parse(idleRec.end_time) - Date.parse(idleRec.start_time)) / 60000;
    if (after > 0 && mins >= after && idleRec.status === 'idle') this.emit('prompt', idleRec);
  }

  rollDay(now) {
    const midnight = startOfDay(now);
    if (this.seg && this.seg.start < midnight) {
      const { category } = this.seg;
      const mode = this.mode;
      this.close(midnight, 'midnight');
      this.open(mode, midnight, category);
    }
    if (this.curSlot !== undefined) this.queueSlot(this.curSlot);
    this.queueAppHours(true);
    this.segments.clear();
    this.serverInfo.clear();
    this.slots.clear();
    this.todayApps.clear();
    this.curSlot = undefined;
    this.day = localDay(now);
    this.emit('day');
  }

  persistOpen(now) {
    if (this.seg && now - this.seg.start >= 1000) this.store.set({ open_segment: this.wire(this.record(this.seg, now, true)) });
  }

  // ── Controls ────────────────────────────────────────────────────────────────

  startBreak(kind) {
    if (!this.running || !['break', 'lunch'].includes(kind)) return;
    this.switchTo('break', { category: kind, endReason: 'break' });
  }

  endBreak() {
    if (!this.running || this.mode !== 'break') return;
    const idle = this.power.getSystemIdleTime() * 1000 >= this.thresholdMs();
    this.switchTo(idle ? 'idle' : 'active', { endReason: 'break_end' });
  }

  setProject(id) {
    this.projectId = id || null;
    this.store.set({ project_id: this.projectId });
    if (this.running && this.mode === 'active') this.switchTo('active', { category: this.seg.category, endReason: 'project' });
  }

  // From the "where were you?" prompt
  explain(clientId, category, note) {
    const rec = this.segments.get(clientId);
    if (!rec || rec.source !== 'local' || !['meeting', 'break', 'lunch', 'other'].includes(category)) return false;
    rec.category = category;
    rec.note = (note || '').trim().slice(0, 500) || null;
    this.queue.put('seg', clientId, this.wire(rec));
    this.emit('change');
    return true;
  }

  suspend() {
    this.forcedAway = true;
    if (this.running && this.mode !== 'away' && this.mode !== 'break') this.switchTo('away', { endReason: 'sleep' });
    this.persistOpen(this.now());
    this.queue.flush();
  }

  resume() {
    this.forcedAway = false;
    this.lastTick = this.now();
  }

  stop(reason) {
    if (!this.running) return;
    clearInterval(this.timer);
    this.running = false;
    this.close(this.now(), reason);
    if (this.curSlot !== undefined) this.queueSlot(this.curSlot);
    this.queueAppHours(true);
    this.store.set({ open_segment: null });
    this.queue.flush();
    this.mode = 'stopped';
    this.emit('change');
  }

  // ── Sync & UI ───────────────────────────────────────────────────────────────

  // Queue the live state (open segment, current slot, this hour's apps) right before an upload
  pushSnapshot() {
    if (!this.running) return;
    const now = this.now();
    if (now - this.seg.start >= 1000) this.queue.put('seg', this.seg.client_id, this.wire(this.record(this.seg, now, true)));
    if (this.curSlot !== undefined) this.queueSlot(this.curSlot);
    this.queueAppHours(false);
  }

  live() {
    if (!this.running) return null;
    const status = this.mode === 'break' ? 'break' : this.seg.category === 'meeting' ? 'meeting' : this.mode;
    const app = this.currentApp ? [this.currentApp.app, this.currentApp.label].filter(Boolean).join(' · ') : null;
    return { status, category: this.seg.category, since: iso(this.seg.start), app, project_id: this.projectId };
  }

  // Segments from the server: other computers, earlier runs, adjustment status
  mergeServer(rows) {
    const ownDevice = this.store.get('device_id');
    for (const r of rows) {
      const key = r.client_id || r.id;
      this.serverInfo.set(key, { id: r.id, adjustments: r.adjustments || [] });
      if (localDay(Date.parse(r.start_time)) !== this.day) continue;
      if (this.seg && key === this.seg.client_id) continue;
      const local = this.segments.get(key);
      if (!local || local.source !== 'local') {
        this.segments.set(key, {
          client_id: key, start_time: r.start_time, end_time: r.end_time, status: r.status, category: r.category,
          note: r.note, project_id: r.project_id, activity_pct: r.activity_pct, is_open: r.is_open,
          source: !r.device_id ? 'legacy' : r.device_id === ownDevice ? 'synced' : 'server',
        });
      }
    }
    this.emit('change');
  }

  snapshot() {
    const now = this.now();
    const list = [...this.segments.values()];
    if (this.running && this.seg) list.push(this.record(this.seg, now, true));
    list.sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
    let active = 0, total = 0;
    for (const s of this.slots.values()) { active += s.active; total += s.total; }
    const topApps = [...this.todayApps.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, seconds]) => { const [app, label] = k.split('|'); return { app, label, seconds }; });
    return {
      mode:       this.mode,
      category:   this.seg ? this.seg.category : null,
      since:      this.seg ? iso(this.seg.start) : null,
      projectId:  this.projectId,
      activityPct: total ? Math.round(active / total * 100) : null,
      currentApp: this.currentApp,
      topApps,
      segments: list.map(s => ({ ...s, server: this.serverInfo.get(s.client_id) || null })),
    };
  }
}

module.exports = Tracker;
