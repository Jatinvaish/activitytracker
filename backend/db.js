const { createClient } = require('@supabase/supabase-js');

const APP_TZ              = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const SESSION_STATUSES    = ['active', 'idle'];
const ADJUSTMENT_STATUSES = ['pending', 'approved', 'rejected'];

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

function check(error, label) {
  if (!error) return;
  if (error.code === '22P02') throw new HttpError(400, 'Invalid id');
  if (error.code === '23514') throw new HttpError(409, 'The database rejected this value. Run backend/migrations_002.sql in the Supabase SQL editor.');
  throw new HttpError(500, `${label}: ${error.message}`);
}

function sessionRow({ start_time, end_time, status }) {
  const s = new Date(start_time), e = new Date(end_time);
  if (!start_time || !end_time || isNaN(s) || isNaN(e)) throw new HttpError(400, 'Valid start and end times are required');
  if (e <= s) throw new HttpError(400, 'End time must be after start time');
  if (!SESSION_STATUSES.includes(status)) throw new HttpError(400, 'Status must be active or idle');
  return {
    date:          localDate(s),
    start_time:    s.toISOString(),
    end_time:      e.toISOString(),
    duration_mins: Math.round((e - s) / 60000),
    status,
  };
}

// ── Desktop app ───────────────────────────────────────────────────────────────

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

  const sessionId = sessions?.[0]?.id || null;

  const { data, error } = await db()
    .from('adjustments')
    .insert({
      session_id:  sessionId,
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

// ── Admin console ─────────────────────────────────────────────────────────────

async function adminListUsers() {
  const { data: users, error } = await db().from('users').select('id, name, created_at').order('name');
  check(error, 'listUsers');
  return Promise.all(users.map(async u => {
    const [countRes, lastRes] = await Promise.all([
      db().from('sessions').select('id', { count: 'exact', head: true }).eq('user_id', u.id),
      db().from('sessions').select('end_time').eq('user_id', u.id).order('end_time', { ascending: false }).limit(1),
    ]);
    check(countRes.error, 'countSessions');
    check(lastRes.error, 'lastSeen');
    return { ...u, total_sessions: countRes.count || 0, last_seen: lastRes.data[0]?.end_time || null };
  }));
}

async function adminDeleteUser(id) {
  const { error } = await db().from('users').delete().eq('id', id);
  check(error, 'deleteUser');
}

async function adminListSessions({ userId, from, to, status, limit, offset }) {
  let q = db().from('sessions').select('*, users(name)', { count: 'exact' });
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

async function mergedSessionRow(id, changes) {
  const current = await getSession(id);
  return sessionRow({
    start_time: changes.start_time ?? current.start_time,
    end_time:   changes.end_time   ?? current.end_time,
    status:     changes.status     ?? current.status,
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

async function adminListAdjustments({ status, userId }) {
  let q = db()
    .from('adjustments')
    .select('*, users(name), sessions(id, date, start_time, end_time, duration_mins, status)')
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

module.exports = {
  APP_TZ,
  HttpError,
  upsertUser, insertSession, insertAdjustment, getUserSessions, getPendingAdjustments,
  adminListUsers, adminDeleteUser,
  adminListSessions, adminCreateSession, adminUpdateSession, adminDeleteSession,
  adminListAdjustments, adminUpdateAdjustment,
};
