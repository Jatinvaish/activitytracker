const express = require('express');
const crypto  = require('crypto');
const {
  db, HttpError, check, localDate, requireUuid, UUID_RE,
  SESSION_STATUSES, CATEGORIES, effectiveSettings, listProjects, APP_TZ,
} = require('./db');
const storage = require('./storage');
const mailer  = require('./mailer');

const router = express.Router();

const LIVE_STATUSES = ['active', 'idle', 'away', 'break', 'meeting'];

const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
const newToken  = () => crypto.randomBytes(32).toString('base64url');
const str       = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clampInt  = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : lo);
const list      = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  if (!err.status || err.status >= 500) console.error('Device API error:', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

function notifyOwner(subject, lines) {
  mailer.send({ to: process.env.SMTP_USER, subject, body: lines.join('\n') })
    .catch(err => console.error('Owner email failed:', err.message));
}

function fmtLocal(d) {
  return new Date(d).toLocaleString('en-GB', { timeZone: APP_TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// The shared secret only gates registration; every later call uses the device's own token
function secretAuth(req, res, next) {
  if (!process.env.API_SECRET || req.headers['x-api-secret'] !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function deviceAuth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'Missing device token' });
  try {
    const { data, error } = await db().from('devices')
      .select('*, users(id, name, settings)')
      .eq('token_hash', hashToken(m[1]))
      .maybeSingle();
    check(error, 'authDevice');
    if (!data || data.status !== 'approved') return res.status(401).json({ error: 'This computer is not authorised' });
    req.device = data;
    req.user = data.users;
    next();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

router.post('/register', secretAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const deviceId = requireUuid(b.device_id, 'device id');
  const name = str(b.name, 60);
  if (!name) throw new HttpError(400, 'Name is required');
  const now = new Date().toISOString();
  const meta = { hostname: str(b.hostname, 80) || null, platform: str(b.platform, 20) || null, app_version: str(b.app_version, 20) || null };
  const consentVersion = Number.isInteger(b.consent_version) ? b.consent_version : null;

  const { data: existing, error } = await db().from('devices').select('*, users(id, name)').eq('id', deviceId).maybeSingle();
  check(error, 'getDevice');

  if (existing) {
    const update = { ...meta };
    if (consentVersion && consentVersion !== existing.consent_version) Object.assign(update, { consent_version: consentVersion, consent_at: now });
    let token = null;
    if (existing.status === 'approved') {
      token = newToken();
      update.token_hash = hashToken(token);
    }
    const { error: uErr } = await db().from('devices').update(update).eq('id', deviceId);
    check(uErr, 'updateDevice');
    return res.json({ status: existing.status, token, user: existing.users });
  }

  const { data: user, error: uErr } = await db().from('users').upsert({ name }, { onConflict: 'name' }).select('id, name').single();
  check(uErr, 'upsertUser');

  // An employee's first computer is trusted; any further one waits for the owner, so nobody can log time as someone else
  const { count, error: cErr } = await db().from('devices')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id).eq('status', 'approved');
  check(cErr, 'countDevices');
  const approved = !count;
  const token = approved ? newToken() : null;

  const { error: iErr } = await db().from('devices').insert({
    id: deviceId,
    user_id: user.id,
    status: approved ? 'approved' : 'pending',
    token_hash: token ? hashToken(token) : null,
    ...meta,
    consent_version: consentVersion,
    consent_at: consentVersion ? now : null,
  });
  check(iErr, 'createDevice');

  if (!approved) {
    notifyOwner(`New computer waiting for approval — ${user.name}`, [
      `${user.name} started Activity Tracker on another computer.`,
      `Computer: ${meta.hostname || 'unknown'} (${meta.platform || 'unknown'}), app ${meta.app_version || '?'}`,
      ``,
      `Its time is being recorded on that computer and will upload once you approve it.`,
      `Approve or reject it: https://${req.get('host')}/admin#employee/${user.id}`,
    ]);
  }

  res.json({ status: approved ? 'approved' : 'pending', token, user });
}));

// ── Sync: live status + everything recorded since the last successful call ───

function dedupe(rows, keyFn) {
  const map = new Map();
  rows.forEach(r => map.set(keyFn(r), r));
  return [...map.values()];
}

router.post('/sync', deviceAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const { device, user } = req;
  const now = Date.now();
  const cursor = new Date(now).toISOString();
  const settings = await effectiveSettings(user);

  // A wrong computer clock would misplace every segment; shift client times onto server time
  const clientNow = Date.parse(b.client_now);
  const skew = isNaN(clientNow) ? 0 : now - clientNow;
  const fix = Math.abs(skew) > 120_000 ? skew : 0;
  const t = v => { const ms = Date.parse(v); return isNaN(ms) ? null : new Date(ms + fix); };

  const projects = await listProjects({ includeArchived: true });
  const projectIds = new Set(projects.map(p => p.id));
  let dropped = 0;

  const segments = dedupe(list(b.segments, 500).map(s => {
    const start = t(s && s.start_time), end = t(s && s.end_time);
    if (!s || !UUID_RE.test(String(s.client_id)) || !start || !end || end < start
        || end - start > 26 * 3600_000 || end.getTime() > now + 300_000 || !SESSION_STATUSES.includes(s.status)) {
      dropped++;
      return null;
    }
    return {
      device_id:     device.id,
      user_id:       user.id,
      client_id:     s.client_id,
      date:          localDate(start),
      start_time:    start.toISOString(),
      end_time:      end.toISOString(),
      duration_mins: Math.round((end - start) / 60000),
      status:        s.status,
      category:      CATEGORIES.includes(s.category) ? s.category : null,
      note:          str(s.note, 500) || null,
      project_id:    projectIds.has(s.project_id) ? s.project_id : null,
      activity_pct:  Number.isFinite(Number(s.activity_pct)) && s.activity_pct !== null ? clampInt(s.activity_pct, 0, 100) : null,
      end_reason:    str(s.end_reason, 20) || null,
      is_open:       s.is_open === true,
      updated_at:    cursor,
    };
  }).filter(Boolean), r => r.client_id);

  const activity = dedupe(list(b.activity, 2000).map(a => {
    const slot = t(a && a.slot_start);
    if (!slot) { dropped++; return null; }
    const total = clampInt(a.total_secs, 0, 600);
    return { device_id: device.id, user_id: user.id, slot_start: slot.toISOString(), total_secs: total, active_secs: clampInt(a.active_secs, 0, total) };
  }).filter(Boolean), r => r.slot_start);

  const apps = settings.app_tracking ? dedupe(list(b.apps, 3000).map(a => {
    const hour = t(a && a.hour_start);
    const app = str(a && a.app, 80);
    if (!hour || !app) { dropped++; return null; }
    return { device_id: device.id, user_id: user.id, hour_start: hour.toISOString(), app, label: str(a.label, 120), seconds: clampInt(a.seconds, 0, 3600) };
  }).filter(Boolean), r => `${r.hour_start}|${r.app}|${r.label}`) : [];

  if (segments.length) {
    const { error } = await db().from('sessions').upsert(segments, { onConflict: 'device_id,client_id' });
    check(error, 'syncSegments');
  }
  if (activity.length) {
    const { error } = await db().from('activity_slots').upsert(activity, { onConflict: 'device_id,slot_start' });
    check(error, 'syncActivity');
  }
  if (apps.length) {
    const { error } = await db().from('app_usage').upsert(apps, { onConflict: 'device_id,hour_start,app,label' });
    check(error, 'syncApps');
  }

  const live = b.live || {};
  const deviceUpdate = { last_seen_at: cursor, app_version: str(b.app_version, 20) || device.app_version };
  if (LIVE_STATUSES.includes(live.status)) {
    Object.assign(deviceUpdate, {
      live_status:     live.status,
      live_category:   CATEGORIES.includes(live.category) ? live.category : null,
      live_since:      t(live.since) ? t(live.since).toISOString() : cursor,
      live_app:        settings.app_tracking ? (str(live.app, 120) || null) : null,
      live_project_id: projectIds.has(live.project_id) ? live.project_id : null,
    });
  }
  const { error: dErr } = await db().from('devices').update(deviceUpdate).eq('id', device.id);
  check(dErr, 'updateLive');

  let decisions = [];
  if (b.decisions_since && !isNaN(Date.parse(b.decisions_since))) {
    const { data, error } = await db().from('adjustments')
      .select('id, note, status, owner_notes, resolved_at, sessions(start_time, end_time)')
      .eq('user_id', user.id)
      .in('status', ['approved', 'rejected'])
      .gt('resolved_at', b.decisions_since)
      .lte('resolved_at', cursor)
      .order('resolved_at');
    check(error, 'decisions');
    decisions = data;
  }

  storage.cleanupOldScreenshots();

  res.json({
    ok: true,
    server_time: new Date().toISOString(),
    decisions_cursor: cursor,
    clock_offset_ms: fix,
    user: { id: user.id, name: user.name },
    settings,
    projects: projects.filter(p => !p.archived).map(({ id, name, client }) => ({ id, name, client })),
    decisions,
    accepted: { segments: segments.length, activity: activity.length, apps: apps.length },
    dropped,
  });
}));

// ── The employee's own data ───────────────────────────────────────────────────

router.get('/me/sessions', deviceAuth, wrap(async (req, res) => {
  const from = Date.parse(req.query.from), to = Date.parse(req.query.to);
  if (isNaN(from) || isNaN(to) || to <= from) throw new HttpError(400, 'Valid from and to are required');
  if (to - from > 93 * 86400_000) throw new HttpError(400, 'Range is limited to 93 days');
  const { data, error } = await db().from('sessions')
    .select('id, client_id, device_id, start_time, end_time, duration_mins, status, category, note, project_id, activity_pct, is_open, adjustments(id, status, owner_notes, created_at)')
    .eq('user_id', req.user.id)
    .gte('start_time', new Date(from).toISOString())
    .lt('start_time', new Date(to).toISOString())
    .order('start_time')
    .limit(5000);
  check(error, 'mySessions');
  res.json({ sessions: data });
}));

router.get('/me/adjustments', deviceAuth, wrap(async (req, res) => {
  const { data, error } = await db().from('adjustments')
    .select('id, note, status, owner_notes, created_at, resolved_at, sessions(start_time, end_time, status, category, duration_mins)')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(200);
  check(error, 'myAdjustments');
  res.json({ adjustments: data });
}));

router.post('/adjustments', deviceAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const note = str(b.note, 1000);
  if (!note) throw new HttpError(400, 'Please describe the adjustment');

  let q = db().from('sessions').select('id, start_time, end_time, status, category, duration_mins');
  if (b.client_id) q = q.eq('device_id', req.device.id).eq('client_id', requireUuid(b.client_id, 'session'));
  else q = q.eq('user_id', req.user.id).eq('id', requireUuid(b.session_id, 'session'));
  const { data: session, error } = await q.maybeSingle();
  check(error, 'findSession');
  if (!session) throw new HttpError(409, 'This session has not uploaded yet. Try again in a minute.');

  const { data: open, error: oErr } = await db().from('adjustments')
    .select('id').eq('session_id', session.id).eq('status', 'pending').limit(1);
  check(oErr, 'findPending');
  if (open.length) throw new HttpError(409, 'You already have a pending request for this session.');

  const { data: adj, error: aErr } = await db().from('adjustments')
    .insert({ session_id: session.id, user_id: req.user.id, note, status: 'pending' })
    .select('id, note, status, owner_notes, created_at, resolved_at')
    .single();
  check(aErr, 'createAdjustment');

  notifyOwner(`Adjustment Request — ${req.user.name} — ${fmtLocal(session.start_time)}`, [
    `Employee: ${req.user.name}`,
    `Session: ${fmtLocal(session.start_time)} → ${fmtLocal(session.end_time)} (${session.duration_mins} mins, ${session.category || session.status})`,
    ``,
    `Request:`,
    note,
    ``,
    `Review it: https://${req.get('host')}/admin#adjustments`,
  ]);

  res.json({ ok: true, adjustment: { ...adj, sessions: session } });
}));

// ── Screenshots ───────────────────────────────────────────────────────────────

router.post('/screenshots', deviceAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const settings = await effectiveSettings(req.user);
  if (!settings.screenshots_enabled) return res.json({ ok: false, reason: 'disabled' });

  const takenAt = new Date(Date.parse(b.taken_at));
  if (isNaN(takenAt) || takenAt.getTime() > Date.now() + 300_000 || takenAt.getTime() < Date.now() - 7 * 86400_000) {
    return res.json({ ok: false, reason: 'out_of_range' });
  }
  const image = Buffer.from(String(b.image || ''), 'base64');
  if (image.length < 100 || image.length > 3_000_000 || image[0] !== 0xff || image[1] !== 0xd8) {
    throw new HttpError(400, 'Screenshot must be a JPEG under 3 MB');
  }
  const display = clampInt(b.display, 0, 9);
  const path = `${req.user.id}/${localDate(takenAt)}/${req.device.id}_${takenAt.getTime()}_${display}.jpg`;

  await storage.uploadImage(path, image);
  const { error } = await db().from('screenshots').upsert({
    device_id:    req.device.id,
    user_id:      req.user.id,
    taken_at:     takenAt.toISOString(),
    display,
    path,
    blurred:      b.blurred === true,
    activity_pct: Number.isFinite(Number(b.activity_pct)) && b.activity_pct !== null ? clampInt(b.activity_pct, 0, 100) : null,
    app:          settings.app_tracking ? (str(b.app, 80) || null) : null,
  }, { onConflict: 'device_id,taken_at,display' });
  check(error, 'saveScreenshot');
  res.json({ ok: true });
}));

module.exports = router;
