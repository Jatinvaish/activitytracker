const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const axios = require('axios');
const cfg = require('./config.json');

// ── Google Sheets ────────────────────────────────────────────────────────────

function getSheetsClient() {
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
  if (!cfg.googleSheets.spreadsheetId || !cfg.googleSheets.clientEmail) {
    console.warn('Google Sheets not configured — skipping.');
    return;
  }
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: cfg.googleSheets.spreadsheetId,
    range: cfg.googleSheets.range || 'Sheet1!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[data.timestamp, data.activity]],
    },
  });
}

// ── Email ────────────────────────────────────────────────────────────────────

function getTransporter() {
  return nodemailer.createTransport({
    host: cfg.email.host,
    port: cfg.email.port || 587,
    secure: cfg.email.port === 465,
    auth: {
      user: cfg.email.user,
      pass: cfg.email.pass,
    },
  });
}

async function sendEmail({ to, subject, body }) {
  if (!cfg.email.host || !cfg.email.user) {
    console.warn('Email not configured — skipping.');
    return;
  }
  const transporter = getTransporter();
  await transporter.sendMail({
    from: cfg.email.user,
    to,
    subject,
    text: body || '',
  });
}

// ── CRM / External API ───────────────────────────────────────────────────────

async function postToCRM(payload) {
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
