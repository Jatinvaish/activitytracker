(() => {
  'use strict';

  const KEY_STORAGE = 'at_admin_key';
  const PAGE_SIZE   = 100;

  const state = {
    key: null,
    users: [],
    sessionIndex: {},
    adjIndex: {},
    renderSeq: 0,
    view: 'dashboard',
    dashDate: ymd(new Date()),
    emp: null,
    empSearch: '',
    sess: { userId: '', from: ymd(addDays(new Date(), -6)), to: ymd(new Date()), status: '', page: 0 },
    adjTab: 'pending',
  };

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
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
  function pct(part, whole) { return whole > 0 ? Math.round(part / whole * 100) + '%' : '—'; }
  function toInput(v) { const d = new Date(v); return ymd(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fromInput(v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  function groupBy(list, keyFn) { const out = {}; list.forEach(x => { const k = keyFn(x); (out[k] = out[k] || []).push(x); }); return out; }
  function byStart(a, b) { return new Date(a.start_time) - new Date(b.start_time); }
  function nameOf(row) { return (row.users && row.users.name) || (state.users.find(u => u.id === row.user_id) || {}).name || 'Unknown'; }
  function today() { return ymd(new Date()); }

  function loadKey()   { try { return sessionStorage.getItem(KEY_STORAGE); } catch (e) { return null; } }
  function saveKey(k)  { try { sessionStorage.setItem(KEY_STORAGE, k); } catch (e) { /* key stays in memory only */ } }
  function clearKey()  { try { sessionStorage.removeItem(KEY_STORAGE); } catch (e) { /* nothing stored */ } }

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
    if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
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
  function indexSessions(list) { list.forEach(s => { state.sessionIndex[s.id] = s; }); }
  function indexAdjustments(list) { list.forEach(a => { state.adjIndex[a.id] = a; }); }

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
  function legend() { return '<div class="legend"><span><i class="sw active"></i>Active</span><span><i class="sw idle"></i>Idle</span></div>'; }
  function emptyState(title, text) { return '<div class="empty"><strong>' + esc(title) + '</strong>' + (text ? '<p>' + esc(text) + '</p>' : '') + '</div>'; }
  function field(label, control) { return '<label class="field"><span>' + esc(label) + '</span>' + control + '</label>'; }
  function meta(label, html) { return '<div class="meta"><span class="label">' + esc(label) + '</span><div>' + html + '</div></div>'; }
  function sessionPill(status) { return '<span class="pill ' + (status === 'active' ? 'green' : 'amber') + '">' + (status === 'active' ? 'Active' : 'Idle') + '</span>'; }
  const ADJ_TONE = { pending: 'amber', approved: 'green', rejected: 'red', resolved: 'blue' };
  function adjPill(status) { return '<span class="pill ' + (ADJ_TONE[status] || '') + '">' + esc(status) + '</span>'; }
  function statusSelect(value) {
    return '<select class="input" name="status">' +
      '<option value="active"' + (value === 'active' ? ' selected' : '') + '>Active</option>' +
      '<option value="idle"' + (value === 'idle' ? ' selected' : '') + '>Idle</option></select>';
  }
  function userOptions(selectedId) {
    return state.users.map(u => '<option value="' + esc(u.id) + '"' + (u.id === selectedId ? ' selected' : '') + '>' + esc(u.name) + '</option>').join('');
  }

  function summarize(list) {
    let active = 0, idle = 0, first = null, last = null;
    list.forEach(s => {
      if (s.status === 'active') active += s.duration_mins; else idle += s.duration_mins;
      const st = new Date(s.start_time), en = new Date(s.end_time);
      if (!first || st < first) first = st;
      if (!last || en > last) last = en;
    });
    return { active, idle, first, last, count: list.length };
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
      const tip = (s.status === 'active' ? 'Active' : 'Idle') + ' ' + fmtTime(s.start_time) + '–' + fmtTime(s.end_time) + ' (' + fmtDur(s.duration_mins) + ')';
      return '<span class="seg ' + (s.status === 'active' ? 'active' : 'idle') + '" style="left:' + ((a - win.lo) / span * 100).toFixed(3) +
        '%;width:' + ((b - a) / span * 100).toFixed(3) + '%" title="' + esc(tip) + '"></span>';
    }).join('');
    return '<div class="tl">' + grid + segs + '</div>';
  }

  function sessionTable(list, adjBySession, full) {
    if (!list.length) return emptyState('No sessions', full ? 'Nothing matches these filters.' : '');
    return '<div class="table-wrap"><table class="tbl' + (full ? '' : ' inner') + '"><thead><tr>' +
      (full ? '<th>Date</th><th>Employee</th>' : '') +
      '<th>Start</th><th>End</th><th class="num">Duration</th><th>Status</th><th>Adjustment</th><th></th></tr></thead><tbody>' +
      list.map(s => {
        const adjs = adjBySession[s.id] || [];
        return '<tr>' +
          (full ? '<td class="nowrap">' + fmtDay(s.start_time) + '</td><td class="strong"><a href="#employee/' + esc(s.user_id) + '">' + esc(nameOf(s)) + '</a></td>' : '') +
          '<td>' + fmtTime(s.start_time) + '</td><td>' + fmtTime(s.end_time) + '</td>' +
          '<td class="num">' + fmtDur(s.duration_mins) + '</td><td>' + sessionPill(s.status) + '</td>' +
          '<td>' + (adjs.length
            ? adjs.map(a => '<button type="button" class="pill-btn" data-action="review-adj" data-id="' + esc(a.id) + '">' + adjPill(a.status) + '</button>').join(' ')
            : '<span class="muted">—</span>') + '</td>' +
          '<td class="actions"><button type="button" class="btn small" data-action="edit-session" data-id="' + esc(s.id) + '">Edit</button>' +
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
            ? fmtDay(s.start_time) + '<br><span class="muted">' + fmtTime(s.start_time) + '–' + fmtTime(s.end_time) + ' · ' + fmtDur(s.duration_mins) + '</span> ' + sessionPill(s.status)
            : '<span class="muted">Not linked</span>') + '</td>' +
          '<td class="note">' + esc(a.note) + '</td>' +
          '<td class="note muted">' + esc(a.owner_notes || '') + '</td>' +
          '<td class="nowrap">' + adjPill(a.status) + (a.resolved_at ? '<div class="muted small">' + fmtDateTime(a.resolved_at) + '</div>' : '') + '</td>' +
          '<td class="actions"><button type="button" class="btn small' + (a.status === 'pending' ? ' primary' : '') + '" data-action="review-adj" data-id="' + esc(a.id) + '">Review</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ── Views ───────────────────────────────────────────────────────────────────
  async function renderDashboard(stale) {
    const isToday = state.dashDate === today();
    const [users, sessions, pend] = await Promise.all([
      loadUsers(),
      fetchAllSessions(dayRange(state.dashDate, state.dashDate)),
      api('/adjustments?status=pending'),
    ]);
    if (stale()) return;
    setPending(pend.adjustments.length);

    const byUser = groupBy(sessions, s => s.user_id);
    const rows = users.map(u => {
      const list = (byUser[u.id] || []).sort(byStart);
      return { user: u, list, sum: summarize(list) };
    }).sort((a, b) => (b.sum.count > 0) - (a.sum.count > 0) || b.sum.active - a.sum.active || a.user.name.localeCompare(b.user.name));
    const win = windowFor(sessions);
    const all = summarize(sessions);
    const present = rows.filter(r => r.sum.count).length;

    setView(
      pageHead('Team overview', fmtDay(parseYmd(state.dashDate)) + (isToday ? ' · Today' : ''),
        '<button type="button" class="btn icon" data-action="dash-shift" data-days="-1" aria-label="Previous day">‹</button>' +
        '<input type="date" class="input" data-change="dash-date" value="' + state.dashDate + '" max="' + today() + '" aria-label="Date">' +
        '<button type="button" class="btn icon" data-action="dash-shift" data-days="1" aria-label="Next day"' + (isToday ? ' disabled' : '') + '>›</button>' +
        (isToday ? '' : '<button type="button" class="btn" data-action="dash-today">Today</button>') +
        '<button type="button" class="btn" data-action="refresh">Refresh</button>') +
      '<div class="kpis">' +
        kpi('Employees present', present + ' / ' + users.length) +
        kpi('Active time', fmtDur(all.active), 'green') +
        kpi('Idle time', fmtDur(all.idle), 'amber') +
        kpi('Productivity', pct(all.active, all.active + all.idle)) +
        kpi('Pending requests', String(pend.adjustments.length), pend.adjustments.length ? 'amber' : '', 'goto-adjustments') +
      '</div>' +
      '<section class="card"><div class="card-head"><h2>Daily timeline</h2>' + legend() + '</div>' +
      (users.length
        ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>Employee</th><th>First in</th><th>Last out</th>' +
          '<th class="num">Active</th><th class="num">Idle</th><th class="num">Productivity</th><th class="tl-col">' + timelineAxis(win) + '</th></tr></thead><tbody>' +
          rows.map(r =>
            '<tr class="clickable' + (r.sum.count ? '' : ' dim') + '" data-action="open-emp" data-id="' + esc(r.user.id) + '">' +
              '<td class="strong">' + esc(r.user.name) + '</td>' +
              '<td>' + (r.sum.first ? fmtTime(r.sum.first) : '—') + '</td>' +
              '<td>' + (r.sum.last ? fmtTime(r.sum.last) : '—') + '</td>' +
              '<td class="num green">' + (r.sum.count ? fmtDur(r.sum.active) : '—') + '</td>' +
              '<td class="num amber">' + (r.sum.count ? fmtDur(r.sum.idle) : '—') + '</td>' +
              '<td class="num">' + pct(r.sum.active, r.sum.active + r.sum.idle) + '</td>' +
              '<td class="tl-col">' + (r.sum.count ? timelineBar(r.list, win) : '<span class="small">No activity</span>') + '</td>' +
            '</tr>').join('') +
          '</tbody></table></div>'
        : emptyState('No employees yet', 'Employees appear here after the desktop app logs their first session.')) +
      '<div class="card-foot">Sessions are recorded when they end, so the time someone is working right now shows up after their next switch between active and idle.</div>' +
      '</section>'
    );
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
        ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>First seen</th><th>Last activity</th><th class="num">Sessions</th><th></th></tr></thead><tbody>' +
          users.map(u =>
            '<tr class="clickable" data-action="open-emp" data-id="' + esc(u.id) + '" data-name="' + esc(u.name.toLowerCase()) + '">' +
              '<td class="strong">' + esc(u.name) + '</td><td>' + fmtDateTime(u.created_at) + '</td><td>' + fmtDateTime(u.last_seen) + '</td>' +
              '<td class="num">' + u.total_sessions + '</td>' +
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

  async function renderEmployee(stale) {
    const e = state.emp;
    if (e.from > e.to) { const t = e.from; e.from = e.to; e.to = t; }
    const [users, sessions, adjRes] = await Promise.all([
      loadUsers(),
      fetchAllSessions(Object.assign({ user_id: e.id }, dayRange(e.from, e.to))),
      api('/adjustments' + qs({ user_id: e.id })),
    ]);
    if (stale()) return;
    const user = users.find(u => u.id === e.id);
    if (!user) {
      setView('<a href="#employees" class="back">← All employees</a>' + emptyState('Employee not found', 'They may have been deleted.'));
      return;
    }
    indexSessions(sessions);
    indexAdjustments(adjRes.adjustments);
    const adjBySession = groupBy(adjRes.adjustments.filter(a => a.session_id), a => a.session_id);
    const byDay = groupBy(sessions, s => ymd(new Date(s.start_time)));
    const days = Object.keys(byDay).sort().reverse();
    const win = windowFor(sessions);
    const tot = summarize(sessions);
    const pendingCount = adjRes.adjustments.filter(a => a.status === 'pending').length;

    setView(
      '<a href="#employees" class="back">← All employees</a>' +
      pageHead(user.name, 'First seen ' + fmtDateTime(user.created_at) + ' · Last activity ' + fmtDateTime(user.last_seen) + ' · ' + user.total_sessions + ' sessions in total',
        '<button type="button" class="btn primary" data-action="add-session" data-user="' + esc(user.id) + '">+ Add session</button>' +
        '<button type="button" class="btn danger-ghost" data-action="delete-emp" data-id="' + esc(user.id) + '">Delete employee</button>') +
      '<div class="toolbar">' +
        '<label>From <input type="date" class="input" data-change="emp-from" value="' + e.from + '" max="' + today() + '"></label>' +
        '<label>To <input type="date" class="input" data-change="emp-to" value="' + e.to + '" max="' + today() + '"></label>' +
        [['Today', 1], ['7 days', 7], ['30 days', 30], ['90 days', 90]]
          .map(([l, n]) => '<button type="button" class="btn small" data-action="emp-range" data-days="' + n + '">' + l + '</button>').join('') +
      '</div>' +
      '<div class="kpis">' +
        kpi('Days with activity', String(days.length)) +
        kpi('Active time', fmtDur(tot.active), 'green') +
        kpi('Idle time', fmtDur(tot.idle), 'amber') +
        kpi('Avg active per day', days.length ? fmtDur(tot.active / days.length) : '—') +
        kpi('Productivity', pct(tot.active, tot.active + tot.idle)) +
      '</div>' +
      '<section class="card"><div class="card-head"><h2>Daily log</h2>' + legend() + '</div>' +
      (days.length
        ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>First in</th><th>Last out</th><th class="num">Active</th><th class="num">Idle</th>' +
          '<th class="num">Sessions</th><th class="tl-col">' + timelineAxis(win) + '</th></tr></thead><tbody>' +
          days.map(d => {
            const list = byDay[d].sort(byStart);
            const s = summarize(list);
            const open = e.open.has(d);
            return '<tr class="clickable day-row' + (open ? ' open' : '') + '" data-action="toggle-day" data-day="' + d + '">' +
                '<td class="strong nowrap"><span class="caret">▸</span>' + fmtDay(parseYmd(d)) + '</td>' +
                '<td>' + fmtTime(s.first) + '</td><td>' + fmtTime(s.last) + '</td>' +
                '<td class="num green">' + fmtDur(s.active) + '</td><td class="num amber">' + fmtDur(s.idle) + '</td>' +
                '<td class="num">' + s.count + '</td><td class="tl-col">' + timelineBar(list, win) + '</td></tr>' +
              '<tr class="day-detail" data-detail="' + d + '"' + (open ? '' : ' hidden') + '><td colspan="7">' +
                sessionTable(list, adjBySession, false) + '</td></tr>';
          }).join('') +
          '</tbody></table></div>'
        : emptyState('No activity in this range', 'Pick a wider date range.')) +
      '</section>' +
      '<section class="card"><div class="card-head"><h2>Adjustment requests</h2>' +
        (pendingCount ? '<span class="pill amber">' + pendingCount + ' pending</span>' : '') + '</div>' +
        adjustmentTable(adjRes.adjustments, false) +
      '</section>'
    );
  }

  async function renderSessions(stale) {
    const f = state.sess;
    if (f.from > f.to) { const t = f.from; f.from = f.to; f.to = t; }
    const range = dayRange(f.from, f.to);
    const [users, res, adjRes] = await Promise.all([
      loadUsers(),
      api('/sessions' + qs({ user_id: f.userId, status: f.status, from: range.from, to: range.to, limit: PAGE_SIZE, offset: f.page * PAGE_SIZE })),
      api('/adjustments'),
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
          [['', 'All'], ['active', 'Active'], ['idle', 'Idle']].map(([v, l]) => '<option value="' + v + '"' + (v === f.status ? ' selected' : '') + '>' + l + '</option>').join('') +
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

  // ── Modals ──────────────────────────────────────────────────────────────────
  function openModal(html) {
    const root = $('#modalRoot');
    root.innerHTML = '<div class="backdrop"><div class="modal" role="dialog" aria-modal="true">' + html + '</div></div>';
    const backdrop = root.firstElementChild, modal = backdrop.firstElementChild;
    backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) closeModal(); });
    modal.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
    const first = modal.querySelector('input:not([disabled]), select, textarea, button');
    if (first) first.focus();
    return modal;
  }
  function closeModal() { $('#modalRoot').innerHTML = ''; }
  function setBusy(root, on) { root.querySelectorAll('button, input, select, textarea').forEach(el => { el.disabled = on; }); }

  function confirmDialog(title, message, confirmLabel) {
    return new Promise(resolve => {
      const m = openModal('<h2>' + esc(title) + '</h2><p class="muted">' + esc(message) + '</p>' +
        '<div class="modal-actions"><button type="button" class="btn ghost" data-answer="no">Cancel</button>' +
        '<button type="button" class="btn danger" data-answer="yes">' + esc(confirmLabel) + '</button></div>');
      m.addEventListener('click', e => {
        const b = e.target.closest('[data-answer]');
        if (!b) return;
        closeModal();
        resolve(b.dataset.answer === 'yes');
      });
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
      const body = { start_time: fromInput(f('start').value), end_time: fromInput(f('end').value), status: f('status').value };
      if (!isEdit) body.user_id = f('user_id').value;
      if (!isEdit && !body.user_id) { err.textContent = 'Choose an employee.'; return; }
      if (!body.start_time || !body.end_time) { err.textContent = 'Start and end are both required.'; return; }
      if (new Date(body.end_time) <= new Date(body.start_time)) { err.textContent = 'End must be after start.'; return; }
      setBusy(m, true);
      try {
        await api(isEdit ? '/sessions/' + session.id : '/sessions', { method: isEdit ? 'PATCH' : 'POST', body });
        closeModal();
        toast(isEdit ? 'Session updated' : 'Session added');
        render();
      } catch (ex) {
        err.textContent = ex.message;
        setBusy(m, false);
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
        ? '<p class="muted small">Logged as ' + (s.status === 'active' ? 'active' : 'idle') + ', ' + fmtDay(s.start_time) + ', ' +
          fmtTime(s.start_time) + '–' + fmtTime(s.end_time) + ' (' + fmtDur(s.duration_mins) + ')</p>'
        : '<p class="muted small">No session is linked to this request. Enter the times below to create one when you approve.</p>') +
      '<form data-form novalidate>' +
        '<div class="grid3">' +
          field('Start', '<input class="input" type="datetime-local" name="start" value="' + (s ? toInput(s.start_time) : '') + '">') +
          field('End', '<input class="input" type="datetime-local" name="end" value="' + (s ? toInput(s.end_time) : '') + '">') +
          field('Status', statusSelect(s ? s.status : 'active')) +
        '</div>' +
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
    ['start', 'end', 'status'].forEach(n => f(n).addEventListener('change', () => { f('apply').checked = true; }));
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
        body.session = { start_time: st, end_time: en, status: f('status').value };
      }
      setBusy(m, true);
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
      }
    });
  }

  async function deleteEmployee(id) {
    const u = state.users.find(x => x.id === id);
    const ok = await confirmDialog('Delete employee?',
      'This permanently deletes ' + (u ? u.name : 'this employee') + ' with all their sessions and adjustment requests. ' +
      'If their desktop app is still running, they will reappear when it logs the next session.', 'Delete employee');
    if (!ok) return;
    try {
      await api('/users/' + id, { method: 'DELETE' });
      toast('Employee deleted');
      if (state.view === 'employee') nav('employees'); else render();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function deleteSession(id) {
    const s = state.sessionIndex[id];
    const ok = await confirmDialog('Delete session?',
      s ? nameOf(s) + ', ' + fmtDay(s.start_time) + ', ' + fmtTime(s.start_time) + '–' + fmtTime(s.end_time) + '. This cannot be undone.' : 'This cannot be undone.',
      'Delete session');
    if (!ok) return;
    try {
      await api('/sessions/' + id, { method: 'DELETE' });
      toast('Session deleted');
      render();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function exportCsv(btn) {
    const f = state.sess;
    btn.disabled = true;
    btn.textContent = 'Exporting…';
    try {
      const rows = await fetchAllSessions(Object.assign({ user_id: f.userId, status: f.status }, dayRange(f.from, f.to)));
      const lines = [['Date', 'Employee', 'Start', 'End', 'Duration (min)', 'Status', 'Session ID']]
        .concat(rows.slice().sort(byStart).map(s => [ymd(new Date(s.start_time)), nameOf(s), fmtTime(s.start_time), fmtTime(s.end_time), s.duration_mins, s.status, s.id]));
      const csv = '﻿' + lines.map(r => r.map(csvCell).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sessions_' + f.from + '_to_' + f.to + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Exported ' + rows.length + ' sessions');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Export CSV';
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
    const fn = { dashboard: renderDashboard, employees: renderEmployees, employee: renderEmployee, sessions: renderSessions, adjustments: renderAdjustments }[state.view];
    const view = $('#view');
    view.classList.add('busy');
    return fn(stale)
      .catch(err => {
        if (stale() || err.message === 'Unauthorized') return;
        setView('<div class="error-box"><span>' + esc(err.message) + '</span><button type="button" class="btn" data-action="refresh">Try again</button></div>');
      })
      .finally(() => { if (!stale()) view.classList.remove('busy'); });
  }

  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    let view = parts[0] || 'dashboard';
    if (view === 'employee' && parts[1]) {
      if (!state.emp || state.emp.id !== parts[1]) {
        state.emp = { id: parts[1], from: ymd(addDays(new Date(), -6)), to: today(), open: new Set() };
      }
    } else if (!['dashboard', 'employees', 'sessions', 'adjustments'].includes(view)) {
      view = 'dashboard';
    }
    state.view = view;
    document.querySelectorAll('#nav [data-view]').forEach(b => {
      b.classList.toggle('active', b.dataset.view === (view === 'employee' ? 'employees' : view));
    });
    setView('<div class="loading">Loading…</div>');
    window.scrollTo(0, 0);
    render();
  }

  function nav(hash) {
    if (location.hash.slice(1) === hash) route(); else location.hash = hash;
  }

  const actions = {
    'refresh':          () => render(),
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
    'add-session':      el => openSessionModal(null, { userId: el.dataset.user }),
    'edit-session':     el => { const s = state.sessionIndex[el.dataset.id]; if (s) openSessionModal(s); },
    'delete-session':   el => deleteSession(el.dataset.id),
    'review-adj':       el => { const a = state.adjIndex[el.dataset.id]; if (a) openReview(a); },
    'adj-tab':          el => { state.adjTab = el.dataset.tab; render(); },
    'sess-page':        el => { state.sess.page = Math.max(0, state.sess.page + Number(el.dataset.dir)); render(); },
    'export-csv':       el => exportCsv(el),
  };

  const changeActions = {
    'dash-date':   el => { if (el.value) { state.dashDate = el.value > today() ? today() : el.value; render(); } },
    'emp-from':    el => { if (el.value) { state.emp.from = el.value; render(); } },
    'emp-to':      el => { if (el.value) { state.emp.to = el.value; render(); } },
    'sess-filter': el => {
      if ((el.name === 'from' || el.name === 'to') && !el.value) return;
      state.sess[el.name] = el.value;
      state.sess.page = 0;
      render();
    },
  };

  $('#view').addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
  });
  $('#view').addEventListener('change', e => {
    const el = e.target.closest('[data-change]');
    if (el && changeActions[el.dataset.change]) changeActions[el.dataset.change](el);
  });
  $('#view').addEventListener('input', e => {
    if (e.target.dataset && e.target.dataset.input === 'emp-search') { state.empSearch = e.target.value; applyEmpSearch(); }
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
    state.key = null;
    state.renderSeq++;
    closeModal();
    showLogin(msg);
  }

  $('#logoutBtn').addEventListener('click', () => signOut(''));

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const key = $('#loginKey').value.trim();
    if (!key) return;
    const btn = $('#loginForm button');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
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
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  const saved = loadKey();
  if (saved) { state.key = saved; showApp(); } else { showLogin(''); }
})();
