const { createClient } = require('@supabase/supabase-js');

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

// Upsert user by name, return user row
async function upsertUser(name) {
  const { data, error } = await db()
    .from('users')
    .upsert({ name }, { onConflict: 'name' })
    .select()
    .single();
  if (error) throw new Error(`upsertUser: ${error.message}`);
  return data;
}

// Insert a session row
async function insertSession({ username, startTime, endTime, duration, status }) {
  const user = await upsertUser(username);
  const { data, error } = await db()
    .from('sessions')
    .insert({
      user_id:       user.id,
      date:          new Date(startTime).toISOString().split('T')[0],
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

// Insert adjustment linked to session
async function insertAdjustment({ username, startTime, note }) {
  const user = await upsertUser(username);

  // Find the matching session
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

// Get all sessions for a user on a given date
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

// Get all pending adjustments (for owner dashboard)
async function getPendingAdjustments() {
  const { data, error } = await db()
    .from('adjustments')
    .select('*, users(name), sessions(date, start_time, end_time, status)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getPendingAdjustments: ${error.message}`);
  return data;
}

module.exports = { upsertUser, insertSession, insertAdjustment, getUserSessions, getPendingAdjustments };
