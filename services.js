const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const axios = require('axios');
const { getConfig } = require('./store');

// ── Google Sheets ────────────────────────────────────────────────────────────

function getSheetsClient(cfg) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: cfg.googleSheets.clientEmail,
      private_key: cfg.googleSheets.privateKey.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function appendToSheet(data) {
  const cfg = getConfig();
  if (!cfg.googleSheets.spreadsheetId || !cfg.googleSheets.clientEmail) {
    console.warn('Google Sheets not configured — skipping.');
    return;
  }
  const sheets = getSheetsClient(cfg);
  await sheets.spreadsheets.values.append({
    spreadsheetId: cfg.googleSheets.spreadsheetId,
    range: cfg.googleSheets.range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[data.timestamp, data.activity]] },
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
