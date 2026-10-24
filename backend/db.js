const { createClient } = require('@supabase/supabase-js');

const APP_TZ              = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const SESSION_STATUSES    = ['active', 'idle', 'away'];
const CATEGORIES          = ['meeting', 'break', 'lunch', 'other'];
const ADJUSTMENT_STATUSES = ['pending', 'approved', 'rejected'];
const DEVICE_STATUSES     = ['pending', 'approved', 'rejected', 'revoked'];
const LEAVE_TYPES         = ['leave', 'sick', 'half_day', 'wfh'];
const APP_CATEGORIES      = ['productive', 'neutral', 'unproductive'];
const UUID_RE             = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE             = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let _client;
function db() {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY,
      { auth: { persistSession: false } }
    );
  }
  return _client;
}

// Calendar day in the business timezone — a UTC date puts early-morning IST work on the previous day
function localDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const MIGRATION_HINT = 'The database needs an update. Run backend/migrations_003.sql in the Supabase SQL editor.';

function check(error, label) {
  if (!error) return;
  if (error.code === '22P02') throw new HttpError(400, 'Invalid id');
  if (error.code === '23505') throw new HttpError(409, 'That already exists');
  if (error.code === '23514') throw new HttpError(409, 'The database rejected this value. ' + MIGRATION_HINT);
  if (['42P01', '42703', 'PGRST204', 'PGRST205', 'PGRST200'].includes(error.code)) throw new HttpError(503, MIGRATION_HINT);
  throw new HttpError(500, `${label}: ${error.message}`);
}

function requireUuid(id, what) {
  if (!UUID_RE.test(String(id || ''))) throw new HttpError(400, `Invalid ${what || 'id'}`);
  return id;
}

// ── Settings ──────────────────────────────────────────────────────────────────

const SETTINGS_SPEC = {
  idle_threshold_mins:       { type: 'int',  min: 1,  max: 60,  def: 5 },
  prompt_after_idle_mins:    { type: 'int',  min: 0,  max: 240, def: 10 },
  daily_goal_mins:           { type: 'int',  min: 30, max: 960, def: 480 },
  shift_start:               { type: 'time', def: '09:30' },
  shift_end:                 { type: 'time', def: '18:30' },
  late_grace_mins:           { type: 'int',  min: 0,  max: 180, def: 15 },
  workdays:                  { type: 'days', def: [1, 2, 3, 4, 5] },
  meeting_detection:         { type: 'bool', def: true },
  app_tracking:              { type: 'bool', def: true },
  screenshots_enabled:       { type: 'bool', def: false },
  screenshot_interval_mins:  { type: 'int',  min: 5,  max: 60,  def: 10 },
  screenshot_blur:           { type: 'bool', def: false },
  screenshot_retention_days: { type: 'int',  min: 1,  max: 365, def: 30 },
  end_of_day_summary:        { type: 'bool', def: true },
};
const DEFAULT_SETTINGS = Object.fromEntries(Object.entries(SETTINGS_SPEC).map(([k, s]) => [k, s.def]));

// allowNull: per-employee overrides use null to mean "use the company default"
function cleanSettings(input, allowNull) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Settings must be an object');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const spec = SETTINGS_SPEC[key];
    if (!spec) throw new HttpError(400, `Unknown setting: ${key}`);
    if (value === null) {
      if (!allowNull) throw new HttpError(400, `${key} cannot be empty`);
      out[key] = null;
      continue;
    }
    if (spec.type === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) throw new HttpError(400, `${key} must be a whole number from ${spec.min} to ${spec.max}`);
      out[key] = n;
    } else if (spec.type === 'bool') {
      if (typeof value !== 'boolean') throw new HttpError(400, `${key} must be true or false`);
      out[key] = value;
    } else if (spec.type === 'time') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new HttpError(400, `${key} must be a time like 09:30`);
      out[key] = value;
    } else if (spec.type === 'days') {
      if (!Array.isArray(value) || value.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(400, `${key} must be a list of weekdays 0–6`);
      out[key] = [...new Set(value)].sort();
    }
  }
  return out;
}

let globalCache = null, globalCacheAt = 0;
async function getGlobalSettings() {
  if (globalCache && Date.now() - globalCacheAt < 30_000) return globalCache;
  const { data, error } = await db().from('app_settings').select('value').eq('key', 'global').maybeSingle();
  check(error, 'getSettings');
  globalCache = { ...DEFAULT_SETTINGS, ...(data ? data.value : {}) };
  globalCacheAt = Date.now();
  return globalCache;
}

async function setGlobalSettings(input) {
  const clean = cleanSettings(input, false);
  const current = await getGlobalSettings();
  const value = { ...current, ...clean };
  const { error } = await db().from('app_settings').upsert({ key: 'global', value, updated_at: new Date().toISOString() });
  check(error, 'setSettings');
  globalCache = null;
  return value;
}

async function effectiveSettings(user) {
  const global = await getGlobalSettings();
  const overrides = Object.fromEntries(Object.entries((user && user.settings) || {}).filter(([k, v]) => v !== null && k in SETTINGS_SPEC));
  return { ...global, ...overrides };
}

// ── Session rows ──────────────────────────────────────────────────────────────

function sessionRow({ start_time, end_time, status, category, project_id, note }) {
  const s = new Date(start_time), e = new Date(end_time);
  if (!start_time || !end_time || isNaN(s) || isNaN(e)) throw new HttpError(400, 'Valid start and end times are required');
  if (e <= s) throw new HttpError(400, 'End time must be after start time');
  if (!SESSION_STATUSES.includes(status)) throw new HttpError(400, 'Status must be active, idle or away');
  if (category && !CATEGORIES.includes(category)) throw new HttpError(400, 'Category must be meeting, break, lunch or other');
  if (project_id) requireUuid(project_id, 'project');
  return {
    date:          localDate(s),
    start_time:    s.toISOString(),
    end_time:      e.toISOString(),
    duration_mins: Math.round((e - s) / 60000),
    status,
    category:      category || null,
    project_id:    project_id || null,
    note:          (typeof note === 'string' && note.trim()) ? note.trim().slice(0, 500) : null,
    is_open:       false,
    updated_at:    new Date().toISOString(),
  };
}

// ── Desktop app (v1 endpoints, kept for installs that have not updated yet) ───

async function upsertUser(name) {
  const { data, error } = await db()
    .from('users')
    .upsert({ name }, { onConflict: 'name' })
    .select()
    .single();
  if (error) throw new Error(`upsertUser: ${error.message}`);
  return data;
}

async function insertSession({ username, startTime, endTime, duration, status }) {
  const user = await upsertUser(username);
  const { data, error } = await db()
    .from('sessions')
    .insert({
      user_id:       user.id,
      date:          localDate(new Date(startTime)),
      start_time:    startTime,
      end_time:      endTime,
      duration_mins: duration || 0,
      status,
    })
    .select()
    .single();
  if (error) throw new Error(`insertSession: ${error.message}`);
  return data;
}

async function insertAdjustment({ username, startTime, note }) {
  const user = await upsertUser(username);

  const { data: sessions, error: sErr } = await db()
    .from('sessions')
    .select('id')
    .eq('user_id', user.id)
    .lte('start_time', startTime)
    .gte('end_time',   startTime)
    .limit(1);

  if (sErr) throw new Error(`findSession: ${sErr.message}`);

  const { data, error } = await db()
    .from('adjustments')
    .insert({
      session_id:  sessions?.[0]?.id || null,
      user_id:     user.id,
      note,
      owner_notes: null,
      status:      'pending',
    })
    .select()
    .single();
  if (error) throw new Error(`insertAdjustment: ${error.message}`);
  return data;
}

async function getUserSessions(username, date) {
  const user = await upsertUser(username);
  const { data, error } = await db()
    .from('sessions')
    .select('*, adjustments(*)')
    .eq('user_id', user.id)
    .eq('date', date)
    .order('start_time', { ascending: true });
  if (error) throw new Error(`getUserSessions: ${error.message}`);
  return data;
}

async function getPendingAdjustments() {
  const { data, error } = await db()
    .from('adjustments')
    .select('*, users(name), sessions(date, start_time, end_time, status)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getPendingAdjustments: ${error.message}`);
  return data;
}

// ── Admin: employees ──────────────────────────────────────────────────────────

async function adminListUsers() {
  const { data: users, error } = await db().from('users').select('id, name, created_at, settings').order('name');
  check(error, 'listUsers');
  const { data: devices, error: dErr } = await db().from('devices').select('user_id, last_seen_at, status');
  check(dErr, 'listDevices');
  return Promise.all(users.map(async u => {
    const [countRes, lastRes] = await Promise.all([
      db().from('sessions').select('id', { count: 'exact', head: true }).eq('user_id', u.id),
      db().from('sessions').select('end_time').eq('user_id', u.id).order('end_time', { ascending: false }).limit(1),
    ]);
    check(countRes.error, 'countSessions');
    check(lastRes.error, 'lastSeen');
    const own = devices.filter(d => d.user_id === u.id);
    const seen = [lastRes.data[0]?.end_time, ...own.map(d => d.last_seen_at)].filter(Boolean).sort().pop() || null;
    return {
      ...u,
      total_sessions:  countRes.count || 0,
      last_seen:       seen,
      devices:         own.length,
      pending_devices: own.filter(d => d.status === 'pending').length,
    };
  }));
}

async function adminUpdateUser(id, { name, settings }) {
  requireUuid(id);
  const update = {};
  if (name !== undefined) {
    const clean = String(name || '').trim();
    if (!clean || clean.length > 60) throw new HttpError(400, 'Name must be 1–60 characters');
    update.name = clean;
  }
  if (settings !== undefined) {
    const { data: user, error } = await db().from('users').select('settings').eq('id', id).maybeSingle();
    check(error, 'getUser');
    if (!user) throw new HttpError(404, 'Employee not found');
    const merged = { ...(user.settings || {}), ...cleanSettings(settings, true) };
    update.settings = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null));
  }
  if (!Object.keys(update).length) throw new HttpError(400, 'Nothing to update');
  const { data, error } = await db().from('users').update(update).eq('id', id).select().maybeSingle();
  if (error && error.code === '23505') throw new HttpError(409, 'Another employee already has that name');
  check(error, 'updateUser');
  if (!data) throw new HttpError(404, 'Employee not found');
  return data;
}

const USER_DATA_TABLES = ['sessions', 'adjustments', 'devices', 'activity_slots', 'app_usage', 'screenshots'];

async function adminMergeUsers(fromId, intoId) {
  requireUuid(fromId); requireUuid(intoId, 'target employee');
  if (fromId === intoId) throw new HttpError(400, 'Choose a different employee to merge into');
  const { data: target, error } = await db().from('users').select('id').eq('id', intoId).maybeSingle();
  check(error, 'getUser');
  if (!target) throw new HttpError(404, 'Target employee not found');
  for (const table of USER_DATA_TABLES) {
    const { error: mErr } = await db().from(table).update({ user_id: intoId }).eq('user_id', fromId);
    check(mErr, 'merge ' + table);
  }
  const { error: dErr } = await db().from('users').delete().eq('id', fromId);
  check(dErr, 'deleteUser');
}

async function adminDeleteUser(id, removeImages) {
  requireUuid(id);
  const { data: shots, error } = await db().from('screenshots').select('path').eq('user_id', id);
  check(error, 'listScreenshots');
  if (shots.length) await removeImages(shots.map(s => s.path));
  const { error: dErr } = await db().from('users').delete().eq('id', id);
  check(dErr, 'deleteUser');
}

// ── Admin: devices & live status ──────────────────────────────────────────────

async function adminListDevices({ userId } = {}) {
  let q = db().from('devices')
    .select('id, user_id, status, hostname, platform, app_version, consent_version, consent_at, created_at, last_seen_at, live_status, live_category, live_since, live_app, live_project_id, users(name)')
    .order('last_seen_at', { ascending: false, nullsFirst: false });
  if (userId) q = q.eq('user_id', requireUuid(userId, 'employee'));
  const { data, error } = await q;
  check(error, 'listDevices');
  return data;
}

async function adminUpdateDevice(id, { status, user_id }) {
  requireUuid(id);
  const { data: device, error } = await db().from('devices').select('*').eq('id', id).maybeSingle();
  check(error, 'getDevice');
  if (!device) throw new HttpError(404, 'Device not found');

  if (status !== undefined) {
    if (!DEVICE_STATUSES.includes(status)) throw new HttpError(400, 'Invalid device status');
    // Revoked/rejected devices lose their token so they can no longer send data
    const update = { status };
    if (status === 'revoked' || status === 'rejected') update.token_hash = null;
    const { error: uErr } = await db().from('devices').update(update).eq('id', id);
    check(uErr, 'updateDevice');
  }

  if (user_id !== undefined && user_id !== device.user_id) {
    requireUuid(user_id, 'employee');
    const { data: target, error: tErr } = await db().from('users').select('id').eq('id', user_id).maybeSingle();
    check(tErr, 'getUser');
    if (!target) throw new HttpError(404, 'Employee not found');
    for (const table of ['devices', 'sessions', 'activity_slots', 'app_usage', 'screenshots']) {
      const col = table === 'devices' ? 'id' : 'device_id';
      const { error: mErr } = await db().from(table).update({ user_id }).eq(col, id);
      check(mErr, 'move ' + table);
    }
  }

  const { data, error: fErr } = await db().from('devices').select('*, users(name)').eq('id', id).single();
  check(fErr, 'getDevice');
  delete data.token_hash;
  return data;
}

async function adminDeleteDevice(id) {
  requireUuid(id);
  const { data: device, error } = await db().from('devices').select('status').eq('id', id).maybeSingle();
  check(error, 'getDevice');
  if (!device) throw new HttpError(404, 'Device not found');
  if (!['pending', 'rejected'].includes(device.status)) throw new HttpError(409, 'Only pending or rejected computers can be deleted. Revoke this one instead.');
  const { error: dErr } = await db().from('devices').delete().eq('id', id);
  check(dErr, 'deleteDevice');
}

// ── Admin: sessions ───────────────────────────────────────────────────────────

async function adminListSessions({ userId, from, to, status, limit, offset }) {
  let q = db().from('sessions').select('*, users(name), projects(name)', { count: 'exact' });
  if (userId) q = q.eq('user_id', userId);
  if (from)   q = q.gte('start_time', from);
  if (to)     q = q.lt('start_time', to);
  if (status) q = q.eq('status', status);
  const { data, error, count } = await q
    .order('start_time', { ascending: false })
    .range(offset, offset + limit - 1);
  check(error, 'listSessions');
  return { sessions: data, total: count ?? data.length };
}

async function getSession(id) {
  const { data, error } = await db().from('sessions').select('*').eq('id', id).maybeSingle();
  check(error, 'getSession');
  if (!data) throw new HttpError(404, 'Session not found');
  return data;
}

function pick(changes, current, key) { return changes[key] !== undefined ? changes[key] : current[key]; }

async function mergedSessionRow(id, changes) {
  const current = await getSession(id);
  return sessionRow({
    start_time: pick(changes, current, 'start_time'),
    end_time:   pick(changes, current, 'end_time'),
    status:     pick(changes, current, 'status'),
    category:   pick(changes, current, 'category'),
    project_id: pick(changes, current, 'project_id'),
    note:       pick(changes, current, 'note'),
  });
}

async function adminCreateSession({ user_id, ...fields }) {
  if (!user_id) throw new HttpError(400, 'Employee is required');
  const { data, error } = await db()
    .from('sessions')
    .insert({ user_id, ...sessionRow(fields) })
    .select()
    .single();
  check(error, 'createSession');
  return data;
}

async function adminUpdateSession(id, changes) {
  const row = await mergedSessionRow(id, changes);
  const { data, error } = await db().from('sessions').update(row).eq('id', id).select().single();
  check(error, 'updateSession');
  return data;
}

async function adminDeleteSession(id) {
  const { error } = await db().from('sessions').delete().eq('id', id);
  check(error, 'deleteSession');
}

// ── Admin: adjustments ────────────────────────────────────────────────────────

async function adminListAdjustments({ status, userId }) {
  let q = db()
    .from('adjustments')
    .select('*, users(name), sessions(id, date, start_time, end_time, duration_mins, status, category)')
    .order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  if (userId) q = q.eq('user_id', userId);
  const { data, error } = await q;
  check(error, 'listAdjustments');
  return data;
}

async function adminUpdateAdjustment(id, { status, owner_notes, session }) {
  if (!ADJUSTMENT_STATUSES.includes(status)) throw new HttpError(400, 'Status must be pending, approved or rejected');

  const { data: adj, error } = await db().from('adjustments').select('*').eq('id', id).maybeSingle();
  check(error, 'getAdjustment');
  if (!adj) throw new HttpError(404, 'Adjustment not found');

  // Validate session changes before writing anything
  let sessionChange = null;
  if (session && status === 'approved') {
    sessionChange = adj.session_id
      ? { id: adj.session_id, row: await mergedSessionRow(adj.session_id, session) }
      : { id: null, row: sessionRow(session) };
  }

  // Status first: if the DB rejects it, the session is left untouched
  const { data, error: aErr } = await db()
    .from('adjustments')
    .update({
      status,
      owner_notes: typeof owner_notes === 'string' ? (owner_notes.trim() || null) : adj.owner_notes,
      resolved_at: status === 'pending' ? null : new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
  check(aErr, 'updateAdjustment');

  if (!sessionChange) return data;

  if (sessionChange.id) {
    const { error: uErr } = await db().from('sessions').update(sessionChange.row).eq('id', sessionChange.id);
    check(uErr, 'applySession');
    return data;
  }

  const { data: created, error: cErr } = await db()
    .from('sessions')
    .insert({ user_id: adj.user_id, ...sessionChange.row })
    .select('id')
    .single();
  check(cErr, 'createSession');
  const { data: linked, error: lErr } = await db()
    .from('adjustments')
    .update({ session_id: created.id })
    .eq('id', id)
    .select()
    .single();
  check(lErr, 'linkSession');
  return linked;
}

// ── Admin: activity, apps, screenshots ────────────────────────────────────────

async function adminListActivity({ userId, from, to }) {
  const { data, error } = await db().from('activity_slots')
    .select('device_id, slot_start, active_secs, total_secs')
    .eq('user_id', requireUuid(userId, 'employee'))
    .gte('slot_start', from).lt('slot_start', to)
    .order('slot_start')
    .limit(5000);
  check(error, 'listActivity');
  return data;
}

async function adminListApps({ userId, from, to }) {
  let q = db().from('app_usage').select('user_id, device_id, hour_start, app, label, seconds')
    .gte('hour_start', from).lt('hour_start', to)
    .order('hour_start')
    .limit(10000);
  if (userId) q = q.eq('user_id', requireUuid(userId, 'employee'));
  const { data, error } = await q;
  check(error, 'listApps');
  return data;
}

async function adminListAppCategories() {
  const { data, error } = await db().from('app_categories').select('*').order('pattern');
  check(error, 'listAppCategories');
  return data;
}

async function adminSetAppCategory({ pattern, category }) {
  const clean = String(pattern || '').trim().toLowerCase();
  if (!clean || clean.length > 80) throw new HttpError(400, 'Pattern must be 1–80 characters');
  if (!APP_CATEGORIES.includes(category)) throw new HttpError(400, 'Category must be productive, neutral or unproductive');
  const { data, error } = await db().from('app_categories').upsert({ pattern: clean, category }).select().single();
  check(error, 'setAppCategory');
  return data;
}

async function adminDeleteAppCategory(pattern) {
  const { error } = await db().from('app_categories').delete().eq('pattern', String(pattern || '').toLowerCase());
  check(error, 'deleteAppCategory');
}

async function adminListScreenshots({ userId, from, to }) {
  const { data, error } = await db().from('screenshots')
    .select('id, device_id, user_id, taken_at, display, path, blurred, activity_pct, app')
    .eq('user_id', requireUuid(userId, 'employee'))
    .gte('taken_at', from).lt('taken_at', to)
    .order('taken_at')
    .limit(500);
  check(error, 'listScreenshots');
  return data;
}

async function getScreenshot(id) {
  const { data, error } = await db().from('screenshots').select('id, path').eq('id', requireUuid(id)).maybeSingle();
  check(error, 'getScreenshot');
  if (!data) throw new HttpError(404, 'Screenshot not found');
  return data;
}

async function deleteScreenshotRow(id) {
  const { error } = await db().from('screenshots').delete().eq('id', id);
  check(error, 'deleteScreenshot');
}

// ── Admin: projects ───────────────────────────────────────────────────────────

function cleanProject({ name, client, archived }, partial) {
  const row = {};
  if (name !== undefined || !partial) {
    const n = String(name || '').trim();
    if (!n || n.length > 80) throw new HttpError(400, 'Project name must be 1–80 characters');
    row.name = n;
  }
  if (client !== undefined) row.client = String(client || '').trim().slice(0, 80) || null;
  if (archived !== undefined) {
    if (typeof archived !== 'boolean') throw new HttpError(400, 'archived must be true or false');
    row.archived = archived;
  }
  return row;
}

async function listProjects({ includeArchived } = {}) {
  let q = db().from('projects').select('id, name, client, archived, created_at').order('name');
  if (!includeArchived) q = q.eq('archived', false);
  const { data, error } = await q;
  check(error, 'listProjects');
  return data;
}

async function adminCreateProject(body) {
  const { data, error } = await db().from('projects').insert(cleanProject(body, false)).select().single();
  check(error, 'createProject');
  return data;
}

async function adminUpdateProject(id, body) {
  const row = cleanProject(body, true);
  if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to update');
  const { data, error } = await db().from('projects').update(row).eq('id', requireUuid(id)).select().maybeSingle();
  check(error, 'updateProject');
  if (!data) throw new HttpError(404, 'Project not found');
  return data;
}

// ── Admin: daily summary (attendance, payroll, project time) ──────────────────

function tzOffsetMs(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
}

function zonedStartOfDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  return new Date(guess - tzOffsetMs(new Date(guess)));
}

// Worked = active + meetings; breaks and lunch are their own bucket, never idle
function bucketOf(s) {
  if (s.category === 'meeting') return 'meeting';
  if (s.category === 'break' || s.category === 'lunch') return 'break';
  if (s.status === 'active') return 'active';
  if (s.status === 'away') return 'away';
  return 'idle';
}

async function adminSummary({ from, to, userId }) {
  requireDate(from, 'from date'); requireDate(to, 'to date');
  if (to < from) throw new HttpError(400, 'to must be on or after from');
  const start = zonedStartOfDay(from);
  const end = new Date(zonedStartOfDay(to).getTime() + 86400_000 + 3600_000);
  if (end - start > 100 * 86400_000) throw new HttpError(400, 'Range is limited to 100 days');

  const rows = [];
  for (let offset = 0; offset < 200_000; offset += 1000) {
    let q = db().from('sessions')
      .select('user_id, start_time, end_time, status, category, project_id, activity_pct, is_open, updated_at')
      .gte('start_time', start.toISOString()).lt('start_time', end.toISOString())
      .order('start_time').range(offset, offset + 999);
    if (userId) q = q.eq('user_id', requireUuid(userId, 'employee'));
    const { data, error } = await q;
    check(error, 'summary');
    rows.push(...data);
    if (data.length < 1000) break;
  }

  const days = new Map(), projects = new Map();
  const staleBefore = Date.now() - 6 * 60_000;
  for (const s of rows) {
    const date = localDate(new Date(s.start_time));
    if (date < from || date > to) continue;
    const ms = Math.max(0, new Date(s.end_time) - new Date(s.start_time));
    const key = s.user_id + '|' + date;
    let d = days.get(key);
    if (!d) {
      d = { user_id: s.user_id, date, first_in: null, last_out: null, active: 0, meeting: 0, idle: 0, break: 0, away: 0, act_w: 0, act_ms: 0, sessions: 0, live: false, stale: false };
      days.set(key, d);
    }
    const b = bucketOf(s);
    d[b] += ms;
    d.sessions++;
    if ((b === 'active' || b === 'meeting') && (!d.first_in || s.start_time < d.first_in)) d.first_in = s.start_time;
    if (!d.last_out || s.end_time > d.last_out) d.last_out = s.end_time;
    if (s.status === 'active' && s.activity_pct !== null && s.activity_pct !== undefined) { d.act_w += s.activity_pct * ms; d.act_ms += ms; }
    if (s.is_open) {
      if (new Date(s.updated_at).getTime() < staleBefore) d.stale = true; else d.live = true;
    }
    if (s.project_id && (b === 'active' || b === 'meeting')) {
      const pk = s.project_id + '|' + s.user_id;
      projects.set(pk, (projects.get(pk) || 0) + ms);
    }
  }

  const min = ms => Math.round(ms / 60000);
  return {
    timezone: APP_TZ,
    days: [...days.values()].map(d => ({
      user_id: d.user_id, date: d.date, first_in: d.first_in, last_out: d.last_out,
      worked_mins: min(d.active + d.meeting), active_mins: min(d.active), meeting_mins: min(d.meeting),
      idle_mins: min(d.idle), break_mins: min(d.break), away_mins: min(d.away),
      activity_pct: d.act_ms ? Math.round(d.act_w / d.act_ms) : null,
      sessions: d.sessions, live: d.live, stale: d.stale,
    })),
    projects: [...projects.entries()].map(([k, ms]) => {
      const [project_id, user_id] = k.split('|');
      return { project_id, user_id, worked_mins: min(ms) };
    }),
  };
}

// ── Admin: leave & holidays ───────────────────────────────────────────────────

function requireDate(d, what) {
  if (!DATE_RE.test(String(d || '')) || isNaN(Date.parse(d))) throw new HttpError(400, `Invalid ${what || 'date'}`);
  return d;
}

async function adminListLeaves({ from, to }) {
  requireDate(from, 'from date'); requireDate(to, 'to date');
  const [lRes, hRes] = await Promise.all([
    db().from('leaves').select('*').gte('date', from).lte('date', to).order('date'),
    db().from('holidays').select('*').gte('date', from).lte('date', to).order('date'),
  ]);
  check(lRes.error, 'listLeaves');
  check(hRes.error, 'listHolidays');
  return { leaves: lRes.data, holidays: hRes.data };
}

async function adminSetLeave({ user_id, date, type, note }) {
  requireUuid(user_id, 'employee'); requireDate(date);
  if (!LEAVE_TYPES.includes(type)) throw new HttpError(400, 'Leave type must be leave, sick, half_day or wfh');
  const { data, error } = await db().from('leaves')
    .upsert({ user_id, date, type, note: String(note || '').trim().slice(0, 200) || null })
    .select().single();
  check(error, 'setLeave');
  return data;
}

async function adminDeleteLeave(userId, date) {
  const { error } = await db().from('leaves').delete().eq('user_id', requireUuid(userId, 'employee')).eq('date', requireDate(date));
  check(error, 'deleteLeave');
}

async function adminSetHoliday({ date, name }) {
  requireDate(date);
  const n = String(name || '').trim();
  if (!n || n.length > 80) throw new HttpError(400, 'Holiday name must be 1–80 characters');
  const { data, error } = await db().from('holidays').upsert({ date, name: n }).select().single();
  check(error, 'setHoliday');
  return data;
}

async function adminDeleteHoliday(date) {
  const { error } = await db().from('holidays').delete().eq('date', requireDate(date));
  check(error, 'deleteHoliday');
}

module.exports = {
  APP_TZ, HttpError, db, check, localDate, requireUuid, UUID_RE,
  SESSION_STATUSES, CATEGORIES, SETTINGS_SPEC, DEFAULT_SETTINGS,
  cleanSettings, getGlobalSettings, setGlobalSettings, effectiveSettings,
  upsertUser, insertSession, insertAdjustment, getUserSessions, getPendingAdjustments,
  adminListUsers, adminUpdateUser, adminMergeUsers, adminDeleteUser,
  adminListDevices, adminUpdateDevice, adminDeleteDevice,
  adminListSessions, adminCreateSession, adminUpdateSession, adminDeleteSession,
  adminListAdjustments, adminUpdateAdjustment,
  adminListActivity, adminListApps, adminListAppCategories, adminSetAppCategory, adminDeleteAppCategory,
  adminListScreenshots, getScreenshot, deleteScreenshotRow,
  listProjects, adminCreateProject, adminUpdateProject, adminSummary,
  adminListLeaves, adminSetLeave, adminDeleteLeave, adminSetHoliday, adminDeleteHoliday,
};
