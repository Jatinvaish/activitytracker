const Store = require('electron-store');
const path = require('path');
const os = require('os');

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
  const s = getStore();
  return {
    serverUrl:    s.get('serverUrl', ''),
    apiSecret:    s.get('apiSecret', ''),
    user:         s.get('user', ''),
  };
}

function setConfig(key, value) {
  getStore().set(key, value);
}

module.exports = { getConfig, setConfig };
