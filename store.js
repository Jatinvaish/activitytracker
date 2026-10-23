const Store = require('electron-store').default;
const path = require('path');
const os = require('os');

// Resolve app data dir whether running inside Electron or plain Node
function getAppDataDir() {
  try {
    const { app } = require('electron');
    return app.getPath('userData');
  } catch {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'activity-utility');
  }
}

let _store;
function getStore() {
  if (!_store) {
    _store = new Store({ name: 'activity-tracker-config', cwd: getAppDataDir() });
  }
  return _store;
}

function getConfig() {
  const store = getStore();
  return {
    user: store.get('user', ''),
    googleSheets: {
      spreadsheetId: store.get('googleSheets.spreadsheetId', ''),
      range:         store.get('googleSheets.range', 'Sheet1!A1'),
      clientEmail:   store.get('googleSheets.clientEmail', ''),
      privateKey:    store.get('googleSheets.privateKey', ''),
    },
    email: {
      host: store.get('email.host', ''),
      port: store.get('email.port', 587),
      user: store.get('email.user', ''),
      pass: store.get('email.pass', ''),
    },
    crm: {
      apiUrl: store.get('crm.apiUrl', ''),
      apiKey: store.get('crm.apiKey', ''),
    },
  };
}

function setConfig(key, value) {
  getStore().set(key, value);
}

module.exports = { getConfig, setConfig };
