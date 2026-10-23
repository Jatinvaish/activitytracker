const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const axios = require('axios');
const { getConfig } = require('./store');

// ── Sheets helpers ───────────────────────────────────────────────────────────

function getAuth(cfg) {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: cfg.googleSheets.clientEmail,
      private_key: cfg.googleSheets.privateKey.replace(/\\n/g, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ],
  });
}

function sheets(auth) { return google.sheets({ version: 'v4', auth }); }
function drive(auth)  { return google.drive({ version: 'v3', auth }); }

async function ensureTab(sheetsApi, spreadsheetId, tabName) {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some(s => s.properties.title === tabName);
  if (exists) return;

  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { addSheet: { properties: { title: tabName } } },
      ],
    },
  });

  // Write header row on new tab
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1:D1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Date', 'Time', 'Activity', 'Screenshot']] },
  });
}

async function getLastRow(sheetsApi, spreadsheetId, tabName) {
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:A`,
  });
  return (res.data.values || []).length + 1;
}

async function uploadScreenshot(driveApi, base64Image, filename) {
  if (!base64Image) return null;
  const buf = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const { Readable } = require('stream');
  const stream = Readable.from(buf);

  const file = await driveApi.files.create({
    requestBody: { name: filename, mimeType: 'image/png' },
    media: { mimeType: 'image/png', body: stream },
    fields: 'id',
  });
  // Make publicly readable so =IMAGE() works in Sheets
  await driveApi.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return `https://drive.google.com/uc?id=${file.data.id}`;
}

// ── Main: append activity log ────────────────────────────────────────────────

async function appendToSheet({ activity, timestamp, username, screenshotBase64 }) {
  const cfg = getConfig();
  if (!cfg.googleSheets.spreadsheetId || !cfg.googleSheets.clientEmail) {
    console.warn('Google Sheets not configured — skipping.');
    return;
  }

  const auth    = getAuth(cfg);
  const sh      = sheets(auth);
  const dr      = drive(auth);
  const sid     = cfg.googleSheets.spreadsheetId;
  const tabName = username || cfg.user || 'Default';
  const now     = new Date(timestamp);
  const dateStr = now.toLocaleDateString('en-GB'); // DD/MM/YYYY
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  await ensureTab(sh, sid, tabName);

  // Check if today's date header already exists in this tab
  const colA = await sh.spreadsheets.values.get({ spreadsheetId: sid, range: `${tabName}!A:A` });
  const rows  = colA.data.values || [];
  const hasDate = rows.some(r => r[0] === dateStr);

  let nextRow = rows.length + 1;

  if (!hasDate) {
    // Insert a date separator row
    await sh.spreadsheets.values.append({
      spreadsheetId: sid,
      range: `${tabName}!A${nextRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[dateStr, '', '── Day separator ──', '']] },
    });
    nextRow++;
  }

  // Upload screenshot if provided
  let imageFormula = '';
  if (screenshotBase64) {
    const url = await uploadScreenshot(dr, screenshotBase64, `screenshot_${Date.now()}.png`);
    if (url) imageFormula = `=IMAGE("${url}")`;
  }

  // Append the log row
  await sh.spreadsheets.values.append({
    spreadsheetId: sid,
    range: `${tabName}!A${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[dateStr, timeStr, activity, imageFormula]] },
  });
}

// ── Email ────────────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, body }) {
  const cfg = getConfig();
  if (!cfg.email.host || !cfg.email.user) {
    console.warn('Email not configured — skipping.');
    return;
  }
  const transporter = nodemailer.createTransport({
    host: cfg.email.host,
    port: cfg.email.port,
    secure: cfg.email.port === 465,
    auth: { user: cfg.email.user, pass: cfg.email.pass },
  });
  await transporter.sendMail({ from: cfg.email.user, to, subject, text: body || '' });
}

// ── CRM / External API ───────────────────────────────────────────────────────

async function postToCRM(payload) {
  const cfg = getConfig();
  if (!cfg.crm.apiUrl) {
    console.warn('CRM not configured — skipping.');
    return;
  }
  await axios.post(cfg.crm.apiUrl, payload, {
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.crm.apiKey ? { Authorization: `Bearer ${cfg.crm.apiKey}` } : {}),
    },
  });
}

module.exports = { appendToSheet, sendEmail, postToCRM };
