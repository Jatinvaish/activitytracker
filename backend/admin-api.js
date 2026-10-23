const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const db      = require('./db');

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

function isoParam(value, name) {
  if (value === undefined || value === '') return undefined;
  if (isNaN(Date.parse(value))) throw new db.HttpError(400, `Invalid ${name} date`);
  return value;
}

const api = express.Router();
api.use(adminAuth);

api.get('/ping', (req, res) => res.json({ ok: true }));

api.get('/users', wrap(async (req, res) => {
  res.json({ users: await db.adminListUsers() });
}));

api.delete('/users/:id', wrap(async (req, res) => {
  await db.adminDeleteUser(req.params.id);
  res.json({ ok: true });
}));

api.get('/sessions', wrap(async (req, res) => {
  const { user_id, status } = req.query;
  if (status && !['active', 'idle'].includes(status)) throw new db.HttpError(400, 'Invalid status');
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

api.get('/adjustments', wrap(async (req, res) => {
  res.json({ adjustments: await db.adminListAdjustments({
    status: req.query.status || undefined,
    userId: req.query.user_id || undefined,
  }) });
}));

api.patch('/adjustments/:id', wrap(async (req, res) => {
  res.json({ adjustment: await db.adminUpdateAdjustment(req.params.id, req.body || {}) });
}));

router.use('/api', api);

module.exports = router;
