const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const zlib = require('zlib');

let mainWindow;
let tray;
let trackedUsername = null;

// ── Auto-start on PC boot ─────────────────────────────────────────────────────
app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

// ── Generate tray icon (16x16 green square, no external file needed) ──────────
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
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
    let crc = 0xFFFFFFFF;
    for (const b of buf) crc = t[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const tb = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
    return Buffer.concat([len, tb, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return nativeImage.createFromBuffer(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', comp), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 300,
    resizable: false,
    center: true,
    show: false,
    title: 'Activity Tracker',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    // Only show if no name saved — renderer will tell us via 'has-name' or 'need-name'
  });

  // Close button → hide to tray, never quit
  mainWindow.on('close', e => {
    e.preventDefault();
    mainWindow.hide();
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(makeTrayIcon());
  refreshTray();
  tray.on('click', toggleWindow);
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

function toggleWindow() {
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ── IPC ───────────────────────────────────────────────────────────────────────

// Renderer has no saved name → show name screen
ipcMain.on('need-name', () => {
  mainWindow.setSize(400, 300);
  mainWindow.center();
  mainWindow.show();
  mainWindow.focus();
});

// User just entered their name → hide window, start tracking silently
ipcMain.on('name-set', (_, name) => {
  trackedUsername = name;
  mainWindow.setSize(960, 640);
  mainWindow.hide();
  refreshTray();
});

// App loaded with saved name → stay hidden, tracking started silently
ipcMain.on('has-name', (_, name) => {
  trackedUsername = name;
  mainWindow.setSize(960, 640);
  refreshTray();
});

// Renderer wants to show dashboard (e.g. opened from tray)
ipcMain.on('show-dashboard', () => {
  mainWindow.setSize(960, 640);
  mainWindow.center();
  mainWindow.show();
  mainWindow.focus();
});

ipcMain.handle('app-version', () => app.getVersion());

// ── Auto-updater: force install immediately, no user prompt ──────────────────
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-downloaded', () => {
    // Force quit and install immediately — user sees nothing
    autoUpdater.quitAndInstall(true, true);
  });

  autoUpdater.on('error', () => {}); // silent

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createTray();
  if (app.isPackaged) setupAutoUpdater();
});

// Never quit when all windows close — live in tray
app.on('window-all-closed', () => {});

app.on('activate', () => {
  mainWindow.show();
  mainWindow.focus();
});
