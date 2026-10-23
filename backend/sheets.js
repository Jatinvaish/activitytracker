const { google } = require('googleapis');
const { Readable } = require('stream');

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ],
  });
}

async function ensureTab(sh, sid, tabName) {
  const meta   = await sh.spreadsheets.get({ spreadsheetId: sid });
  const exists = meta.data.sheets.some(s => s.properties.title === tabName);
  if (exists) return;

  await sh.spreadsheets.batchUpdate({
    spreadsheetId: sid,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });

  // Bold header row
  const newMeta  = await sh.spreadsheets.get({ spreadsheetId: sid });
  const sheetId  = newMeta.data.sheets.find(s => s.properties.title === tabName).properties.sheetId;

  await sh.spreadsheets.batchUpdate({
    spreadsheetId: sid,
    requestBody: {
      requests: [{
        repeatCell: {
          range:  { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell:   { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 } } },
          fields: 'userEnteredFormat(textFormat,backgroundColor)',
        },
      }],
    },
  });

  await sh.spreadsheets.values.update({
    spreadsheetId: sid,
    range: `${tabName}!A1:D1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Date', 'Time', 'Activity', 'Screenshot']] },
  });
}

async function uploadScreenshot(drv, base64Image) {
  if (!base64Image) return null;
  const buf    = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const stream = Readable.from(buf);

  const file = await drv.files.create({
    requestBody: { name: `screenshot_${Date.now()}.png`, mimeType: 'image/png' },
    media:       { mimeType: 'image/png', body: stream },
    fields:      'id',
  });

  await drv.permissions.create({
    fileId:      file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return `https://drive.google.com/uc?id=${file.data.id}`;
}

async function appendLog({ activity, username, timestamp, screenshotBase64 }) {
  const auth = getAuth();
  const sh   = google.sheets({ version: 'v4', auth });
  const drv  = google.drive({ version: 'v3', auth });
  const sid  = process.env.GOOGLE_SPREADSHEET_ID;
  const tab  = username.trim() || 'Default';
  const now  = new Date(timestamp);
  const date = now.toLocaleDateString('en-GB');
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  await ensureTab(sh, sid, tab);

  // Check if today's date separator exists
  const colA   = await sh.spreadsheets.values.get({ spreadsheetId: sid, range: `${tab}!A:A` });
  const rows   = colA.data.values || [];
  const hasDay = rows.some(r => r[0] === date);

  if (!hasDay) {
    await sh.spreadsheets.values.append({
      spreadsheetId: sid,
      range: `${tab}!A:D`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[date, '', `── ${date} ──`, '']] },
    });
  }

  // Upload screenshot → Drive if provided
  let imageFormula = '';
  if (screenshotBase64) {
    const url = await uploadScreenshot(drv, screenshotBase64);
    if (url) imageFormula = `=IMAGE("${url}")`;
  }

  await sh.spreadsheets.values.append({
    spreadsheetId: sid,
    range: `${tab}!A:D`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[date, time, activity, imageFormula]] },
  });
}

module.exports = { appendLog };
