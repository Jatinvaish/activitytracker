const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const db      = require('./db');
const storage = require('./storage');

const router     = express.Router();
const PUBLIC_DIR = path.join(__dirname, 'public');

router.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
router.use('/assets', express.static(PUBLIC_DIR));

// Separate from API_SECRET, which ships inside the desktop app
function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return res.status(503).json({ error: 'ADMIN_KEY is not configured on the server' });
  const given = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const want  = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ error: 'Invalid admin key' });
  }
  next();
}

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  if (!err.status || err.status >= 500) console.error('Admin API error:', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

function isoParam(value, name, required) {
  if (value === undefined || value === '') {
    if (required) throw new db.HttpError(400, `${name} is required`);
    return undefined;
  }
  if (isNaN(Date.parse(value))) throw new db.HttpError(400, `Invalid ${name} date`);
  return value;
}

function range(req) {
  return { from: isoParam(req.query.from, 'from', true), to: isoParam(req.query.to, 'to', true) };
}

const api = express.Router();
api.use(adminAuth);

api.get('/ping', (req, res) => res.json({ ok: true }));

// ── Employees ─────────────────────────────────────────────────────────────────

api.get('/users', wrap(async (req, res) => {
  res.json({ users: await db.adminListUsers() });
}));

api.patch('/users/:id', wrap(async (req, res) => {
  res.json({ user: await db.adminUpdateUser(req.params.id, req.body || {}) });
}));

api.post('/users/:id/merge', wrap(async (req, res) => {
  await db.adminMergeUsers(req.params.id, (req.body || {}).into_user_id);
  res.json({ ok: true });
}));

api.delete('/users/:id', wrap(async (req, res) => {
  await db.adminDeleteUser(req.params.id, storage.removeImages);
  res.json({ ok: true });
}));

// ── Devices & live status ─────────────────────────────────────────────────────

api.get('/devices', wrap(async (req, res) => {
  res.json({ devices: await db.adminListDevices({ userId: req.query.user_id || undefined }) });
}));

api.patch('/devices/:id', wrap(async (req, res) => {
  res.json({ device: await db.adminUpdateDevice(req.params.id, req.body || {}) });
}));

api.delete('/devices/:id', wrap(async (req, res) => {
  await db.adminDeleteDevice(req.params.id);
  res.json({ ok: true });
}));

// ── Settings ──────────────────────────────────────────────────────────────────

api.get('/settings', wrap(async (req, res) => {
  res.json({ defaults: db.DEFAULT_SETTINGS, global: await db.getGlobalSettings() });
}));

api.put('/settings', wrap(async (req, res) => {
  res.json({ global: await db.setGlobalSettings((req.body || {}).global || {}) });
}));

// ── Sessions ──────────────────────────────────────────────────────────────────

api.get('/sessions', wrap(async (req, res) => {
  const { user_id, status } = req.query;
  if (status && !db.SESSION_STATUSES.includes(status)) throw new db.HttpError(400, 'Invalid status');
  res.json(await db.adminListSessions({
    userId: user_id || undefined,
    from:   isoParam(req.query.from, 'from'),
    to:     isoParam(req.query.to, 'to'),
    status: status || undefined,
    limit:  Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 1000),
    offset: Math.max(parseInt(req.query.offset, 10) || 0, 0),
  }));
}));

api.post('/sessions', wrap(async (req, res) => {
  res.json({ session: await db.adminCreateSession(req.body || {}) });
}));

api.patch('/sessions/:id', wrap(async (req, res) => {
  res.json({ session: await db.adminUpdateSession(req.params.id, req.body || {}) });
}));

api.delete('/sessions/:id', wrap(async (req, res) => {
  await db.adminDeleteSession(req.params.id);
  res.json({ ok: true });
}));

// ── Adjustments ───────────────────────────────────────────────────────────────

api.get('/adjustments', wrap(async (req, res) => {
  res.json({ adjustments: await db.adminListAdjustments({
    status: req.query.status || undefined,
    userId: req.query.user_id || undefined,
  }) });
}));

api.patch('/adjustments/:id', wrap(async (req, res) => {
  res.json({ adjustment: await db.adminUpdateAdjustment(req.params.id, req.body || {}) });
}));

// ── Activity, apps, screenshots ───────────────────────────────────────────────

api.get('/activity', wrap(async (req, res) => {
  res.json({ slots: await db.adminListActivity({ userId: req.query.user_id, ...range(req) }) });
}));

api.get('/apps', wrap(async (req, res) => {
  const [usage, categories] = await Promise.all([
    db.adminListApps({ userId: req.query.user_id || undefined, ...range(req) }),
    db.adminListAppCategories(),
  ]);
  res.json({ usage, categories });
}));

api.get('/app-categories', wrap(async (req, res) => {
  res.json({ categories: await db.adminListAppCategories() });
}));

api.put('/app-categories', wrap(async (req, res) => {
  res.json({ category: await db.adminSetAppCategory(req.body || {}) });
}));

api.delete('/app-categories/:pattern', wrap(async (req, res) => {
  await db.adminDeleteAppCategory(req.params.pattern);
  res.json({ ok: true });
}));

api.get('/screenshots', wrap(async (req, res) => {
  const shots = await db.adminListScreenshots({ userId: req.query.user_id, ...range(req) });
  const urls = await storage.signedUrls(shots.map(s => s.path));
  res.json({ screenshots: shots.map(({ path: p, ...s }) => ({ ...s, url: urls[p] || null })) });
}));

api.delete('/screenshots/:id', wrap(async (req, res) => {
  const shot = await db.getScreenshot(req.params.id);
  await storage.removeImages([shot.path]);
  await db.deleteScreenshotRow(shot.id);
  res.json({ ok: true });
}));

// ── Projects ──────────────────────────────────────────────────────────────────

api.get('/projects', wrap(async (req, res) => {
  res.json({ projects: await db.listProjects({ includeArchived: true }) });
}));

api.post('/projects', wrap(async (req, res) => {
  res.json({ project: await db.adminCreateProject(req.body || {}) });
}));

api.patch('/projects/:id', wrap(async (req, res) => {
  res.json({ project: await db.adminUpdateProject(req.params.id, req.body || {}) });
}));

// ── Daily summary (attendance, payroll, project time) ─────────────────────────

api.get('/summary', wrap(async (req, res) => {
  res.json(await db.adminSummary({ from: req.query.from, to: req.query.to, userId: req.query.user_id || undefined }));
}));

// ── Attendance: leave & holidays ──────────────────────────────────────────────

api.get('/leaves', wrap(async (req, res) => {
  res.json(await db.adminListLeaves({ from: req.query.from, to: req.query.to }));
}));

api.put('/leaves', wrap(async (req, res) => {
  res.json({ leave: await db.adminSetLeave(req.body || {}) });
}));

api.delete('/leaves/:userId/:date', wrap(async (req, res) => {
  await db.adminDeleteLeave(req.params.userId, req.params.date);
  res.json({ ok: true });
}));

api.put('/holidays', wrap(async (req, res) => {
  res.json({ holiday: await db.adminSetHoliday(req.body || {}) });
}));

api.delete('/holidays/:date', wrap(async (req, res) => {
  await db.adminDeleteHoliday(req.params.date);
  res.json({ ok: true });
}));

router.use('/api', api);

module.exports = router;
