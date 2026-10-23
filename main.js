const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const server = require('./server');
const { getConfig, setConfig } = require('./store');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  mainWindow.loadFile('index.html');
}

// ── Auto-updater ─────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', info =>
    mainWindow?.webContents.send('update-status', { event: 'available', version: info.version }));

  autoUpdater.on('download-progress', p =>
    mainWindow?.webContents.send('update-status', { event: 'progress', percent: Math.round(p.percent) }));

  autoUpdater.on('update-downloaded', info =>
    mainWindow?.webContents.send('update-status', { event: 'downloaded', version: info.version }));

  autoUpdater.on('error', err =>
    mainWindow?.webContents.send('update-status', { event: 'error', message: err.message }));

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on('install-update', () => autoUpdater.quitAndInstall());
ipcMain.handle('app-version', () => app.getVersion());

// Settings: renderer can read/write config securely
ipcMain.handle('get-config', () => {
  const cfg = getConfig();
  // Mask secrets before sending to renderer
  if (cfg.googleSheets.privateKey) cfg.googleSheets.privateKey = '••••••••';
  if (cfg.email.pass)              cfg.email.pass              = '••••••••';
  if (cfg.crm.apiKey)              cfg.crm.apiKey              = '••••••••';
  return cfg;
});

ipcMain.handle('set-config', (_, key, value) => {
  setConfig(key, value);
  return true;
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  server.start();
  createWindow();
  if (app.isPackaged) setupAutoUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
