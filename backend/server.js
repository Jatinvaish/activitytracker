const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const sheets     = require('./sheets');
const mailer     = require('./mailer');

const app  = express();
const PORT = process.env.PORT || 3056;

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));  // 10mb for screenshots
app.use(morgan('combined'));

// Rate limit: 60 requests per minute per IP
const limiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (!process.env.API_SECRET || secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check — no auth needed
app.get('/status', (req, res) => {
  res.json({ status: 'running', version: '1.0.0', ts: new Date().toISOString() });
});

// Log an activity
app.post('/log', auth, async (req, res) => {
  const { activity, username, timestamp, screenshotBase64 } = req.body;
  if (!activity || !username) {
    return res.status(400).json({ error: 'activity and username are required' });
  }

  try {
    await sheets.appendLog({
      activity,
      username,
      timestamp: timestamp || new Date().toISOString(),
      screenshotBase64: screenshotBase64 || null,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Sheets error:', err.message);
    res.status(500).json({ error: 'Failed to write to sheet', detail: err.message });
  }
});

// Send email notification
app.post('/email', auth, async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject) return res.status(400).json({ error: 'to and subject required' });

  try {
    await mailer.send({ to, subject, body });
    res.json({ ok: true });
  } catch (err) {
    console.error('Email error:', err.message);
    res.status(500).json({ error: 'Failed to send email', detail: err.message });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`Activity Tracker API running on port ${PORT}`));
