const Store = require('electron-store');
const { safeStorage } = require('electron');

// All config lives in OS AppData — never inside the .exe
const store = new Store({ name: 'activity-tracker-config' });

function encrypt(val) {
  if (!val || !safeStorage.isEncryptionAvailable()) return val;
  return safeStorage.encryptString(val).toString('base64');
}

function decrypt(val) {
  if (!val || !safeStorage.isEncryptionAvailable()) return val;
  try {
    return safeStorage.decryptString(Buffer.from(val, 'base64'));
  } catch {
    return val;
  }
}

function getConfig() {
  return {
    user:         store.get('user', ''),
    googleSheets: {
      spreadsheetId: store.get('googleSheets.spreadsheetId', ''),
      range:         store.get('googleSheets.range', 'Sheet1!A1'),
      clientEmail:   store.get('googleSheets.clientEmail', ''),
      privateKey:    decrypt(store.get('googleSheets.privateKey', '')),
    },
    email: {
      host: store.get('email.host', ''),
      port: store.get('email.port', 587),
      user: store.get('email.user', ''),
      pass: decrypt(store.get('email.pass', '')),
    },
    crm: {
      apiUrl: store.get('crm.apiUrl', ''),
      apiKey: decrypt(store.get('crm.apiKey', '')),
    },
  };
}

function setConfig(key, value) {
  const sensitiveKeys = [
    'googleSheets.privateKey',
    'email.pass',
    'crm.apiKey',
  ];
  store.set(key, sensitiveKeys.includes(key) ? encrypt(value) : value);
}

module.exports = { getConfig, setConfig };
