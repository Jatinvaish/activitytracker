const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

let mainWindow;
let tray;
let trackedUsername = null;

// ── Persist username in main process (no IPC timing issues) ──────────────────
function configPath() {
  return path.join(app.getPath('userData'), 'tracker-config.json');
}
function loadUsername() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')).username || null; }
  catch { return null; }
}
function saveUsername(name) {
  fs.writeFileSync(configPath(), JSON.stringify({ username: name }), 'utf8');
}

// ── Auto-start on PC boot ─────────────────────────────────────────────────────
app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

// ── Tray icon: 16×16 green square, pure JS — no external file ────────────────
function makeTrayIcon() {
  const w = 16, h = 16, color = [0x4c, 0xaf, 0x87];
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      raw[y * (1 + w * 3) + 1 + x * 3]     = color[0];
      raw[y * (1 + w * 3) + 1 + x * 3 + 1] = color[1];
      raw[y * (1 + w * 3) + 1 + x * 3 + 2] = color[2];
    }
  }
  const comp = zlib.deflateSync(raw);
  const crc32 = buf => {
    const t = Array.from({ length: 256 }, (_, i) => {
      let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c;
    });
    let crc = 0xFFFFFFFF;
    for (const b of buf) crc = t[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const tb = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
    return Buffer.concat([len, tb, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return nativeImage.createFromBuffer(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', comp), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow(showImmediately) {
  mainWindow = new BrowserWindow({
    width:     showImmediately ? 420 : 960,
    height:    showImmediately ? 320 : 640,
    resizable: !showImmediately,
    center:    true,
    show:      false,
    title:     'Activity Tracker',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  mainWindow.loadFile('index.html');

  if (showImmediately) {
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      mainWindow.focus();
    });
  }

  // X button → hide to tray, never quit
  mainWindow.on('close', e => { e.preventDefault(); mainWindow.hide(); });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(makeTrayIcon());
  refreshTray();
  tray.on('click', () => {
    if (mainWindow.isVisible()) { mainWindow.hide(); }
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

function refreshTray() {
  const label = trackedUsername ? `Tracking: ${trackedUsername}` : 'Activity Tracker';
  tray.setToolTip(label);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'View My Logs', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.exit(0) },
  ]));
}

// ── IPC ───────────────────────────────────────────────────────────────────────

// User submitted their name for the first time
ipcMain.on('name-set', (_, name) => {
  saveUsername(name);
  trackedUsername = name;
  // Resize to dashboard, hide — tracking is now silent
  mainWindow.setResizable(true);
  mainWindow.setSize(960, 640);
  mainWindow.hide();
  refreshTray();
});

ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('get-username', () => loadUsername());

// ── Auto-updater: force install immediately, zero user prompt ─────────────────
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('update-downloaded', () => autoUpdater.quitAndInstall(true, true));
  autoUpdater.on('error', () => {});
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  trackedUsername = loadUsername();
  const needsName = !trackedUsername;

  createWindow(needsName);   // show immediately only if no name saved
  createTray();
  refreshTray();

  if (app.isPackaged) setupAutoUpdater();
});

app.on('window-all-closed', () => {}); // stay alive in tray
app.on('activate', () => { mainWindow.show(); mainWindow.focus(); });
