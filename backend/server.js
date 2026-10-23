const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const db        = require('./db');
const mailer    = require('./mailer');
// const sheets = require('./sheets'); // commented — Sheets kept only for email, not data

const app  = express();
const PORT = process.env.PORT || 3056;

app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(morgan('combined'));
app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));

function auth(req, res, next) {
  if (!process.env.API_SECRET || req.headers['x-api-secret'] !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({ status: 'running', version: '1.0.0' });
});

// ── Log session (active / idle) ───────────────────────────────────────────────
app.post('/session', auth, async (req, res) => {
  const { username, startTime, endTime, duration, status } = req.body;
  if (!username || !startTime || !endTime || !status) {
    return res.status(400).json({ error: 'username, startTime, endTime, status required' });
  }
  try {
    const session = await db.insertSession({ username, startTime, endTime, duration, status });
    res.json({ ok: true, session });
  } catch (err) {
    console.error('Session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Adjustment request ────────────────────────────────────────────────────────
app.post('/adjustment', auth, async (req, res) => {
  const { username, startTime, endTime, duration, status, note } = req.body;
  if (!username || !note) return res.status(400).json({ error: 'username and note required' });

  try {
    const adj = await db.insertAdjustment({ username, startTime, note });

    // Email owner — this stays
    const start = new Date(startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const end   = new Date(endTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const date  = new Date(startTime).toLocaleDateString('en-GB');

    await mailer.send({
      to:      process.env.SMTP_USER,
      subject: `Adjustment Request — ${username} — ${date}`,
      body: [
        `User: ${username}`,
        `Date: ${date}`,
        `Session: ${start} → ${end} (${duration} mins, ${status})`,
        ``,
        `Request:`,
        note,
        ``,
        `Adjustment ID: ${adj.id}`,
        `View sheet: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`,
      ].join('\n'),
    });

    res.json({ ok: true, adjustment: adj });
  } catch (err) {
    console.error('Adjustment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Get sessions for a user + date (for app dashboard) ───────────────────────
app.get('/sessions/:username', auth, async (req, res) => {
  const { username } = req.params;
  const date = req.query.date || new Date().toISOString().split('T')[0];
  try {
    const sessions = await db.getUserSessions(username, date);
    res.json({ ok: true, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pending adjustments (owner only) ─────────────────────────────────────────
app.get('/adjustments/pending', auth, async (req, res) => {
  try {
    const list = await db.getPendingAdjustments();
    res.json({ ok: true, adjustments: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => res.status(500).json({ error: 'Internal server error' }));

app.listen(PORT, () => console.log(`Activity Tracker API running on port ${PORT}`));
