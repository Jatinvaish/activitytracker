(() => {
  'use strict';

  const KEY_STORAGE = 'at_admin_key';
  const PAGE_SIZE   = 100;
  const ONLINE_MS   = 4 * 60000;
  const LIVE_MS     = 6 * 60000;
  const VIEWS       = ['dashboard', 'employees', 'sessions', 'adjustments', 'attendance', 'projects', 'settings'];

  const state = {
    key: null,
    users: [],
    projects: [],
    settings: null,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sessionIndex: {},
    adjIndex: {},
    deviceIndex: {},
    shotIndex: {},
    renderSeq: 0,
    daySeq: 0,
    liveTimer: null,
    view: 'dashboard',
    dashDate: ymd(new Date()),
    emp: null,
    empSearch: '',
    sess: { userId: '', from: ymd(addDays(new Date(), -6)), to: ymd(new Date()), status: '', page: 0 },
    adjTab: 'pending',
    att: { month: ymd(new Date()).slice(0, 7) },
    proj: { from: ymd(new Date()).slice(0, 8) + '01', to: ymd(new Date()) },
    attData: null,
  };

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2] || 1); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function dayRange(fromYmd, toYmd) { return { from: parseYmd(fromYmd).toISOString(), to: addDays(parseYmd(toYmd), 1).toISOString() }; }
  function fmtTime(v) { return new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function fmtDay(v) { return new Date(v).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); }
  function fmtDateTime(v) {
    return v ? new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  }
  function fmtDur(mins) {
    mins = Math.max(0, Math.round(mins || 0));
    const h = Math.floor(mins / 60);
    return h ? h + 'h ' + pad(mins % 60) + 'm' : mins + 'm';
  }
  function fmtHours(mins) { return (Math.max(0, mins || 0) / 60).toFixed(2); }
  function pct(part, whole) { return whole > 0 ? Math.round(part / whole * 100) + '%' : '—'; }
  function toInput(v) { const d = new Date(v); return ymd(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fromInput(v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  function groupBy(list, keyFn) { const out = {}; list.forEach(x => { const k = keyFn(x); (out[k] = out[k] || []).push(x); }); return out; }
  function byStart(a, b) { return new Date(a.start_time) - new Date(b.start_time); }
  function nameOf(row) { return (row.users && row.users.name) || userName(row.user_id); }
  function userName(id) { return (state.users.find(u => u.id === id) || {}).name || 'Unknown'; }
  function today() { return ymd(new Date()); }
  function hm(t) { const p = String(t || '0:0').split(':').map(Number); return p[0] * 60 + (p[1] || 0); }
  function relTime(v) {
    if (!v) return 'never';
    const m = Math.round((Date.now() - new Date(v).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' days ago';
  }
  function monthBounds(ym) {
    const first = parseYmd(ym + '-01');
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    return { from: ymd(first), to: ymd(last), days: last.getDate() };
  }

  // Dates and clock times in the server's business timezone (attendance is judged there)
  const tzFmtCache = {};
  function tzParts(v, tz) {
    const f = tzFmtCache[tz] || (tzFmtCache[tz] = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
    return Object.fromEntries(f.formatToParts(new Date(v)).map(p => [p.type, p.value]));
  }
  function tzDate(v, tz) { const p = tzParts(v, tz); return p.year + '-' + p.month + '-' + p.day; }
  function tzMinutes(v, tz) { const p = tzParts(v, tz); return Number(p.hour) * 60 + Number(p.minute); }
  function tzTime(v, tz) { const p = tzParts(v, tz); return p.hour + ':' + p.minute; }

  function loadKey()   { try { return sessionStorage.getItem(KEY_STORAGE); } catch (e) { return null; } }
  function saveKey(k)  { try { sessionStorage.setItem(KEY_STORAGE, k); } catch (e) { /* key stays in memory only */ } }
  function clearKey()  { try { sessionStorage.removeItem(KEY_STORAGE); } catch (e) { /* nothing stored */ } }

  // ── Segments: the same buckets the desktop app uses ─────────────────────────
  const BUCKET = {
    active:  { label: 'Active',  tone: 'green' },
    meeting: { label: 'Meeting', tone: 'blue' },
    idle:    { label: 'Idle',    tone: 'amber' },
    break:   { label: 'Break',   tone: 'purple' },
    away:    { label: 'Away',    tone: 'grey' },
  };
  const LIVE = {
    active:  { label: 'Active',     tone: 'green' },
    idle:    { label: 'Idle',       tone: 'amber' },
    away:    { label: 'Away',       tone: 'grey' },
    break:   { label: 'On break',   tone: 'purple' },
    meeting: { label: 'In meeting', tone: 'blue' },
  };
  const CATEGORY_LABEL = { meeting: 'Meeting', break: 'Break', lunch: 'Lunch', other: 'Other' };

  function bucketOf(s) {
    if (s.category === 'meeting') return 'meeting';
    if (s.category === 'break' || s.category === 'lunch') return 'break';
    if (s.status === 'active') return 'active';
    if (s.status === 'away') return 'away';
    return 'idle';
  }
  function segMins(s) { return Math.max(0, (new Date(s.end_time) - new Date(s.start_time)) / 60000); }
  function isLive(s) { return !!s.is_open && Date.now() - new Date(s.updated_at || s.end_time).getTime() < LIVE_MS; }
  function isStopped(s) { return (!!s.is_open && !isLive(s)) || s.end_reason === 'crash'; }
  function segLabel(s) {
    const b = bucketOf(s);
    if (s.category === 'lunch') return 'Lunch';
    if (s.category === 'other') return BUCKET[b].label + ' · other';
    return BUCKET[b].label;
  }
  function segPill(s) { return '<span class="pill ' + BUCKET[bucketOf(s)].tone + '">' + esc(segLabel(s)) + '</span>'; }
  function segFlags(s) {
    return (isLive(s) ? ' <span class="live-dot" title="In progress right now"></span>' : '') +
      (isStopped(s) ? ' <span class="pill red" title="The tracker stopped without closing this session: the app was closed, crashed or the computer lost power">Stopped</span>' : '');
  }

  function summarize(list) {
    const t = { active: 0, meeting: 0, idle: 0, break: 0, away: 0, first: null, firstAny: null, last: null, count: list.length, actW: 0, actM: 0, live: false, stopped: false };
    list.forEach(s => {
      const m = segMins(s), b = bucketOf(s);
      t[b] += m;
      const st = new Date(s.start_time), en = new Date(s.end_time);
      if ((b === 'active' || b === 'meeting') && (!t.first || st < t.first)) t.first = st;
      if (!t.firstAny || st < t.firstAny) t.firstAny = st;
      if (!t.last || en > t.last) t.last = en;
      if (s.status === 'active' && s.activity_pct != null) { t.actW += s.activity_pct * m; t.actM += m; }
      if (isLive(s)) t.live = true;
      if (isStopped(s)) t.stopped = true;
    });
    t.worked = t.active + t.meeting;
    t.activity = t.actM ? Math.round(t.actW / t.actM) : null;
    if (!t.first) t.first = t.firstAny;
    return t;
  }
  function productivity(t) { return pct(t.worked, t.worked + t.idle); }
  function activityText(v) { return v == null ? '—' : v + '%'; }

  // ── Settings metadata (mirrors SETTINGS_SPEC in backend/db.js) ──────────────
  const SETTINGS_META = [
    { group: 'Tracking', items: [
      { key: 'idle_threshold_mins', label: 'Mark as idle after', type: 'int', min: 1, max: 60, unit: 'min without input' },
      { key: 'prompt_after_idle_mins', label: 'Ask "Where were you?" after being idle for', type: 'int', min: 0, max: 240, unit: 'min (0 = never ask)' },
      { key: 'meeting_detection', label: 'Count calls as work (microphone or camera in use)', type: 'bool' },
      { key: 'app_tracking', label: 'Record apps and websites', type: 'bool' },
    ] },
    { group: 'Work hours', items: [
      { key: 'daily_goal_mins', label: 'Daily goal', type: 'int', min: 30, max: 960, unit: 'min' },
      { key: 'shift_start', label: 'Shift starts', type: 'time' },
      { key: 'shift_end', label: 'Shift ends', type: 'time' },
      { key: 'late_grace_mins', label: 'Late after shift start by more than', type: 'int', min: 0, max: 180, unit: 'min' },
      { key: 'workdays', label: 'Workdays', type: 'days' },
    ] },
    { group: 'Screenshots', items: [
      { key: 'screenshots_enabled', label: 'Take screenshots', type: 'bool' },
      { key: 'screenshot_interval_mins', label: 'One screenshot every', type: 'int', min: 5, max: 60, unit: 'min' },
      { key: 'screenshot_blur', label: 'Blur screenshots', type: 'bool' },
      { key: 'screenshot_retention_days', label: 'Delete screenshots after', type: 'int', min: 1, max: 365, unit: 'days', companyOnly: true },
    ] },
    { group: 'Notifications', items: [
      { key: 'end_of_day_summary', label: 'Send employees an end-of-day summary', type: 'bool' },
    ] },
  ];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function settingText(item, v) {
    if (v == null) return '—';
    if (item.type === 'bool') return v ? 'On' : 'Off';
    if (item.type === 'days') return v.length ? v.map(d => WEEKDAYS[d]).join(', ') : 'None';
    if (item.type === 'int') return v + ' ' + item.unit.split(' (')[0];
    return String(v);
  }

  function settingControl(item, value, name, disabled) {
    const dis = disabled ? ' disabled' : '';
    if (item.type === 'int') {
      return '<span class="num-input"><input class="input" type="number" name="' + name + '" min="' + item.min + '" max="' + item.max +
        '" step="1" value="' + esc(value) + '"' + dis + '><span class="muted small">' + esc(item.unit) + '</span></span>';
    }
    if (item.type === 'bool') {
      return '<label class="switch"><input type="checkbox" name="' + name + '"' + (value ? ' checked' : '') + dis + '><span>' + (value ? 'On' : 'Off') + '</span></label>';
    }
    if (item.type === 'time') return '<input class="input" type="time" name="' + name + '" value="' + esc(value) + '"' + dis + '>';
    return '<span class="day-checks">' + WEEKDAYS.map((d, i) =>
      '<label><input type="checkbox" name="' + name + '" value="' + i + '"' + ((value || []).includes(i) ? ' checked' : '') + dis + '>' + d + '</label>').join('') + '</span>';
  }

  function readSetting(form, item, name) {
    if (item.type === 'days') {
      return [...form.querySelectorAll('input[name="' + name + '"]:checked')].map(el => Number(el.value));
    }
    const el = form.elements.namedItem(name);
    if (item.type === 'bool') return el.checked;
    if (item.type === 'time') {
      if (!/^\d{2}:\d{2}$/.test(el.value)) throw new Error(item.label + ': enter a time');
      return el.value;
    }
    const n = Number(el.value);
    if (!Number.isInteger(n) || n < item.min || n > item.max) throw new Error(item.label + ': enter a whole number from ' + item.min + ' to ' + item.max);
    return n;
  }

  function effectiveSettings(user) {
    const global = (state.settings && state.settings.global) || {};
    const own = Object.fromEntries(Object.entries((user && user.settings) || {}).filter(([, v]) => v !== null));
    return Object.assign({}, global, own);
  }

  // ── API ─────────────────────────────────────────────────────────────────────
  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'x-admin-key': state.key };
    if (opts.body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch('/admin/api' + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    } catch (e) {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !opts.isLogin) {
      signOut('Your admin key was rejected. Sign in again.');
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed (' + res.status + ')');
      err.migration = res.status === 503 && /migrations_\d+\.sql/.test(data.error || '');
      throw err;
    }
    return data;
  }

  function qs(params) {
    const p = new URLSearchParams();
    Object.keys(params).forEach(k => { if (params[k] !== '' && params[k] != null) p.set(k, params[k]); });
    const s = p.toString();
    return s ? '?' + s : '';
  }

  async function fetchAllSessions(params) {
    const all = [];
    for (let offset = 0; offset < 20000; offset += 1000) {
      const r = await api('/sessions' + qs(Object.assign({}, params, { limit: 1000, offset })));
      all.push(...r.sessions);
      if (r.sessions.length < 1000 || all.length >= r.total) break;
    }
    return all;
  }

  async function loadUsers() { state.users = (await api('/users')).users; return state.users; }
  async function loadProjects() { state.projects = (await api('/projects')).projects; return state.projects; }
  async function loadSettings() { state.settings = await api('/settings'); return state.settings; }
  function indexSessions(list) { list.forEach(s => { state.sessionIndex[s.id] = s; }); }
  function indexAdjustments(list) { list.forEach(a => { state.adjIndex[a.id] = a; }); }
  function indexDevices(list) { list.forEach(d => { state.deviceIndex[d.id] = d; }); }
  function projectName(id, row) {
    if (!id) return '';
    if (row && row.projects && row.projects.name) return row.projects.name;
    return (state.projects.find(p => p.id === id) || {}).name || 'Deleted project';
  }

  function setPending(n) {
    const b = $('#pendingBadge');
    b.textContent = n;
    b.hidden = !n;
  }
  function refreshPending() {
    api('/adjustments?status=pending').then(r => setPending(r.adjustments.length)).catch(() => {});
  }

  // ── Building blocks ─────────────────────────────────────────────────────────
  function pageHead(title, sub, controls) {
    return '<div class="page-head"><div><h1>' + esc(title) + '</h1>' + (sub ? '<p class="muted">' + esc(sub) + '</p>' : '') + '</div>' +
      (controls ? '<div class="controls">' + controls + '</div>' : '') + '</div>';
  }
  function kpi(label, value, tone, action) {
    const tag = action ? 'button' : 'div';
    return '<' + tag + ' class="kpi"' + (action ? ' type="button" data-action="' + action + '"' : '') + '>' +
      '<span class="label">' + esc(label) + '</span><span class="value ' + (tone || '') + '">' + esc(value) + '</span></' + tag + '>';
  }
  function legend() {
    return '<div class="legend">' + Object.keys(BUCKET).map(k => '<span><i class="sw ' + k + '"></i>' + BUCKET[k].label + '</span>').join('') +
      '<span><i class="sw stopped"></i>Tracker stopped</span></div>';
  }
  function emptyState(title, text) { return '<div class="empty"><strong>' + esc(title) + '</strong>' + (text ? '<p>' + esc(text) + '</p>' : '') + '</div>'; }
  function field(label, control) { return '<label class="field"><span>' + esc(label) + '</span>' + control + '</label>'; }
  function meta(label, html) { return '<div class="meta"><span class="label">' + esc(label) + '</span><div>' + html + '</div></div>'; }
  const ADJ_TONE = { pending: 'amber', approved: 'green', rejected: 'red', resolved: 'blue' };
  function adjPill(status) { return '<span class="pill ' + (ADJ_TONE[status] || '') + '">' + esc(status) + '</span>'; }
  const DEVICE_TONE = { approved: 'green', pending: 'amber', rejected: 'red', revoked: 'grey' };
  function devicePill(status) { return '<span class="pill ' + (DEVICE_TONE[status] || '') + '">' + esc(status) + '</span>'; }
  function statusSelect(value) {
    return '<select class="input" name="status">' + [['active', 'Active'], ['idle', 'Idle'], ['away', 'Away']]
      .map(([v, l]) => '<option value="' + v + '"' + (value === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>';
  }
  function categorySelect(value) {
    return '<select class="input" name="category"><option value="">None</option>' + Object.keys(CATEGORY_LABEL)
      .map(k => '<option value="' + k + '"' + (value === k ? ' selected' : '') + '>' + CATEGORY_LABEL[k] + '</option>').join('') + '</select>';
  }
  function projectSelect(value) {
    const list = state.projects.filter(p => !p.archived || p.id === value);
    return '<select class="input" name="project_id"><option value="">No project</option>' + list
      .map(p => '<option value="' + esc(p.id) + '"' + (p.id === value ? ' selected' : '') + '>' + esc(p.name + (p.client ? ' · ' + p.client : '')) + '</option>').join('') + '</select>';
  }
  function userOptions(selectedId, excludeId) {
    return state.users.filter(u => u.id !== excludeId)
      .map(u => '<option value="' + esc(u.id) + '"' + (u.id === selectedId ? ' selected' : '') + '>' + esc(u.name) + '</option>').join('');
  }
  function migrationBox(message) {
    return '<div class="notice warn"><h2>Database update needed</h2><p>' + esc(message) + '</p>' +
      '<ol><li>Open your Supabase project and go to <strong>SQL Editor</strong>.</li>' +
      '<li>Paste the contents of <code>backend/migrations_003.sql</code> and click <strong>Run</strong>.</li>' +
      '<li>Come back here and press <strong>Try again</strong>.</li></ol>' +
      '<button type="button" class="btn primary" data-action="refresh">Try again</button></div>';
  }

  // ── Timeline (minutes since local midnight of the session's start day) ─────
  function dayOffsets(s) {
    const st = new Date(s.start_time);
    const midnight = new Date(st.getFullYear(), st.getMonth(), st.getDate());
    return { a: (st - midnight) / 60000, b: Math.min((new Date(s.end_time) - midnight) / 60000, 1440) };
  }
  function windowFor(list) {
    let lo = 9 * 60, hi = 18 * 60;
    list.forEach(s => {
      const o = dayOffsets(s);
      lo = Math.min(lo, Math.floor(o.a / 60) * 60);
      hi = Math.max(hi, Math.ceil(o.b / 60) * 60);
    });
    lo = Math.max(0, lo);
    hi = Math.min(1440, hi);
    const step = hourStep({ lo, hi });
    return { lo, hi: Math.min(1440, lo + Math.ceil((hi - lo) / step) * step) };
  }
  function hourStep(win) { const h = (win.hi - win.lo) / 60; return (h <= 12 ? 1 : h <= 18 ? 2 : 3) * 60; }
  function timelineAxis(win) {
    const step = hourStep(win), span = win.hi - win.lo;
    let out = '';
    for (let m = win.lo; m <= win.hi; m += step) {
      const edge = m === win.lo ? ' class="start"' : m === win.hi ? ' class="end"' : '';
      out += '<span' + edge + ' style="left:' + ((m - win.lo) / span * 100).toFixed(2) + '%">' + pad(Math.floor(m / 60)) + ':00</span>';
    }
    return '<div class="tl-axis">' + out + '</div>';
  }
  function timelineBar(list, win) {
    const step = hourStep(win), span = win.hi - win.lo;
    let grid = '';
    for (let m = win.lo + step; m < win.hi; m += step) grid += '<i style="left:' + ((m - win.lo) / span * 100).toFixed(2) + '%"></i>';
    const segs = list.map(s => {
      const o = dayOffsets(s);
      const a = Math.max(o.a, win.lo), b = Math.min(o.b, win.hi);
      if (b <= a) return '';
      const tip = segLabel(s) + ' ' + fmtTime(s.start_time) + '–' + fmtTime(s.end_time) + ' (' + fmtDur(segMins(s)) + ')' +
        (s.activity_pct != null ? ' · ' + s.activity_pct + '% activity' : '') + (isLive(s) ? ' · in progress' : '') + (isStopped(s) ? ' · tracker stopped' : '');
      const left = (a - win.lo) / span * 100, width = (b - a) / span * 100;
      return '<span class="seg ' + bucketOf(s) + (isLive(s) ? ' live' : '') + '" style="left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) +
        '%" title="' + esc(tip) + '"></span>' +
        (isStopped(s) ? '<span class="seg-flag" style="left:' + (left + width).toFixed(3) + '%" title="Tracker stopped here"></span>' : '');
    }).join('');
    return '<div class="tl">' + grid + segs + '</div>';
  }

  function editButton(s) {
    if (isLive(s)) {
      return '<span title="Still in progress. You can edit it once the session ends."><button type="button" class="btn small" disabled>Edit</button></span>';
    }
    return '<button type="button" class="btn small" data-action="edit-session" data-id="' + esc(s.id) + '">Edit</button>';
  }

  function sessionTable(list, adjBySession, full) {
    if (!list.length) return emptyState('No sessions', full ? 'Nothing matches these filters.' : '');
    return '<div class="table-wrap"><table class="tbl' + (full ? '' : ' inner') + '"><thead><tr>' +
      (full ? '<th>Date</th><th>Employee</th>' : '') +
      '<th>Start</th><th>End</th><th class="num">Duration</th><th>Type</th><th>Project</th><th class="num">Activity</th><th>Adjustment</th><th></th></tr></thead><tbody>' +
      list.map(s => {
        const adjs = adjBySession[s.id] || [];
        return '<tr>' +
          (full ? '<td class="nowrap">' + fmtDay(s.start_time) + '</td><td class="strong"><a href="#employee/' + esc(s.user_id) + '">' + esc(nameOf(s)) + '</a></td>' : '') +
          '<td>' + fmtTime(s.start_time) + '</td><td class="nowrap">' + fmtTime(s.end_time) + segFlags(s) + '</td>' +
          '<td class="num">' + fmtDur(segMins(s)) + '</td><td class="nowrap">' + segPill(s) + '</td>' +
          '<td class="muted">' + esc(projectName(s.project_id, s)) + '</td>' +
          '<td class="num">' + activityText(s.activity_pct) + '</td>' +
          '<td>' + (adjs.length
            ? adjs.map(a => '<button type="button" class="pill-btn" data-action="review-adj" data-id="' + esc(a.id) + '">' + adjPill(a.status) + '</button>').join(' ')
            : '<span class="muted">—</span>') + '</td>' +
          '<td class="actions">' + editButton(s) +
          '<button type="button" class="btn small danger-ghost" data-action="delete-session" data-id="' + esc(s.id) + '">Delete</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function adjustmentTable(list, showEmployee) {
    if (!list.length) return emptyState('No requests here', '');
    return '<div class="table-wrap"><table class="tbl"><thead><tr><th>Requested</th>' + (showEmployee ? '<th>Employee</th>' : '') +
      '<th>Session</th><th>Request</th><th>Owner notes</th><th>Status</th><th></th></tr></thead><tbody>' +
      list.map(a => {
        const s = a.sessions;
        return '<tr>' +
          '<td class="nowrap">' + fmtDateTime(a.created_at) + '</td>' +
          (showEmployee ? '<td class="strong"><a href="#employee/' + esc(a.user_id) + '">' + esc(nameOf(a)) + '</a></td>' : '') +
          '<td class="nowrap">' + (s
            ? fmtDay(s.start_time) + '<br><span class="muted">' + fmtTime(s.start_time) + '–' + fmtTime(s.end_time) + ' · ' + fmtDur(segMins(s)) + '</span> ' + segPill(s)
            : '<span class="muted">Not linked</span>') + '</td>' +
          '<td class="note">' + esc(a.note) + '</td>' +
          '<td class="note muted">' + esc(a.owner_notes || '') + '</td>' +
          '<td class="nowrap">' + adjPill(a.status) + (a.resolved_at ? '<div class="muted small">' + fmtDateTime(a.resolved_at) + '</div>' : '') + '</td>' +
          '<td class="actions"><button type="button" class="btn small' + (a.status === 'pending' ? ' primary' : '') + '" data-action="review-adj" data-id="' + esc(a.id) + '">Review</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ── Live panel ──────────────────────────────────────────────────────────────
  function isOnline(d) { return !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < ONLINE_MS; }

  function livePill(d) {
    if (!isOnline(d)) return '<span class="pill grey">Offline</span>';
    const l = LIVE[d.live_status] || { label: 'Online', tone: 'green' };
    return '<span class="pill ' + l.tone + '"><span class="live-dot"></span>' + esc(l.label) + '</span>';
  }

  function livePanel(devices) {
    const list = devices.filter(d => d.status === 'approved')
      .sort((a, b) => isOnline(b) - isOnline(a) || nameOf(a).localeCompare(nameOf(b)));
    if (!list.length) return emptyState('No computers connected yet', 'Computers appear here once they run the latest desktop app.');
    const online = list.filter(isOnline).length;
    return '<div class="live-summary muted small">' + online + ' of ' + list.length + ' computers online · refreshes every 30 seconds</div>' +
      '<div class="live-grid">' + list.map(d => {
        const on = isOnline(d);
        const since = on && d.live_since ? 'since ' + fmtTime(d.live_since) + ' · ' + fmtDur((Date.now() - new Date(d.live_since)) / 60000) : 'last seen ' + relTime(d.last_seen_at);
        return '<a class="live-card' + (on ? '' : ' off') + '" href="#employee/' + esc(d.user_id) + '">' +
          '<div class="live-top"><span class="strong">' + esc(nameOf(d)) + '</span>' + livePill(d) + '</div>' +
          '<div class="muted small">' + esc(since) + '</div>' +
          (on && d.live_app ? '<div class="small live-app" title="' + esc(d.live_app) + '">' + esc(d.live_app) + '</div>' : '') +
          '<div class="muted small">' + esc([on && d.live_project_id ? projectName(d.live_project_id) : '', d.hostname || ''].filter(Boolean).join(' · ')) + '</div>' +
        '</a>';
      }).join('') + '</div>';
  }

  function pendingBanner(devices) {
    const pending = devices.filter(d => d.status === 'pending');
    if (!pending.length) return '';
    return '<div class="banner"><strong>' + pending.length + (pending.length === 1 ? ' computer is' : ' computers are') + ' waiting for your approval.</strong> ' +
      pending.map(d => '<a href="#employee/' + esc(d.user_id) + '">' + esc(nameOf(d)) + (d.hostname ? ' on ' + esc(d.hostname) : '') + '</a>').join(', ') +
      '. Their time is recorded on the computer and uploads once you approve.</div>';
  }

  function stopLivePolling() {
    if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
  }

  function startLivePolling() {
    stopLivePolling();
    state.liveTimer = setInterval(async () => {
      if (state.view !== 'dashboard' || !state.key) return stopLivePolling();
      try {
        const { devices } = await api('/devices');
        const panel = $('#livePanel');
        if (panel && state.view === 'dashboard') panel.innerHTML = livePanel(devices);
      } catch (e) { /* the next tick retries */ }
    }, 30000);
  }

  // ── Views ───────────────────────────────────────────────────────────────────
  async function renderDashboard(stale) {
    const isToday = state.dashDate === today();
    const [users, sessions, pend, dev] = await Promise.all([
      loadUsers(),
      fetchAllSessions(dayRange(state.dashDate, state.dashDate)),
      api('/adjustments?status=pending'),
      api('/devices'),
      loadProjects(),
    ]);
    if (stale()) return;
    setPending(pend.adjustments.length);

    const byUser = groupBy(sessions, s => s.user_id);
    const rows = users.map(u => {
      const list = (byUser[u.id] || []).sort(byStart);
      return { user: u, list, sum: summarize(list) };
    }).sort((a, b) => (b.sum.count > 0) - (a.sum.count > 0) || b.sum.worked - a.sum.worked || a.user.name.localeCompare(b.user.name));
    const win = windowFor(sessions);
    const all = summarize(sessions);
    const present = rows.filter(r => r.sum.worked > 0).length;

    setView(
      pageHead('Team overview', fmtDay(parseYmd(state.dashDate)) + (isToday ? ' · Today' : ''),
        '<button type="button" class="btn icon" data-action="dash-shift" data-days="-1" aria-label="Previous day">‹</button>' +
        '<input type="date" class="input" data-change="dash-date" value="' + state.dashDate + '" max="' + today() + '" aria-label="Date">' +
        '<button type="button" class="btn icon" data-action="dash-shift" data-days="1" aria-label="Next day"' + (isToday ? ' disabled' : '') + '>›</button>' +
        (isToday ? '' : '<button type="button" class="btn" data-action="dash-today">Today</button>') +
        '<button type="button" class="btn" data-action="refresh">Refresh</button>') +
      pendingBanner(dev.devices) +
      '<section class="card"><div class="card-head"><h2>Live now</h2></div><div class="card-body" id="livePanel">' + livePanel(dev.devices) + '</div></section>' +
      '<div class="kpis">' +
        kpi('Present', present + ' / ' + users.length) +
        kpi('Worked', fmtDur(all.worked), 'green') +
        kpi('In meetings', fmtDur(all.meeting), 'blue') +
        kpi('Idle', fmtDur(all.idle), 'amber') +
        kpi('Breaks', fmtDur(all.break), 'purple') +
        kpi('Away', fmtDur(all.away)) +
        kpi('Productivity', productivity(all)) +
        kpi('Pending requests', String(pend.adjustments.length), pend.adjustments.length ? 'amber' : '', 'goto-adjustments') +
      '</div>' +
      '<section class="card"><div class="card-head"><h2>Daily timeline</h2>' + legend() + '</div>' +
      (users.length
        ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>Employee</th><th>First in</th><th>Last out</th>' +
          '<th class="num">Worked</th><th class="num">Idle</th><th class="num">Break</th><th class="num">Productivity</th><th class="num">Activity</th><th class="tl-col">' + timelineAxis(win) + '</th></tr></thead><tbody>' +
          rows.map(r =>
            '<tr class="clickable' + (r.sum.count ? '' : ' dim') + '" data-action="open-emp" data-id="' + esc(r.user.id) + '">' +
              '<td class="strong nowrap">' + esc(r.user.name) + (r.sum.live ? ' <span class="live-dot" title="Working right now"></span>' : '') +
                (r.sum.stopped ? ' <span class="pill red" title="The tracker stopped without closing a session">Stopped</span>' : '') + '</td>' +
              '<td>' + (r.sum.first ? fmtTime(r.sum.first) : '—') + '</td>' +
              '<td>' + (r.sum.last ? (r.sum.live ? 'now' : fmtTime(r.sum.last)) : '—') + '</td>' +
              '<td class="num green">' + (r.sum.count ? fmtDur(r.sum.worked) : '—') + '</td>' +
              '<td class="num amber">' + (r.sum.count ? fmtDur(r.sum.idle) : '—') + '</td>' +
              '<td class="num purple">' + (r.sum.count ? fmtDur(r.sum.break) : '—') + '</td>' +
              '<td class="num">' + productivity(r.sum) + '</td>' +
              '<td class="num">' + activityText(r.sum.activity) + '</td>' +
              '<td class="tl-col">' + (r.sum.count ? timelineBar(r.list, win) : '<span class="small">No activity</span>') + '</td>' +
            '</tr>').join('') +
          '</tbody></table></div>'
        : emptyState('No employees yet', 'Employees appear here after the desktop app logs their first session.')) +
      '<div class="card-foot">The latest desktop app updates the session in progress every 2 minutes, so this view is at most a couple of minutes behind.</div>' +
      '</section>'
    );
    startLivePolling();
  }

  async function renderEmployees(stale) {
    const users = await loadUsers();
    if (stale()) return;
    setView(
      pageHead('Employees', users.length + (users.length === 1 ? ' person tracked' : ' people tracked'),
        '<input type="search" class="input" placeholder="Search by name" data-input="emp-search" value="' + esc(state.empSearch) + '" aria-label="Search employees">' +
        '<button type="button" class="btn" data-action="refresh">Refresh</button>') +
      '<section class="card">' +
      (users.length
        ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>First seen</th><th>Last activity</th><th class="num">Sessions</th><th>Computers</th><th></th></tr></thead><tbody>' +
          users.map(u =>
            '<tr class="clickable" data-action="open-emp" data-id="' + esc(u.id) + '" data-name="' + esc(u.name.toLowerCase()) + '">' +
              '<td class="strong">' + esc(u.name) + '</td><td>' + fmtDateTime(u.created_at) + '</td><td>' + fmtDateTime(u.last_seen) + '</td>' +
              '<td class="num">' + u.total_sessions + '</td>' +
              '<td class="nowrap">' + (u.devices || 0) + (u.pending_devices ? ' <span class="pill amber">' + u.pending_devices + ' to approve</span>' : '') + '</td>' +
              '<td class="actions"><button type="button" class="btn small" data-action="open-emp" data-id="' + esc(u.id) + '">View</button>' +
              '<button type="button" class="btn small danger-ghost" data-action="delete-emp" data-id="' + esc(u.id) + '">Delete</button></td>' +
            '</tr>').join('') +
          '</tbody></table></div>'
        : emptyState('No employees yet', 'Employees appear here after the desktop app logs their first session.')) +
      '</section>'
    );
    applyEmpSearch();
  }

  function applyEmpSearch() {
    const q = state.empSearch.trim().toLowerCase();
    document.querySelectorAll('#view tr[data-name]').forEach(tr => { tr.hidden = !!q && !tr.dataset.name.includes(q); });
  }

  // Longest matching pattern wins, so "google docs" beats "google"
  function categorize(app, label, categories) {
    const hay = (app + ' ' + (label || '')).toLowerCase();
    let best = null;
    categories.forEach(c => { if (hay.includes(c.pattern) && (!best || c.pattern.length > best.pattern.length)) best = c; });
    return best ? best.category : 'neutral';
  }
  const APP_TONE = { productive: 'green', neutral: 'grey', unproductive: 'red' };

  function appsCard(usage, categories) {
    const map = new Map();
    usage.forEach(u => {
      const key = u.app + '|' + (u.label || '');
      const row = map.get(key) || { app: u.app, label: u.label || '', seconds: 0 };
      row.seconds += u.seconds;
      map.set(key, row);
    });
    const rows = [...map.values()].sort((a, b) => b.seconds - a.seconds);
    if (!rows.length) return emptyState('No app data in this range', 'App tracking may be turned off, or this computer runs an older app version.');
    const totals = { productive: 0, neutral: 0, unproductive: 0 };
    rows.forEach(r => { r.category = categorize(r.app, r.label, categories); totals[r.category] += r.seconds; });
    const total = totals.productive + totals.neutral + totals.unproductive;
    const max = rows[0].seconds;
    return '<div class="app-summary">' +
      ['productive', 'neutral', 'unproductive'].map(c =>
        '<div><span class="pill ' + APP_TONE[c] + '">' + c + '</span> <strong>' + fmtDur(totals[c] / 60) + '</strong> <span class="muted small">' + pct(totals[c], total) + '</span></div>').join('') +
      '<div class="muted small">Productive by apps: <strong>' + pct(totals.productive, total) + '</strong></div></div>' +
      '<div class="app-list">' + rows.slice(0, 20).map(r =>
        '<div class="app-row" title="' + esc(r.app + (r.label ? ' — ' + r.label : '')) + '">' +
          '<div class="app-name"><span class="strong">' + esc(r.label || r.app) + '</span>' + (r.label ? ' <span class="muted small">' + esc(r.app) + '</span>' : '') + '</div>' +
          '<div class="app-bar"><i class="' + APP_TONE[r.category] + '" style="width:' + (r.seconds / max * 100).toFixed(1) + '%"></i></div>' +
          '<div class="num small">' + fmtDur(r.seconds / 60) + '</div>' +
          '<span class="pill ' + APP_TONE[r.category] + '">' + r.category + '</span>' +
        '</div>').join('') + '</div>' +
      (rows.length > 20 ? '<div class="card-foot">Showing the top 20 of ' + rows.length + '. Change categories under Settings.</div>' : '<div class="card-foot">Change categories under Settings.</div>');
  }

  function projectsTimeTable(rows, showEmployee) {
    if (!rows.length) return emptyState('No project time in this range', 'Employees pick a project from the desktop app’s tray menu.');
    const total = rows.reduce((a, r) => a + r.worked_mins, 0);
    return '<div class="table-wrap"><table class="tbl"><thead><tr><th>Project</th>' + (showEmployee ? '<th>Employee</th>' : '') +
      '<th class="num">Worked</th><th class="num">Share</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td class="strong">' + esc(projectName(r.project_id)) + '</td>' + (showEmployee ? '<td>' + esc(userName(r.user_id)) + '</td>' : '') +
        '<td class="num">' + fmtDur(r.worked_mins) + '</td><td class="num">' + pct(r.worked_mins, total) + '</td></tr>').join('') +
      '</tbody></table></div>';
  }

  function devicesTable(devices) {
    if (!devices.length) return emptyState('No computers yet', 'A computer appears here when it runs the latest desktop app.');
    return '<div class="table-wrap"><table class="tbl"><thead><tr><th>Computer</th><th>Status</th><th>App</th><th>Consent</th><th>Last seen</th><th></th></tr></thead><tbody>' +
      devices.map(d => {
        const id = esc(d.id);
        const btns = [];
        if (d.status !== 'approved') btns.push('<button type="button" class="btn small primary" data-action="device-status" data-id="' + id + '" data-status="approved">Approve</button>');
        if (d.status === 'pending') btns.push('<button type="button" class="btn small" data-action="device-status" data-id="' + id + '" data-status="rejected">Reject</button>');
        if (d.status === 'approved') btns.push('<button type="button" class="btn small" data-action="device-status" data-id="' + id + '" data-status="revoked">Revoke</button>');
        btns.push('<button type="button" class="btn small" data-action="device-move" data-id="' + id + '">Move</button>');
        if (d.status === 'pending' || d.status === 'rejected') btns.push('<button type="button" class="btn small danger-ghost" data-action="device-delete" data-id="' + id + '">Delete</button>');
        return '<tr><td><span class="strong">' + esc(d.hostname || 'Unknown computer') + '</span><div class="muted small">' + esc(d.platform || '') + ' · added ' + fmtDateTime(d.created_at) + '</div></td>' +
          '<td class="nowrap">' + devicePill(d.status) + ' ' + (d.status === 'approved' ? livePill(d) : '') + '</td>' +
          '<td>' + esc(d.app_version || '—') + '</td>' +
          '<td class="nowrap">' + (d.consent_at ? 'v' + esc(d.consent_version) + ' · ' + fmtDateTime(d.consent_at) : '<span class="muted">—</span>') + '</td>' +
          '<td class="nowrap">' + (d.last_seen_at ? relTime(d.last_seen_at) : 'never') + '</td>' +
          '<td class="actions">' + btns.join('') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  async function renderEmployee(stale) {
    const e = state.emp;
    if (e.from > e.to) { const t = e.from; e.from = e.to; e.to = t; }
    const range = dayRange(e.from, e.to);
    const [users, sessions, adjRes, summary, devRes, apps] = await Promise.all([
      loadUsers(),
      fetchAllSessions(Object.assign({ user_id: e.id }, range)),
      api('/adjustments' + qs({ user_id: e.id })),
      api('/summary' + qs({ user_id: e.id, from: e.from, to: e.to })),
      api('/devices' + qs({ user_id: e.id })),
      api('/apps' + qs({ user_id: e.id, from: range.from, to: range.to })),
      loadProjects(),
      loadSettings(),
    ]);
    if (stale()) return;
    const user = users.find(u => u.id === e.id);
    if (!user) {
      setView('<a href="#employees" class="back">← All employees</a>' + emptyState('Employee not found', 'They may have been deleted.'));
      return;
    }
    state.tz = summary.timezone || state.tz;
    indexSessions(sessions);
    indexAdjustments(adjRes.adjustments);
    indexDevices(devRes.devices);
    const adjBySession = groupBy(adjRes.adjustments.filter(a => a.session_id), a => a.session_id);
    const byDay = groupBy(sessions, s => tzDate(s.start_time, state.tz));
    const daysSum = Object.fromEntries(summary.days.map(d => [d.date, d]));
    const days = [...new Set([...Object.keys(byDay), ...Object.keys(daysSum)])].sort().reverse();
    const win = windowFor(sessions);
    const tot = summary.days.reduce((t, d) => {
      t.worked += d.worked_mins; t.idle += d.idle_mins; t.break += d.break_mins; t.away += d.away_mins;
      if (d.activity_pct != null) { t.actW += d.activity_pct * d.active_mins; t.actM += d.active_mins; }
      return t;
    }, { worked: 0, idle: 0, break: 0, away: 0, actW: 0, actM: 0 });
    const workedDays = summary.days.filter(d => d.worked_mins > 0).length;
    const pendingCount = adjRes.adjustments.filter(a => a.status === 'pending').length;
    const overrides = Object.keys(user.settings || {}).length;
    const projRows = summary.projects.filter(p => p.user_id === user.id).sort((a, b) => b.worked_mins - a.worked_mins);
    if (!e.day || e.day < e.from || e.day > e.to) e.day = days.find(d => daysSum[d] && daysSum[d].worked_mins > 0) || (e.to < today() ? e.to : today());

    setView(
      '<a href="#employees" class="back">← All employees</a>' +
      pageHead(user.name, 'First seen ' + fmtDateTime(user.created_at) + ' · Last activity ' + fmtDateTime(user.last_seen) + ' · ' + user.total_sessions + ' sessions in total',
        '<button type="button" class="btn primary" data-action="add-session" data-user="' + esc(user.id) + '">+ Add session</button>' +
        '<button type="button" class="btn" data-action="emp-settings">Settings' + (overrides ? ' <span class="count">' + overrides + '</span>' : '') + '</button>' +
        '<button type="button" class="btn" data-action="emp-rename">Rename</button>' +
        '<button type="button" class="btn" data-action="emp-merge">Merge</button>' +
        '<button type="button" class="btn danger-ghost" data-action="delete-emp" data-id="' + esc(user.id) + '">Delete</button>') +
      pendingBanner(devRes.devices) +
      '<div class="toolbar">' +
        '<label>From <input type="date" class="input" data-change="emp-from" value="' + e.from + '" max="' + today() + '"></label>' +
        '<label>To <input type="date" class="input" data-change="emp-to" value="' + e.to + '" max="' + today() + '"></label>' +
        [['Today', 1], ['7 days', 7], ['30 days', 30], ['90 days', 90]]
          .map(([l, n]) => '<button type="button" class="btn small" data-action="emp-range" data-days="' + n + '">' + l + '</button>').join('') +
      '</div>' +
      '<div class="kpis">' +
        kpi('Days worked', String(workedDays)) +
        kpi('Worked', fmtDur(tot.worked), 'green') +
        kpi('Idle', fmtDur(tot.idle), 'amber') +
        kpi('Breaks', fmtDur(tot.break), 'purple') +
        kpi('Avg worked per day', workedDays ? fmtDur(tot.worked / workedDays) : '—') +
        kpi('Productivity', pct(tot.worked, tot.worked + tot.idle)) +
        kpi('Activity', tot.actM ? Math.round(tot.actW / tot.actM) + '%' : '—') +
      '</div>' +
      '<section class="card"><div class="card-head"><h2>Daily log</h2>' + legend() + '</div>' +
      (days.length
        ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>First in</th><th>Last out</th><th class="num">Worked</th><th class="num">Idle</th>' +
          '<th class="num">Break</th><th class="num">Activity</th><th class="num">Sessions</th><th class="tl-col">' + timelineAxis(win) + '</th></tr></thead><tbody>' +
          days.map(d => {
            const list = (byDay[d] || []).sort(byStart);
            const s = daysSum[d] || { worked_mins: 0, idle_mins: 0, break_mins: 0, activity_pct: null, sessions: list.length, first_in: null, last_out: null };
            const local = summarize(list);
            const open = e.open.has(d);
            return '<tr class="clickable day-row' + (open ? ' open' : '') + '" data-action="toggle-day" data-day="' + d + '">' +
                '<td class="strong nowrap"><span class="caret">▸</span>' + fmtDay(parseYmd(d)) +
                  (s.live || local.live ? ' <span class="live-dot" title="Working right now"></span>' : '') +
                  (s.stale || local.stopped ? ' <span class="pill red" title="The tracker stopped without closing a session">Stopped</span>' : '') + '</td>' +
                '<td>' + (s.first_in ? tzTime(s.first_in, state.tz) : '—') + '</td><td>' + (s.last_out ? tzTime(s.last_out, state.tz) : '—') + '</td>' +
                '<td class="num green">' + fmtDur(s.worked_mins) + '</td><td class="num amber">' + fmtDur(s.idle_mins) + '</td>' +
                '<td class="num purple">' + fmtDur(s.break_mins) + '</td><td class="num">' + activityText(s.activity_pct) + '</td>' +
                '<td class="num">' + s.sessions + '</td><td class="tl-col">' + timelineBar(list, win) + '</td></tr>' +
              '<tr class="day-detail" data-detail="' + d + '"' + (open ? '' : ' hidden') + '><td colspan="9">' +
                sessionTable(list, adjBySession, false) + '</td></tr>';
          }).join('') +
          '</tbody></table></div>'
        : emptyState('No activity in this range', 'Pick a wider date range.')) +
      '</section>' +
      '<section class="card"><div class="card-head"><h2>Day detail</h2><div class="controls">' +
        '<input type="date" class="input" data-change="emp-day" value="' + e.day + '" min="' + e.from + '" max="' + e.to + '" aria-label="Day">' +
      '</div></div><div id="dayDetail" class="card-body"><div class="loading small"><span class="spinner"></span>Loading…</div></div></section>' +
      '<div class="two-col">' +
        '<section class="card"><div class="card-head"><h2>Apps &amp; websites</h2><span class="muted small">' + esc(fmtDay(parseYmd(e.from)) + ' – ' + fmtDay(parseYmd(e.to))) + '</span></div>' +
          '<div class="card-body">' + appsCard(apps.usage, apps.categories) + '</div></section>' +
        '<section class="card"><div class="card-head"><h2>Time per project</h2></div>' + projectsTimeTable(projRows, false) + '</section>' +
      '</div>' +
      '<section class="card"><div class="card-head"><h2>Computers</h2></div>' + devicesTable(devRes.devices) + '</section>' +
      '<section class="card"><div class="card-head"><h2>Adjustment requests</h2>' +
        (pendingCount ? '<span class="pill amber">' + pendingCount + ' pending</span>' : '') + '</div>' +
        adjustmentTable(adjRes.adjustments, false) +
      '</section>'
    );
    loadDayDetail();
  }

  async function loadDayDetail() {
    const e = state.emp;
    const box = $('#dayDetail');
    if (!e || !box) return;
    const seq = ++state.daySeq;
    box.innerHTML = '<div class="loading small"><span class="spinner"></span>Loading…</div>';
    const range = dayRange(e.day, e.day);
    try {
      const [act, shots] = await Promise.all([
        api('/activity' + qs({ user_id: e.id, from: range.from, to: range.to })),
        api('/screenshots' + qs({ user_id: e.id, from: range.from, to: range.to })),
      ]);
      if (seq !== state.daySeq || !$('#dayDetail')) return;
      $('#dayDetail').innerHTML =
        '<h3>Activity level per 10 minutes</h3>' + activityBars(act.slots) +
        '<h3>Screenshots</h3>' + screenshotGrid(shots.screenshots);
    } catch (err) {
      if (seq !== state.daySeq || !$('#dayDetail')) return;
      $('#dayDetail').innerHTML = err.migration ? migrationBox(err.message) : '<div class="error-box"><span>' + esc(err.message) + '</span></div>';
    }
  }

  function activityBars(slots) {
    if (!slots.length) return emptyState('No activity data for this day', 'Activity is recorded by the latest desktop app while the employee is active.');
    const merged = new Map();
    slots.forEach(s => {
      const k = new Date(s.slot_start).getTime();
      const m = merged.get(k) || { start: k, active: 0, total: 0 };
      m.active += s.active_secs; m.total += s.total_secs;
      merged.set(k, m);
    });
    const list = [...merged.values()].sort((a, b) => a.start - b.start);
    const first = list[0].start, last = list[list.length - 1].start;
    const bars = [];
    let actSum = 0, totSum = 0;
    for (let t = first; t <= last; t += 600000) {
      const m = merged.get(t);
      if (!m || !m.total) { bars.push('<i class="empty" title="' + fmtTime(t) + ' · no tracked time"></i>'); continue; }
      const p = Math.round(m.active / m.total * 100);
      actSum += m.active; totSum += m.total;
      const tone = p >= 60 ? 'high' : p >= 30 ? 'mid' : 'low';
      bars.push('<i class="' + tone + '" style="height:' + Math.max(4, p) + '%" title="' + fmtTime(t) + '–' + fmtTime(t + 600000) + ' · ' + p +
        '% active (' + fmtDur(m.active / 60) + ' of ' + fmtDur(m.total / 60) + ')"></i>');
    }
    return '<div class="act-head muted small">' + fmtTime(first) + ' – ' + fmtTime(last + 600000) + ' · average <strong>' + pct(actSum, totSum) + '</strong></div>' +
      '<div class="act-bars">' + bars.join('') + '</div>';
  }

  function screenshotGrid(shots) {
    if (!shots.length) return emptyState('No screenshots for this day', 'Turn screenshots on under Settings or in this employee’s settings.');
    shots.forEach(s => { state.shotIndex[s.id] = s; });
    return '<div class="shot-grid">' + shots.map(s =>
      '<button type="button" class="shot" data-action="open-shot" data-id="' + esc(s.id) + '">' +
        (s.url ? '<img src="' + esc(s.url) + '" alt="Screenshot at ' + fmtTime(s.taken_at) + '" loading="lazy">' : '<span class="shot-missing">Image unavailable</span>') +
        '<span class="shot-meta"><span>' + fmtTime(s.taken_at) + (s.display ? ' · screen ' + (s.display + 1) : '') + '</span>' +
        '<span>' + (s.activity_pct != null ? s.activity_pct + '%' : '') + (s.blurred ? ' <span class="pill grey">blurred</span>' : '') + '</span></span>' +
        (s.app ? '<span class="shot-app">' + esc(s.app) + '</span>' : '') +
      '</button>').join('') + '</div>';
  }

  async function renderSessions(stale) {
    const f = state.sess;
    if (f.from > f.to) { const t = f.from; f.from = f.to; f.to = t; }
    const range = dayRange(f.from, f.to);
    const [users, res, adjRes] = await Promise.all([
      loadUsers(),
      api('/sessions' + qs({ user_id: f.userId, status: f.status, from: range.from, to: range.to, limit: PAGE_SIZE, offset: f.page * PAGE_SIZE })),
      api('/adjustments'),
      loadProjects(),
    ]);
    if (stale()) return;
    indexSessions(res.sessions);
    indexAdjustments(adjRes.adjustments);
    const adjBySession = groupBy(adjRes.adjustments.filter(a => a.session_id), a => a.session_id);
    const first = res.total ? f.page * PAGE_SIZE + 1 : 0;
    const last = f.page * PAGE_SIZE + res.sessions.length;

    setView(
      pageHead('Sessions', res.total + (res.total === 1 ? ' session matches' : ' sessions match'),
        '<button type="button" class="btn" data-action="export-csv">Export CSV</button>' +
        '<button type="button" class="btn primary" data-action="add-session">+ Add session</button>') +
      '<div class="toolbar">' +
        '<label>Employee <select class="input" name="userId" data-change="sess-filter"><option value="">All employees</option>' + userOptions(f.userId) + '</select></label>' +
        '<label>From <input type="date" class="input" name="from" data-change="sess-filter" value="' + f.from + '" max="' + today() + '"></label>' +
        '<label>To <input type="date" class="input" name="to" data-change="sess-filter" value="' + f.to + '" max="' + today() + '"></label>' +
        '<label>Status <select class="input" name="status" data-change="sess-filter">' +
          [['', 'All'], ['active', 'Active'], ['idle', 'Idle'], ['away', 'Away']].map(([v, l]) => '<option value="' + v + '"' + (v === f.status ? ' selected' : '') + '>' + l + '</option>').join('') +
        '</select></label>' +
      '</div>' +
      '<section class="card">' + sessionTable(res.sessions, adjBySession, true) +
        (res.total > PAGE_SIZE
          ? '<div class="pager"><span class="muted">Showing ' + first + '–' + last + ' of ' + res.total + '</span>' +
            '<button type="button" class="btn small" data-action="sess-page" data-dir="-1"' + (f.page === 0 ? ' disabled' : '') + '>‹ Prev</button>' +
            '<button type="button" class="btn small" data-action="sess-page" data-dir="1"' + (last >= res.total ? ' disabled' : '') + '>Next ›</button></div>'
          : '') +
      '</section>'
    );
  }

  async function renderAdjustments(stale) {
    const res = await api('/adjustments');
    if (stale()) return;
    const all = res.adjustments;
    indexAdjustments(all);
    const counts = { pending: 0, approved: 0, rejected: 0 };
    all.forEach(a => { if (a.status in counts) counts[a.status]++; });
    setPending(counts.pending);
    const list = state.adjTab === 'all' ? all : all.filter(a => a.status === state.adjTab);

    setView(
      pageHead('Adjustment requests', 'Employees send these from the desktop app. Approve to apply a correction, or reject with a note.',
        '<button type="button" class="btn" data-action="refresh">Refresh</button>') +
      '<div class="tabs">' +
        [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']].map(([k, l]) =>
          '<button type="button" class="tab' + (state.adjTab === k ? ' active' : '') + '" data-action="adj-tab" data-tab="' + k + '">' + l +
          ' <span class="count">' + (k === 'all' ? all.length : counts[k]) + '</span></button>').join('') +
      '</div>' +
      '<section class="card">' + adjustmentTable(list, true) + '</section>'
    );
  }

  // ── Attendance ──────────────────────────────────────────────────────────────
  const ATT_KIND = {
    present: { label: 'Present', cls: 'present' }, late: { label: 'Late', cls: 'late' }, half: { label: 'Half day', cls: 'half' },
    absent: { label: 'Absent', cls: 'absent' }, leave: { label: 'Leave', cls: 'leave' }, sick: { label: 'Sick leave', cls: 'leave' },
    wfh: { label: 'Work from home', cls: 'present' }, holiday: { label: 'Holiday', cls: 'holiday' }, weekend: { label: 'Weekend', cls: 'weekend' },
    upcoming: { label: '', cls: 'future' }, none: { label: 'Before first tracked day', cls: 'weekend' },
  };

  function attendanceDay(day, sum, leave, holiday, eff, tz, joinDate) {
    const workday = (eff.workdays || []).includes(parseYmd(day).getDay());
    const worked = sum ? sum.worked_mins : 0;
    const out = { worked, overtime: 0, late: false };
    if (worked > 0) out.overtime = workday ? Math.max(0, worked - eff.daily_goal_mins) : worked;
    if (holiday) return Object.assign(out, { kind: 'holiday', code: 'Ho' });
    if (leave && leave.type === 'half_day') return Object.assign(out, { kind: 'half', code: 'H' });
    if (leave && (leave.type === 'leave' || leave.type === 'sick')) return Object.assign(out, { kind: leave.type, code: leave.type === 'sick' ? 'SL' : 'LV' });
    if (worked > 0) {
      out.late = workday && !!sum.first_in && tzMinutes(sum.first_in, tz) > hm(eff.shift_start) + eff.late_grace_mins;
      if (workday && day < today() && worked < eff.daily_goal_mins * 0.5) return Object.assign(out, { kind: 'half', code: 'H' });
      if (out.late) return Object.assign(out, { kind: 'late', code: 'L' });
      return Object.assign(out, { kind: leave && leave.type === 'wfh' ? 'wfh' : 'present', code: leave && leave.type === 'wfh' ? 'W' : 'P' });
    }
    if (leave && leave.type === 'wfh') return Object.assign(out, { kind: 'wfh', code: 'W' });
    if (joinDate && day < joinDate) return Object.assign(out, { kind: 'none', code: '' });
    if (!workday) return Object.assign(out, { kind: 'weekend', code: '' });
    if (day >= today()) return Object.assign(out, { kind: 'upcoming', code: '' });
    return Object.assign(out, { kind: 'absent', code: 'A' });
  }

  function buildAttendance(users, summary, leavesRes, month) {
    const { from, days } = monthBounds(month);
    const tz = summary.timezone || state.tz;
    const sumMap = Object.fromEntries(summary.days.map(d => [d.user_id + '|' + d.date, d]));
    const leaveMap = Object.fromEntries(leavesRes.leaves.map(l => [l.user_id + '|' + l.date, l]));
    const holMap = Object.fromEntries(leavesRes.holidays.map(h => [h.date, h]));
    const dates = Array.from({ length: days }, (_, i) => ymd(addDays(parseYmd(from), i)));
    const rows = users.map(u => {
      const eff = effectiveSettings(u);
      const joinDate = u.created_at ? tzDate(u.created_at, tz) : null;
      const cells = dates.map(d => {
        const sum = sumMap[u.id + '|' + d], leave = leaveMap[u.id + '|' + d];
        return Object.assign(attendanceDay(d, sum, leave, holMap[d], eff, tz, joinDate), { date: d, sum, leave, holiday: holMap[d] });
      });
      const t = { present: 0, late: 0, half: 0, absent: 0, leave: 0, worked: 0, overtime: 0 };
      cells.forEach(c => {
        if (c.kind === 'present' || c.kind === 'late' || c.kind === 'wfh') t.present++;
        if (c.late) t.late++;
        if (c.kind === 'half') t.half++;
        if (c.kind === 'absent') t.absent++;
        if (c.kind === 'leave' || c.kind === 'sick') t.leave++;
        t.worked += c.worked; t.overtime += c.overtime;
      });
      return { user: u, eff, cells, totals: t };
    });
    return { rows, dates, tz, holidays: leavesRes.holidays };
  }

  async function renderAttendance(stale) {
    const month = state.att.month;
    const { from, to } = monthBounds(month);
    const [users, summary, leavesRes] = await Promise.all([
      loadUsers(),
      api('/summary' + qs({ from, to })),
      api('/leaves' + qs({ from, to })),
      loadSettings(),
    ]);
    if (stale()) return;
    state.tz = summary.timezone || state.tz;
    const data = buildAttendance(users, summary, leavesRes, month);
    state.attData = data;
    const monthLabel = parseYmd(from).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    setView(
      pageHead('Attendance', monthLabel + ' · times in ' + data.tz,
        '<button type="button" class="btn icon" data-action="att-shift" data-months="-1" aria-label="Previous month">‹</button>' +
        '<input type="month" class="input" data-change="att-month" value="' + month + '" max="' + today().slice(0, 7) + '" aria-label="Month">' +
        '<button type="button" class="btn icon" data-action="att-shift" data-months="1" aria-label="Next month"' + (month >= today().slice(0, 7) ? ' disabled' : '') + '>›</button>' +
        '<button type="button" class="btn" data-action="att-export" data-kind="daily">Daily CSV</button>' +
        '<button type="button" class="btn" data-action="att-export" data-kind="totals">Totals CSV</button>') +
      '<div class="att-legend">' + ['present', 'late', 'half', 'absent', 'leave', 'holiday', 'weekend'].map(k =>
        '<span><i class="att-cell ' + ATT_KIND[k].cls + '">' + ({ present: 'P', late: 'L', half: 'H', absent: 'A', leave: 'LV', holiday: 'Ho', weekend: '' }[k]) + '</i>' + ATT_KIND[k].label + '</span>').join('') +
        '<span class="muted small">Click a day to record leave.</span></div>' +
      '<section class="card">' +
      (users.length
        ? '<div class="table-wrap att-wrap"><table class="tbl att"><thead><tr><th class="att-name">Employee</th>' +
            data.dates.map(d => {
              const dt = parseYmd(d);
              return '<th class="att-day' + (d === today() ? ' today' : '') + '">' + dt.getDate() + '<span>' + WEEKDAYS[dt.getDay()].slice(0, 2) + '</span></th>';
            }).join('') +
            '<th class="num">Present</th><th class="num">Late</th><th class="num">Half</th><th class="num">Absent</th><th class="num">Leave</th><th class="num">Worked h</th><th class="num">Overtime h</th></tr></thead><tbody>' +
          data.rows.map(r => '<tr><td class="att-name strong"><a href="#employee/' + esc(r.user.id) + '">' + esc(r.user.name) + '</a></td>' +
            r.cells.map(c => {
              const title = [fmtDay(parseYmd(c.date)), ATT_KIND[c.kind].label, c.holiday ? c.holiday.name : '',
                c.sum && c.sum.first_in ? 'In ' + tzTime(c.sum.first_in, data.tz) + ', out ' + tzTime(c.sum.last_out, data.tz) : '',
                c.worked ? 'Worked ' + fmtDur(c.worked) : '', c.late && c.kind !== 'late' ? 'Arrived late' : '',
                c.leave ? 'Leave: ' + c.leave.type.replace('_', ' ') + (c.leave.note ? ' (' + c.leave.note + ')' : '') : ''].filter(Boolean).join(' · ');
              return '<td class="att-td"><button type="button" class="att-cell ' + ATT_KIND[c.kind].cls + (c.late && c.kind !== 'late' ? ' was-late' : '') +
                '" data-action="att-cell" data-user="' + esc(r.user.id) + '" data-date="' + c.date + '" title="' + esc(title) + '">' + esc(c.code) + '</button></td>';
            }).join('') +
            '<td class="num">' + r.totals.present + '</td><td class="num">' + r.totals.late + '</td><td class="num">' + r.totals.half + '</td>' +
            '<td class="num">' + r.totals.absent + '</td><td class="num">' + r.totals.leave + '</td>' +
            '<td class="num">' + fmtHours(r.totals.worked) + '</td><td class="num">' + fmtHours(r.totals.overtime) + '</td></tr>').join('') +
          '</tbody></table></div>'
        : emptyState('No employees yet', '')) +
      '</section>' +
      '<section class="card"><div class="card-head"><h2>Holidays this month</h2></div><div class="card-body">' +
        (data.holidays.length
          ? '<div class="table-wrap"><table class="tbl"><tbody>' + data.holidays.map(h =>
              '<tr><td class="nowrap">' + fmtDay(parseYmd(h.date)) + '</td><td class="strong">' + esc(h.name) + '</td>' +
              '<td class="actions"><button type="button" class="btn small danger-ghost" data-action="holiday-delete" data-date="' + esc(h.date) + '">Delete</button></td></tr>').join('') +
            '</tbody></table></div>'
          : '<p class="muted small">No holidays recorded.</p>') +
        '<form class="inline-form" data-form="holiday" novalidate>' +
          '<input type="date" class="input" name="date" value="' + from + '" aria-label="Holiday date">' +
          '<input type="text" class="input" name="name" placeholder="Holiday name" maxlength="80" aria-label="Holiday name">' +
          '<button type="submit" class="btn">Add holiday</button>' +
        '</form><div class="form-error" data-err="holiday" role="alert"></div>' +
      '</div></section>'
    );
  }

  function openLeaveModal(userId, date) {
    const data = state.attData;
    const row = data && data.rows.find(r => r.user.id === userId);
    const cell = row && row.cells.find(c => c.date === date);
    if (!row || !cell) return;
    const leave = cell.leave;
    const m = openModal(
      '<h2>' + esc(row.user.name) + '</h2><p class="muted">' + fmtDay(parseYmd(date)) + ' · ' + esc(ATT_KIND[cell.kind].label || 'Upcoming') + '</p>' +
      (cell.sum ? '<p class="small">Worked ' + fmtDur(cell.sum.worked_mins) + (cell.sum.first_in ? ', in ' + tzTime(cell.sum.first_in, data.tz) + ', out ' + tzTime(cell.sum.last_out, data.tz) : '') + '</p>' : '') +
      (cell.holiday ? '<p class="small">Company holiday: ' + esc(cell.holiday.name) + '</p>' : '') +
      '<form data-form novalidate>' +
        field('Leave', '<select class="input" name="type"><option value="">No leave</option>' +
          [['leave', 'Leave'], ['sick', 'Sick leave'], ['half_day', 'Half day'], ['wfh', 'Work from home']].map(([v, l]) =>
            '<option value="' + v + '"' + (leave && leave.type === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>') +
        field('Note', '<input class="input" name="note" maxlength="200" value="' + esc(leave ? leave.note || '' : '') + '" placeholder="Optional">') +
        '<div class="form-error" data-err role="alert"></div>' +
        '<div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button>' +
        '<button type="submit" class="btn primary">Save</button></div>' +
      '</form>');
    const form = $('[data-form]', m);
    const err = $('[data-err]', m);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      err.textContent = '';
      const type = form.elements.namedItem('type').value;
      const btn = form.querySelector('[type=submit]');
      setBusy(m, true);
      btnBusy(btn, true, 'Saving…');
      try {
        if (type) await api('/leaves', { method: 'PUT', body: { user_id: userId, date, type, note: form.elements.namedItem('note').value } });
        else if (leave) await api('/leaves/' + userId + '/' + date, { method: 'DELETE' });
        closeModal();
        toast(type ? 'Leave saved' : 'Leave cleared');
        render();
      } catch (ex) {
        err.textContent = ex.message;
        setBusy(m, false);
        btnBusy(btn, false);
      }
    });
  }

  function downloadCsv(name, rows) {
    const csv = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportAttendance(kind) {
    const data = state.attData;
    if (!data) return;
    const month = state.att.month;
    if (kind === 'totals') {
      downloadCsv('attendance_totals_' + month + '.csv', [['Employee', 'Present days', 'Late days', 'Half days', 'Absent days', 'Leave days', 'Worked hours', 'Overtime hours', 'Daily goal (h)']]
        .concat(data.rows.map(r => [r.user.name, r.totals.present, r.totals.late, r.totals.half, r.totals.absent, r.totals.leave,
          fmtHours(r.totals.worked), fmtHours(r.totals.overtime), fmtHours(r.eff.daily_goal_mins)])));
    } else {
      const rows = [['Employee', 'Date', 'Weekday', 'Status', 'Late', 'First in', 'Last out', 'Worked hours', 'Idle hours', 'Break hours', 'Overtime hours', 'Activity %', 'Leave note']];
      data.rows.forEach(r => r.cells.forEach(c => {
        if (c.kind === 'upcoming' || c.kind === 'none') return;
        const s = c.sum;
        rows.push([r.user.name, c.date, WEEKDAYS[parseYmd(c.date).getDay()], ATT_KIND[c.kind].label, c.late ? 'yes' : '',
          s && s.first_in ? tzTime(s.first_in, data.tz) : '', s && s.last_out ? tzTime(s.last_out, data.tz) : '',
          fmtHours(c.worked), fmtHours(s ? s.idle_mins : 0), fmtHours(s ? s.break_mins : 0), fmtHours(c.overtime),
          s && s.activity_pct != null ? s.activity_pct : '', c.leave ? c.leave.note || '' : (c.holiday ? c.holiday.name : '')]);
      }));
      downloadCsv('attendance_daily_' + month + '.csv', rows);
    }
    toast('Export ready');
  }

  // ── Projects ────────────────────────────────────────────────────────────────
  async function renderProjects(stale) {
    const p = state.proj;
    if (p.from > p.to) { const t = p.from; p.from = p.to; p.to = t; }
    const [projects, , summary] = await Promise.all([
      loadProjects(),
      loadUsers(),
      api('/summary' + qs({ from: p.from, to: p.to })),
    ]);
    if (stale()) return;
    const byProject = groupBy(summary.projects, r => r.project_id);
    const totalOf = id => (byProject[id] || []).reduce((a, r) => a + r.worked_mins, 0);
    const active = projects.filter(x => !x.archived), archived = projects.filter(x => x.archived);
    const reportRows = summary.projects.slice().sort((a, b) => totalOf(b.project_id) - totalOf(a.project_id) || b.worked_mins - a.worked_mins);

    const projectRows = list => list.map(x =>
      '<tr><td class="strong">' + esc(x.name) + '</td><td class="muted">' + esc(x.client || '—') + '</td>' +
      '<td class="num">' + fmtDur(totalOf(x.id)) + '</td>' +
      '<td class="actions"><button type="button" class="btn small" data-action="project-edit" data-id="' + esc(x.id) + '">Edit</button>' +
      '<button type="button" class="btn small" data-action="project-archive" data-id="' + esc(x.id) + '">' + (x.archived ? 'Restore' : 'Archive') + '</button></td></tr>').join('');

    setView(
      pageHead('Projects', active.length + ' active · employees pick one from the desktop app’s tray menu',
        '<button type="button" class="btn primary" data-action="project-new">+ New project</button>') +
      '<div class="toolbar">' +
        '<label>From <input type="date" class="input" data-change="proj-from" value="' + p.from + '" max="' + today() + '"></label>' +
        '<label>To <input type="date" class="input" data-change="proj-to" value="' + p.to + '" max="' + today() + '"></label>' +
      '</div>' +
      '<section class="card">' +
        (projects.length
          ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>Project</th><th>Client</th><th class="num">Worked in range</th><th></th></tr></thead><tbody>' +
            projectRows(active) +
            (archived.length ? '<tr class="group-row"><td colspan="4">Archived</td></tr>' + projectRows(archived) : '') +
            '</tbody></table></div>'
          : emptyState('No projects yet', 'Create one, and employees can choose it from the desktop app.')) +
      '</section>' +
      '<section class="card"><div class="card-head"><h2>Time per project and employee</h2></div>' + projectsTimeTable(reportRows, true) + '</section>'
    );
  }

  function openProjectModal(project) {
    const m = openModal(
      '<h2>' + (project ? 'Edit project' : 'New project') + '</h2>' +
      '<form data-form novalidate>' +
        field('Name', '<input class="input" name="name" maxlength="80" value="' + esc(project ? project.name : '') + '">') +
        field('Client (optional)', '<input class="input" name="client" maxlength="80" value="' + esc(project ? project.client || '' : '') + '">') +
        '<div class="form-error" data-err role="alert"></div>' +
        '<div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button>' +
        '<button type="submit" class="btn primary">' + (project ? 'Save' : 'Create project') + '</button></div>' +
      '</form>');
    const form = $('[data-form]', m);
    const err = $('[data-err]', m);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      err.textContent = '';
      const body = { name: form.elements.namedItem('name').value.trim(), client: form.elements.namedItem('client').value.trim() };
      if (!body.name) { err.textContent = 'Enter a project name.'; return; }
      const btn = form.querySelector('[type=submit]');
      setBusy(m, true);
      btnBusy(btn, true, 'Saving…');
      try {
        await api(project ? '/projects/' + project.id : '/projects', { method: project ? 'PATCH' : 'POST', body });
        closeModal();
        toast(project ? 'Project updated' : 'Project created');
        render();
      } catch (ex) {
        err.textContent = ex.message;
        setBusy(m, false);
        btnBusy(btn, false);
      }
    });
  }

  async function toggleArchive(btn, id) {
    const project = state.projects.find(x => x.id === id);
    if (!project) return;
    btnBusy(btn, true, project.archived ? 'Restoring…' : 'Archiving…');
    try {
      await api('/projects/' + id, { method: 'PATCH', body: { archived: !project.archived } });
      toast(project.archived ? 'Project restored' : 'Project archived');
      render();
    } catch (err) {
      toast(err.message, 'err');
      btnBusy(btn, false);
    }
  }

  // ── Settings ────────────────────────────────────────────────────────────────
  async function renderSettings(stale) {
    const [settings, cats] = await Promise.all([loadSettings(), api('/app-categories')]);
    if (stale()) return;
    const g = settings.global;
    setView(
      pageHead('Settings', 'Company-wide defaults. You can override them for one employee from their page.') +
      '<form data-form="settings" novalidate>' +
        SETTINGS_META.map(group =>
          '<section class="card"><div class="card-head"><h2>' + esc(group.group) + '</h2></div><div class="card-body settings-grid">' +
          group.items.map(item =>
            '<div class="setting-row"><div class="setting-label">' + esc(item.label) +
              (settings.defaults && settings.defaults[item.key] !== undefined && JSON.stringify(settings.defaults[item.key]) !== JSON.stringify(g[item.key])
                ? '<span class="muted small">Default: ' + esc(settingText(item, settings.defaults[item.key])) + '</span>' : '') +
            '</div><div class="setting-control">' + settingControl(item, g[item.key], 's_' + item.key, false) + '</div></div>').join('') +
          '</div></section>').join('') +
        '<div class="form-error" data-err="settings" role="alert"></div>' +
        '<div class="save-bar"><span class="muted small">Desktop apps pick up changes within about 2 minutes.</span><button type="submit" class="btn primary">Save settings</button></div>' +
      '</form>' +
      '<section class="card"><div class="card-head"><h2>App &amp; website categories</h2><span class="muted small">A pattern matches any part of the app or site name. The longest match wins.</span></div>' +
        '<div class="card-body" id="catCard">' + categoriesTable(cats.categories) + '</div></section>'
    );
  }

  function categoriesTable(categories) {
    return '<form class="inline-form" data-form="category" novalidate>' +
        '<input class="input" name="pattern" maxlength="80" placeholder="e.g. figma, youtube, docs.google" aria-label="Pattern">' +
        '<select class="input" name="category" aria-label="Category"><option value="productive">Productive</option><option value="neutral">Neutral</option><option value="unproductive">Unproductive</option></select>' +
        '<button type="submit" class="btn">Add</button>' +
      '</form><div class="form-error" data-err="category" role="alert"></div>' +
      (categories.length
        ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>Pattern</th><th>Category</th><th></th></tr></thead><tbody>' +
          categories.map(c => '<tr><td class="strong">' + esc(c.pattern) + '</td><td><select class="input small-input" data-change="category-set" data-pattern="' + esc(c.pattern) + '" aria-label="Category for ' + esc(c.pattern) + '">' +
            ['productive', 'neutral', 'unproductive'].map(v => '<option value="' + v + '"' + (c.category === v ? ' selected' : '') + '>' + v + '</option>').join('') +
            '</select></td><td class="actions"><button type="button" class="btn small danger-ghost" data-action="category-delete" data-pattern="' + esc(c.pattern) + '">Delete</button></td></tr>').join('') +
          '</tbody></table></div>'
        : '<p class="muted small">No categories yet. Everything counts as neutral.</p>');
  }

  async function reloadCategories() {
    const { categories } = await api('/app-categories');
    const card = $('#catCard');
    if (card) card.innerHTML = categoriesTable(categories);
  }

  async function saveSettings(form) {
    const err = $('[data-err="settings"]', form);
    err.textContent = '';
    const global = {};
    try {
      SETTINGS_META.forEach(g => g.items.forEach(item => { global[item.key] = readSetting(form, item, 's_' + item.key); }));
    } catch (ex) {
      err.textContent = ex.message;
      return;
    }
    const btn = form.querySelector('[type=submit]');
    btnBusy(btn, true, 'Saving…');
    try {
      const res = await api('/settings', { method: 'PUT', body: { global } });
      state.settings = Object.assign({}, state.settings, { global: res.global });
      toast('Settings saved');
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btnBusy(btn, false);
    }
  }

  // ── Modals ──────────────────────────────────────────────────────────────────
  function openModal(html, wide) {
    const root = $('#modalRoot');
    root.innerHTML = '<div class="backdrop"><div class="modal' + (wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' + html + '</div></div>';
    const backdrop = root.firstElementChild, modal = backdrop.firstElementChild;
    backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) closeModal(); });
    modal.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
    const first = modal.querySelector('input:not([disabled]), select, textarea, button');
    if (first) first.focus();
    return modal;
  }
  function closeModal() { $('#modalRoot').innerHTML = ''; }
  function setBusy(root, on) { root.querySelectorAll('button, input, select, textarea').forEach(el => { el.disabled = on; }); }

  // Shows a spinner + label on a single button while an async action runs, restores it after
  function btnBusy(btn, on, label) {
    if (on) {
      btn.dataset.label = btn.dataset.label || btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('busy');
      btn.innerHTML = '<span class="spinner"></span>' + esc(label || btn.textContent.trim());
    } else {
      btn.disabled = false;
      btn.classList.remove('busy');
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
  }

  // Runs onConfirm with the Confirm button in a busy state; dialog stays open and shows the error on failure
  function confirmDialog(title, message, confirmLabel, busyLabel, onConfirm) {
    const m = openModal('<h2>' + esc(title) + '</h2><p class="muted">' + esc(message) + '</p>' +
      '<div class="form-error" data-err role="alert"></div>' +
      '<div class="modal-actions"><button type="button" class="btn ghost" data-answer="no">Cancel</button>' +
      '<button type="button" class="btn danger" data-answer="yes">' + esc(confirmLabel) + '</button></div>');
    const err = $('[data-err]', m);
    m.addEventListener('click', async e => {
      const b = e.target.closest('[data-answer]');
      if (!b) return;
      if (b.dataset.answer === 'no') { closeModal(); return; }
      err.textContent = '';
      setBusy(m, true);
      btnBusy(b, true, busyLabel);
      try {
        await onConfirm();
        closeModal();
      } catch (ex) {
        err.textContent = ex.message;
        setBusy(m, false);
        btnBusy(b, false);
      }
    });
  }

  function openSessionModal(session, opts) {
    opts = opts || {};
    if (!session && !state.users.length) { toast('There are no employees yet, so there is no one to add a session for.', 'err'); return; }
    const isEdit = !!session;
    const day = state.view === 'dashboard' ? state.dashDate : today();
    const userId = opts.userId || state.sess.userId || (state.view === 'employee' && state.emp ? state.emp.id : '');

    const m = openModal(
      '<h2>' + (isEdit ? 'Edit session' : 'Add session') + '</h2>' +
      (isEdit ? '<p class="muted">' + esc(nameOf(session)) + ' · ' + fmtDay(session.start_time) + '</p>' : '') +
      '<form data-form novalidate>' +
        (isEdit ? '' : field('Employee', '<select class="input" name="user_id"><option value="">Choose an employee</option>' + userOptions(userId) + '</select>')) +
        '<div class="grid3">' +
          field('Start', '<input class="input" type="datetime-local" name="start" value="' + (isEdit ? toInput(session.start_time) : day + 'T09:00') + '">') +
          field('End', '<input class="input" type="datetime-local" name="end" value="' + (isEdit ? toInput(session.end_time) : day + 'T10:00') + '">') +
          field('Status', statusSelect(isEdit ? session.status : 'active')) +
        '</div>' +
        '<div class="grid2">' +
          field('Category', categorySelect(isEdit ? session.category : '')) +
          field('Project', projectSelect(isEdit ? session.project_id : '')) +
        '</div>' +
        field('Note', '<input class="input" name="note" maxlength="500" value="' + esc(isEdit ? session.note || '' : '') + '" placeholder="Optional">') +
        '<p class="muted small" data-dur></p>' +
        '<div class="form-error" data-err role="alert"></div>' +
        '<div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button>' +
        '<button type="submit" class="btn primary">' + (isEdit ? 'Save changes' : 'Add session') + '</button></div>' +
      '</form>');

    const form = $('[data-form]', m);
    const f = n => form.elements.namedItem(n);
    const err = $('[data-err]', m);
    const updateDur = () => {
      const s = fromInput(f('start').value), e = fromInput(f('end').value);
      $('[data-dur]', m).textContent = s && e
        ? (new Date(e) > new Date(s) ? 'Duration: ' + fmtDur((new Date(e) - new Date(s)) / 60000) : 'End must be after start')
        : '';
    };
    form.addEventListener('input', updateDur);
    updateDur();

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      err.textContent = '';
      const body = {
        start_time: fromInput(f('start').value), end_time: fromInput(f('end').value), status: f('status').value,
        category: f('category').value || null, project_id: f('project_id').value || null, note: f('note').value,
      };
      if (!isEdit) body.user_id = f('user_id').value;
      if (!isEdit && !body.user_id) { err.textContent = 'Choose an employee.'; return; }
      if (!body.start_time || !body.end_time) { err.textContent = 'Start and end are both required.'; return; }
      if (new Date(body.end_time) <= new Date(body.start_time)) { err.textContent = 'End must be after start.'; return; }
      const submitBtn = form.querySelector('[type=submit]');
      setBusy(m, true);
      btnBusy(submitBtn, true, isEdit ? 'Saving…' : 'Adding…');
      try {
        await api(isEdit ? '/sessions/' + session.id : '/sessions', { method: isEdit ? 'PATCH' : 'POST', body });
        closeModal();
        toast(isEdit ? 'Session updated' : 'Session added');
        render();
      } catch (ex) {
        err.textContent = ex.message;
        setBusy(m, false);
        btnBusy(submitBtn, false);
      }
    });
  }

  function openReview(a) {
    const s = a.sessions;
    const m = openModal(
      '<h2>Adjustment request</h2>' +
      '<div class="meta-grid">' +
        meta('Employee', esc(nameOf(a))) + meta('Requested', fmtDateTime(a.created_at)) + meta('Status', adjPill(a.status)) +
        (a.resolved_at ? meta('Decided', fmtDateTime(a.resolved_at)) : '') +
      '</div>' +
      '<div class="quote">' + esc(a.note) + '</div>' +
      '<h3>Session</h3>' +
      (s
        ? '<p class="muted small">Logged as ' + esc(segLabel(s).toLowerCase()) + ', ' + fmtDay(s.start_time) + ', ' +
          fmtTime(s.start_time) + '–' + fmtTime(s.end_time) + ' (' + fmtDur(segMins(s)) + ')</p>'
        : '<p class="muted small">No session is linked to this request. Enter the times below to create one when you approve.</p>') +
      '<form data-form novalidate>' +
        '<div class="grid3">' +
          field('Start', '<input class="input" type="datetime-local" name="start" value="' + (s ? toInput(s.start_time) : '') + '">') +
          field('End', '<input class="input" type="datetime-local" name="end" value="' + (s ? toInput(s.end_time) : '') + '">') +
          field('Status', statusSelect(s ? s.status : 'active')) +
        '</div>' +
        field('Category', categorySelect(s ? s.category : '')) +
        '<label class="check"><input type="checkbox" name="apply"> ' + (s ? 'Apply these session changes when approving' : 'Create this session when approving') + '</label>' +
        field('Owner notes', '<textarea class="input" name="notes" rows="3" placeholder="Reason for your decision (optional)">' + esc(a.owner_notes || '') + '</textarea>') +
        '<div class="form-error" data-err role="alert"></div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn ghost" data-close>Close</button>' +
          (a.status !== 'pending' ? '<button type="button" class="btn" data-decide="pending">Reopen</button>' : '') +
          '<button type="button" class="btn danger" data-decide="rejected">Reject</button>' +
          '<button type="button" class="btn primary" data-decide="approved">Approve</button>' +
        '</div>' +
      '</form>');

    const form = $('[data-form]', m);
    const f = n => form.elements.namedItem(n);
    const err = $('[data-err]', m);
    ['start', 'end', 'status', 'category'].forEach(n => f(n).addEventListener('change', () => { f('apply').checked = true; }));
    form.addEventListener('submit', ev => ev.preventDefault());

    m.addEventListener('click', async e => {
      const b = e.target.closest('[data-decide]');
      if (!b) return;
      err.textContent = '';
      const status = b.dataset.decide;
      const body = { status, owner_notes: f('notes').value };
      if (status === 'approved' && f('apply').checked) {
        const st = fromInput(f('start').value), en = fromInput(f('end').value);
        if (!st || !en) { err.textContent = 'Enter both start and end to apply session changes.'; return; }
        if (new Date(en) <= new Date(st)) { err.textContent = 'End must be after start.'; return; }
        body.session = { start_time: st, end_time: en, status: f('status').value, category: f('category').value || null };
      }
      setBusy(m, true);
      btnBusy(b, true, { approved: 'Approving…', rejected: 'Rejecting…', pending: 'Reopening…' }[status]);
      try {
        await api('/adjustments/' + a.id, { method: 'PATCH', body });
        closeModal();
        toast(status === 'approved' ? 'Request approved' + (body.session ? ' and session updated' : '')
          : status === 'rejected' ? 'Request rejected' : 'Request reopened');
        refreshPending();
        render();
      } catch (ex) {
        err.textContent = ex.message;
        setBusy(m, false);
        btnBusy(b, false);
      }
    });
  }

  function currentEmployee() { return state.emp && state.users.find(u => u.id === state.emp.id); }

  function openRenameModal() {
    const user = currentEmployee();
    if (!user) return;
    const m = openModal('<h2>Rename employee</h2>' +
      '<p class="muted small">Their desktop app shows the new name after its next sync.</p>' +
      '<form data-form novalidate>' + field('Name', '<input class="input" name="name" maxlength="60" value="' + esc(user.name) + '">') +
      '<div class="form-error" data-err role="alert"></div>' +
      '<div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Rename</button></div></form>');
    const form = $('[data-form]', m), err = $('[data-err]', m);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const name = form.elements.namedItem('name').value.trim();
      if (!name) { err.textContent = 'Enter a name.'; return; }
      const btn = form.querySelector('[type=submit]');
      setBusy(m, true);
      btnBusy(btn, true, 'Renaming…');
      try {
        await api('/users/' + user.id, { method: 'PATCH', body: { name } });
        closeModal();
        toast('Employee renamed');
        render();
      } catch (ex) {
        err.textContent = ex.message;
        setBusy(m, false);
        btnBusy(btn, false);
      }
    });
  }

  function openMergeModal() {
    const user = currentEmployee();
    if (!user) return;
    if (state.users.length < 2) { toast('There is no other employee to merge into.', 'err'); return; }
    const m = openModal('<h2>Merge ' + esc(user.name) + ' into…</h2>' +
      '<p class="muted small">Use this when one person shows up twice, for example after a typo in their name. All sessions, requests, computers, ' +
      'activity, apps and screenshots move to the employee you choose, and ' + esc(user.name) + ' is deleted. This cannot be undone.</p>' +
      '<form data-form novalidate>' + field('Merge into', '<select class="input" name="into"><option value="">Choose an employee</option>' + userOptions('', user.id) + '</select>') +
      '<div class="form-error" data-err role="alert"></div>' +
      '<div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn danger">Merge</button></div></form>');
    const form = $('[data-form]', m), err = $('[data-err]', m);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const into = form.elements.namedItem('into').value;
      if (!into) { err.textContent = 'Choose who to merge into.'; return; }
      const btn = form.querySelector('[type=submit]');
      setBusy(m, true);
      btnBusy(btn, true, 'Merging…');
      try {
        await api('/users/' + user.id + '/merge', { method: 'POST', body: { into_user_id: into } });
        closeModal();
        toast(user.name + ' merged into ' + userName(into));
        nav('employee/' + into);
      } catch (ex) {
        err.textContent = ex.message;
        setBusy(m, false);
        btnBusy(btn, false);
      }
    });
  }

  function openOverridesModal() {
    const user = currentEmployee();
    if (!user || !state.settings) return;
    const g = state.settings.global, own = user.settings || {};
    const items = [].concat(...SETTINGS_META.map(gr => gr.items)).filter(i => !i.companyOnly);
    const m = openModal('<h2>Settings for ' + esc(user.name) + '</h2>' +
      '<p class="muted small">Tick “Custom” to override the company setting for this employee only.</p>' +
      '<form data-form novalidate><div class="override-list">' +
      items.map(item => {
        const custom = own[item.key] !== undefined && own[item.key] !== null;
        return '<div class="override-row"><div class="setting-label">' + esc(item.label) +
          '<span class="muted small">Company: ' + esc(settingText(item, g[item.key])) + '</span></div>' +
          '<label class="check small"><input type="checkbox" data-override="' + item.key + '"' + (custom ? ' checked' : '') + '> Custom</label>' +
          '<div class="setting-control" data-control="' + item.key + '">' + settingControl(item, custom ? own[item.key] : g[item.key], 'o_' + item.key, !custom) + '</div></div>';
      }).join('') +
      '</div><div class="form-error" data-err role="alert"></div>' +
      '<div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></div></form>', true);
    const form = $('[data-form]', m), err = $('[data-err]', m);
    form.addEventListener('change', ev => {
      const box = ev.target.closest('[data-override]');
      if (box) form.querySelectorAll('[data-control="' + box.dataset.override + '"] input').forEach(el => { el.disabled = !box.checked; });
      if (ev.target.type === 'checkbox' && ev.target.closest('.switch')) ev.target.nextElementSibling.textContent = ev.target.checked ? 'On' : 'Off';
    });
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      err.textContent = '';
      const settings = {};
      try {
        items.forEach(item => {
          settings[item.key] = form.querySelector('[data-override="' + item.key + '"]').checked ? readSetting(form, item, 'o_' + item.key) : null;
        });
      } catch (ex) { err.textContent = ex.message; return; }
      const btn = form.querySelector('[type=submit]');
      setBusy(m, true);
      btnBusy(btn, true, 'Saving…');
      try {
        await api('/users/' + user.id, { method: 'PATCH', body: { settings } });
        closeModal();
        toast('Settings saved for ' + user.name);
        render();
      } catch (ex) {
        err.textContent = ex.message;
        setBusy(m, false);
        btnBusy(btn, false);
      }
    });
  }

  async function setDeviceStatus(btn, id, status) {
    const d = state.deviceIndex[id];
    const run = async () => {
      await api('/devices/' + id, { method: 'PATCH', body: { status } });
      toast({ approved: 'Computer approved', rejected: 'Computer rejected', revoked: 'Computer revoked' }[status]);
      render();
    };
    if (status === 'revoked') {
      confirmDialog('Revoke this computer?', (d && d.hostname ? d.hostname : 'This computer') +
        ' will stop sending data immediately and the app will show that it was removed. Its past data stays.', 'Revoke', 'Revoking…', run);
      return;
    }
    btnBusy(btn, true, status === 'approved' ? 'Approving…' : 'Rejecting…');
    try { await run(); } catch (err) { toast(err.message, 'err'); btnBusy(btn, false); }
  }

  function openMoveDevice(id) {
    const d = state.deviceIndex[id];
    if (!d) return;
    const m = openModal('<h2>Move computer</h2>' +
      '<p class="muted small">' + esc(d.hostname || 'This computer') + ' and everything it recorded (sessions, activity, apps, screenshots) will belong to the employee you choose.</p>' +
      '<form data-form novalidate>' + field('Employee', '<select class="input" name="user"><option value="">Choose an employee</option>' + userOptions('', d.user_id) + '</select>') +
      '<div class="form-error" data-err role="alert"></div>' +
      '<div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Move</button></div></form>');
    const form = $('[data-form]', m), err = $('[data-err]', m);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const userId = form.elements.namedItem('user').value;
      if (!userId) { err.textContent = 'Choose an employee.'; return; }
      const btn = form.querySelector('[type=submit]');
      setBusy(m, true);
      btnBusy(btn, true, 'Moving…');
      try {
        await api('/devices/' + id, { method: 'PATCH', body: { user_id: userId } });
        closeModal();
        toast('Computer moved to ' + userName(userId));
        render();
      } catch (ex) {
        err.textContent = ex.message;
        setBusy(m, false);
        btnBusy(btn, false);
      }
    });
  }

  function openShot(id) {
    const s = state.shotIndex[id];
    if (!s) return;
    const m = openModal('<div class="shot-full">' + (s.url ? '<img src="' + esc(s.url) + '" alt="Screenshot">' : '<p class="muted">Image unavailable.</p>') + '</div>' +
      '<div class="meta-grid">' + meta('Taken', fmtDateTime(s.taken_at)) + meta('Screen', String((s.display || 0) + 1)) +
        meta('Activity', activityText(s.activity_pct)) + meta('App', esc(s.app || '—')) + meta('Blurred', s.blurred ? 'Yes' : 'No') + '</div>' +
      '<div class="modal-actions"><button type="button" class="btn ghost" data-close>Close</button>' +
      '<button type="button" class="btn danger" data-act="delete">Delete screenshot</button></div>', true);
    m.querySelector('[data-act="delete"]').addEventListener('click', () => {
      confirmDialog('Delete screenshot?', 'It is removed from storage permanently.', 'Delete', 'Deleting…', async () => {
        await api('/screenshots/' + id, { method: 'DELETE' });
        toast('Screenshot deleted');
        loadDayDetail();
      });
    });
  }

  function deleteEmployee(id) {
    const u = state.users.find(x => x.id === id);
    confirmDialog('Delete employee?',
      'This permanently deletes ' + (u ? u.name : 'this employee') + ' with all their sessions, requests, computers, activity, apps and screenshots. ' +
      'If their desktop app is still running, they will reappear when it logs the next session.',
      'Delete employee', 'Deleting…',
      async () => {
        await api('/users/' + id, { method: 'DELETE' });
        toast('Employee deleted');
        if (state.view === 'employee') nav('employees'); else render();
      });
  }

  function deleteSession(id) {
    const s = state.sessionIndex[id];
    confirmDialog('Delete session?',
      s ? nameOf(s) + ', ' + fmtDay(s.start_time) + ', ' + fmtTime(s.start_time) + '–' + fmtTime(s.end_time) + '. This cannot be undone.' : 'This cannot be undone.',
      'Delete session', 'Deleting…',
      async () => {
        await api('/sessions/' + id, { method: 'DELETE' });
        toast('Session deleted');
        render();
      });
  }

  async function exportCsv(btn) {
    const f = state.sess;
    btnBusy(btn, true, 'Exporting…');
    try {
      const rows = await fetchAllSessions(Object.assign({ user_id: f.userId, status: f.status }, dayRange(f.from, f.to)));
      downloadCsv('sessions_' + f.from + '_to_' + f.to + '.csv',
        [['Date', 'Employee', 'Start', 'End', 'Duration (min)', 'Status', 'Category', 'Project', 'Activity %', 'Note', 'Session ID']]
          .concat(rows.slice().sort(byStart).map(s => [ymd(new Date(s.start_time)), nameOf(s), fmtTime(s.start_time), fmtTime(s.end_time),
            Math.round(segMins(s)), s.status, s.category || '', projectName(s.project_id, s), s.activity_pct != null ? s.activity_pct : '', s.note || '', s.id])));
      toast('Exported ' + rows.length + ' sessions');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btnBusy(btn, false);
    }
  }

  // Leading = + - @ would run as a formula in Excel; names come from employees
  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'err' ? ' err' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'err' ? 6000 : 3500);
  }

  // ── Routing & rendering ─────────────────────────────────────────────────────
  function setView(html) { $('#view').innerHTML = html; }

  function render() {
    const seq = ++state.renderSeq;
    const stale = () => seq !== state.renderSeq;
    const fn = {
      dashboard: renderDashboard, employees: renderEmployees, employee: renderEmployee, sessions: renderSessions,
      adjustments: renderAdjustments, attendance: renderAttendance, projects: renderProjects, settings: renderSettings,
    }[state.view];
    const view = $('#view');
    view.classList.add('busy');
    document.body.classList.add('is-loading');
    return fn(stale)
      .catch(err => {
        if (stale() || err.message === 'Unauthorized') return;
        setView(err.migration
          ? migrationBox(err.message)
          : '<div class="error-box"><span>' + esc(err.message) + '</span><button type="button" class="btn" data-action="refresh">Try again</button></div>');
      })
      .finally(() => {
        if (stale()) return;
        view.classList.remove('busy');
        document.body.classList.remove('is-loading');
      });
  }

  function route() {
    stopLivePolling();
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    let view = parts[0] || 'dashboard';
    if (view === 'employee' && parts[1]) {
      if (!state.emp || state.emp.id !== parts[1]) {
        state.emp = { id: parts[1], from: ymd(addDays(new Date(), -6)), to: today(), open: new Set(), day: null };
      }
    } else if (!VIEWS.includes(view)) {
      view = 'dashboard';
    }
    state.view = view;
    document.querySelectorAll('#nav [data-view]').forEach(b => {
      b.classList.toggle('active', b.dataset.view === (view === 'employee' ? 'employees' : view));
    });
    setView('<div class="loading"><span class="spinner"></span>Loading…</div>');
    window.scrollTo(0, 0);
    render();
  }

  function nav(hash) {
    if (location.hash.slice(1) === hash) route(); else location.hash = hash;
  }

  function shiftMonth(ym, n) {
    const d = parseYmd(ym + '-01');
    d.setMonth(d.getMonth() + n);
    return ymd(d).slice(0, 7);
  }

  const actions = {
    'refresh':          el => { btnBusy(el, true, 'Refreshing…'); render(); },
    'goto-adjustments': () => { state.adjTab = 'pending'; nav('adjustments'); },
    'dash-shift':       el => { state.dashDate = ymd(addDays(parseYmd(state.dashDate), Number(el.dataset.days))); render(); },
    'dash-today':       () => { state.dashDate = today(); render(); },
    'open-emp':         el => nav('employee/' + el.dataset.id),
    'delete-emp':       el => deleteEmployee(el.dataset.id),
    'toggle-day':       el => {
      const d = el.dataset.day, open = !state.emp.open.has(d);
      if (open) state.emp.open.add(d); else state.emp.open.delete(d);
      el.classList.toggle('open', open);
      const detail = document.querySelector('#view [data-detail="' + d + '"]');
      if (detail) detail.hidden = !open;
    },
    'emp-range':        el => { state.emp.to = today(); state.emp.from = ymd(addDays(new Date(), 1 - Number(el.dataset.days))); render(); },
    'emp-settings':     () => openOverridesModal(),
    'emp-rename':       () => openRenameModal(),
    'emp-merge':        () => openMergeModal(),
    'device-status':    el => setDeviceStatus(el, el.dataset.id, el.dataset.status),
    'device-move':      el => openMoveDevice(el.dataset.id),
    'device-delete':    el => {
      const d = state.deviceIndex[el.dataset.id];
      confirmDialog('Delete this computer?', (d && d.hostname ? d.hostname : 'It') + ' is removed from the list. If it runs the app again it will ask for approval again.',
        'Delete', 'Deleting…', async () => {
          await api('/devices/' + el.dataset.id, { method: 'DELETE' });
          toast('Computer deleted');
          render();
        });
    },
    'open-shot':        el => openShot(el.dataset.id),
    'add-session':      el => openSessionModal(null, { userId: el.dataset.user }),
    'edit-session':     el => { const s = state.sessionIndex[el.dataset.id]; if (s) openSessionModal(s); },
    'delete-session':   el => deleteSession(el.dataset.id),
    'review-adj':       el => { const a = state.adjIndex[el.dataset.id]; if (a) openReview(a); },
    'adj-tab':          el => { state.adjTab = el.dataset.tab; render(); },
    'sess-page':        el => { state.sess.page = Math.max(0, state.sess.page + Number(el.dataset.dir)); render(); },
    'export-csv':       el => exportCsv(el),
    'att-shift':        el => { state.att.month = shiftMonth(state.att.month, Number(el.dataset.months)); render(); },
    'att-cell':         el => openLeaveModal(el.dataset.user, el.dataset.date),
    'att-export':       el => exportAttendance(el.dataset.kind),
    'holiday-delete':   el => confirmDialog('Delete holiday?', fmtDay(parseYmd(el.dataset.date)) + ' will count as a normal day again.', 'Delete', 'Deleting…', async () => {
      await api('/holidays/' + el.dataset.date, { method: 'DELETE' });
      toast('Holiday deleted');
      render();
    }),
    'project-new':      () => openProjectModal(null),
    'project-edit':     el => { const p = state.projects.find(x => x.id === el.dataset.id); if (p) openProjectModal(p); },
    'project-archive':  el => toggleArchive(el, el.dataset.id),
    'category-delete':  el => confirmDialog('Delete category?', '“' + el.dataset.pattern + '” will count as neutral.', 'Delete', 'Deleting…', async () => {
      await api('/app-categories/' + encodeURIComponent(el.dataset.pattern), { method: 'DELETE' });
      toast('Category deleted');
      await reloadCategories();
    }),
  };

  const changeActions = {
    'dash-date':   el => { if (el.value) { state.dashDate = el.value > today() ? today() : el.value; render(); } },
    'emp-from':    el => { if (el.value) { state.emp.from = el.value; render(); } },
    'emp-to':      el => { if (el.value) { state.emp.to = el.value; render(); } },
    'emp-day':     el => { if (el.value) { state.emp.day = el.value; loadDayDetail(); } },
    'att-month':   el => { if (el.value) { state.att.month = el.value; render(); } },
    'proj-from':   el => { if (el.value) { state.proj.from = el.value; render(); } },
    'proj-to':     el => { if (el.value) { state.proj.to = el.value; render(); } },
    'category-set': async el => {
      el.disabled = true;
      try {
        await api('/app-categories', { method: 'PUT', body: { pattern: el.dataset.pattern, category: el.value } });
        toast('Category updated');
      } catch (err) { toast(err.message, 'err'); }
      el.disabled = false;
    },
    'sess-filter': el => {
      if ((el.name === 'from' || el.name === 'to') && !el.value) return;
      state.sess[el.name] = el.value;
      state.sess.page = 0;
      render();
    },
  };

  async function submitInlineForm(form) {
    const kind = form.dataset.form;
    if (kind === 'settings') return saveSettings(form);
    const err = $('[data-err="' + kind + '"]');
    const btn = form.querySelector('[type=submit]');
    if (err) err.textContent = '';
    try {
      if (kind === 'holiday') {
        const date = form.elements.namedItem('date').value, name = form.elements.namedItem('name').value.trim();
        if (!date || !name) throw new Error('Enter a date and a name.');
        btnBusy(btn, true, 'Adding…');
        await api('/holidays', { method: 'PUT', body: { date, name } });
        toast('Holiday added');
        render();
      } else if (kind === 'category') {
        const pattern = form.elements.namedItem('pattern').value.trim().toLowerCase();
        if (!pattern) throw new Error('Enter a pattern.');
        btnBusy(btn, true, 'Adding…');
        await api('/app-categories', { method: 'PUT', body: { pattern, category: form.elements.namedItem('category').value } });
        toast('Category saved');
        await reloadCategories();
      }
    } catch (ex) {
      if (err) err.textContent = ex.message;
      if (btn && btn.isConnected) btnBusy(btn, false);
    }
  }

  $('#view').addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (el && !el.disabled && actions[el.dataset.action]) actions[el.dataset.action](el, e);
  });
  $('#view').addEventListener('change', e => {
    const el = e.target.closest('[data-change]');
    if (el && changeActions[el.dataset.change]) changeActions[el.dataset.change](el);
    if (e.target.type === 'checkbox' && e.target.closest('.switch')) e.target.nextElementSibling.textContent = e.target.checked ? 'On' : 'Off';
  });
  $('#view').addEventListener('input', e => {
    if (e.target.dataset && e.target.dataset.input === 'emp-search') { state.empSearch = e.target.value; applyEmpSearch(); }
  });
  $('#view').addEventListener('submit', e => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    submitInlineForm(form);
  });
  $('#nav').addEventListener('click', e => {
    const b = e.target.closest('[data-view]');
    if (b) nav(b.dataset.view);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#modalRoot').firstElementChild) closeModal(); });
  window.addEventListener('hashchange', () => { if (state.key) route(); });

  // ── Sign in ─────────────────────────────────────────────────────────────────
  function showLogin(msg) {
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#loginError').textContent = msg || '';
    $('#loginKey').value = '';
    $('#loginKey').focus();
  }

  function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    refreshPending();
    route();
  }

  function signOut(msg) {
    clearKey();
    stopLivePolling();
    state.key = null;
    state.renderSeq++;
    document.body.classList.remove('is-loading');
    closeModal();
    showLogin(msg);
  }

  $('#logoutBtn').addEventListener('click', () => signOut(''));

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const key = $('#loginKey').value.trim();
    if (!key) return;
    const btn = $('#loginForm button');
    btnBusy(btn, true, 'Signing in…');
    $('#loginError').textContent = '';
    state.key = key;
    try {
      await api('/ping', { isLogin: true });
      saveKey(key);
      showApp();
    } catch (err) {
      state.key = null;
      $('#loginError').textContent = err.message;
    } finally {
      btnBusy(btn, false);
    }
  });

  const saved = loadKey();
  if (saved) { state.key = saved; showApp(); } else { showLogin(''); }
})();
