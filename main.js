const { app, BrowserWindow, ipcMain, Tray, Menu, powerMonitor, Notification, screen } = require('electron');
const path   = require('path');
const crypto = require('crypto');

// Testing: run against another backend with a separate profile, without touching the installed app
if (process.env.TRACKER_USER_DATA) app.setPath('userData', process.env.TRACKER_USER_DATA);

const CONSENT_VERSION = 1;
const APP_ID = 'com.activityutility.tracker';

// Used until the first sync brings the company's settings
const DEFAULT_SETTINGS = {
  idle_threshold_mins: 5, prompt_after_idle_mins: 10, daily_goal_mins: 480, shift_end: '18:30',
  meeting_detection: true, app_tracking: true, screenshots_enabled: false, screenshot_interval_mins: 10,
  screenshot_blur: false, end_of_day_summary: true,
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  const { autoUpdater } = require('electron-updater');
  const config      = require('./app/config');
  const Queue       = require('./app/queue');
  const Tracker     = require('./app/tracker');
  const Sync        = require('./app/sync');
  const Screenshots = require('./app/screenshots');
  const apps        = require('./app/apps');
  const meeting     = require('./app/meeting');
  const { trayIcon } = require('./app/icons');

  let mainWindow = null, promptWindow = null, tray = null;
  let queue, tracker, sync, shots;
  let quitting = false, promptData = null, promptTimer = null;
  let trayState = { kind: null, menuKey: null, at: 0 };
  let lastLiveKey = '', lastTodayAt = 0, lastEodCheck = 0;

  const settings = () => ({ ...DEFAULT_SETTINGS, ...(config.get('settings') || {}) });
  const userName = () => config.get('user_name') || config.get('username') || '';

  function stage() {
    if (!config.get('username')) return 'name';
    if (config.get('consent_version') !== CONSENT_VERSION) return 'consent';
    if (['rejected', 'revoked'].includes(config.get('reg_status'))) return 'blocked';
    return 'dashboard';
  }

  function bucket(s) {
    if (s.category === 'meeting') return 'meeting';
    if (s.category === 'break' || s.category === 'lunch') return 'break';
    if (s.status === 'active') return 'active';
    if (s.status === 'away') return 'away';
    return 'idle';
  }

  function todayTotals() {
    const t = { worked: 0, idle: 0 };
    if (!tracker.running) return t;
    for (const s of tracker.snapshot().segments) {
      const mins = (Date.parse(s.end_time) - Date.parse(s.start_time)) / 60000;
      const b = bucket(s);
      if (b === 'active' || b === 'meeting') t.worked += mins;
      else if (b === 'idle') t.idle += mins;
    }
    return t;
  }

  function fmtDur(mins) {
    mins = Math.max(0, Math.round(mins));
    const h = Math.floor(mins / 60);
    return h ? `${h}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
  }

  function fmtTime(isoStr) {
    return new Date(isoStr).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  const STATUS_LABEL = { active: 'Active', idle: 'Idle', away: 'Away', break: 'On break', meeting: 'In a meeting' };

  // ── Startup ─────────────────────────────────────────────────────────────────

  app.on('second-instance', () => showWindow());
  app.on('window-all-closed', () => {});

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    if (!config.get('device_id')) config.set({ device_id: crypto.randomUUID() });

    queue = new Queue(path.join(app.getPath('userData'), 'upload-queue.json'));
    tracker = new Tracker({
      power: powerMonitor, queue, store: config,
      sampleApp: apps.sample, inMeeting: meeting.inMeeting, getSettings: settings,
    });
    shots = new Screenshots({
      dir: path.join(app.getPath('userData'), 'screenshot-outbox'),
      getSettings: settings, onChange: pushState, onTaken: onScreenshot,
    });
    sync = new Sync({ config, queue, tracker, shots, appVersion: app.getVersion() });

    wireEvents();
    createWindow();
    createTray();
    if (stage() === 'dashboard') begin();
    if (app.isPackaged) setupAutoUpdater();
  });

  function begin() {
    if (!tracker.running) tracker.start();
    sync.start();
  }

  function wireEvents() {
    tracker.on('tick', onTick);
    tracker.on('change', () => {
      const live = tracker.live();
      const key = live ? `${live.status}|${live.project_id}` : 'stopped';
      if (key !== lastLiveKey) { lastLiveKey = key; if (live) sync.soon(); }
      refreshTray();
      pushState();
    });
    tracker.on('prompt', showPrompt);
    tracker.on('day', () => loadToday(true));

    sync.on('status', status => { onRegStatus(status); refreshTray(); pushState(); });
    sync.on('synced', () => { loadToday(false); pushState(); });
    sync.on('decisions', onDecisions);

    powerMonitor.on('suspend', () => tracker.suspend());
    powerMonitor.on('resume', () => { tracker.resume(); sync.schedule(5000); });
    powerMonitor.on('shutdown', () => shutdown('shutdown'));
    app.on('before-quit', () => { if (!quitting) shutdown('quit'); });
  }

  function onTick() {
    const now = Date.now();
    const live = tracker.live();
    shots.tick(now, tracker.mode === 'active', { activityPct: tracker.snapshot().activityPct, app: live && live.app });
    if (mainWindow && mainWindow.isVisible()) pushState();
    if (now - trayState.at > 30_000) refreshTray();
    if (now - lastEodCheck > 60_000) { lastEodCheck = now; checkEndOfDay(now); }
  }

  // Today's segments from the server: other computers, earlier runs, adjustment status
  async function loadToday(force) {
    if (!config.get('token') || (!force && Date.now() - lastTodayAt < 5 * 60_000)) return;
    lastTodayAt = Date.now();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    try {
      tracker.mergeServer(await sync.fetchSessions(start.toISOString(), new Date(start.getTime() + 86400_000).toISOString()));
    } catch { lastTodayAt = 0; }
  }

  function onRegStatus(status) {
    if (['revoked', 'rejected'].includes(status)) {
      if (tracker.running) tracker.stop(status);
      showWindow();
    } else if (status === 'pending' && !config.get('pending_notified')) {
      config.set({ pending_notified: true });
      notify('Waiting for approval', 'Your admin needs to approve this computer. Your time is being saved and will upload after approval.');
    } else if (status === 'approved') {
      if (config.get('pending_notified')) {
        config.set({ pending_notified: false });
        notify('Computer approved', 'Activity Tracker is now uploading your time.');
      }
      if (stage() === 'dashboard' && !tracker.running) begin();
    }
  }

  // ── Window ──────────────────────────────────────────────────────────────────

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1060, height: 720, minWidth: 880, minHeight: 580,
      show: false, title: 'Activity Tracker', backgroundColor: '#0f0f0f',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    if (process.platform !== 'darwin') mainWindow.removeMenu();
    mainWindow.loadFile('index.html');
    if (stage() !== 'dashboard') mainWindow.once('ready-to-show', showWindow);
    // X hides to the tray; only Quit (or the OS) really closes the app
    mainWindow.on('close', e => { if (!quitting) { e.preventDefault(); mainWindow.hide(); } });
    mainWindow.on('session-end', () => shutdown('shutdown'));
    mainWindow.on('show', pushState);
  }

  function showWindow(tab) {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (typeof tab === 'string') mainWindow.webContents.send('open-tab', tab);
    pushState();
  }

  function buildState() {
    return {
      stage:    stage(),
      name:     userName(),
      version:  app.getVersion(),
      reg:      config.get('reg_status') || 'unregistered',
      online:   sync.online,
      lastSyncAt: sync.lastSyncAt ? new Date(sync.lastSyncAt).toISOString() : null,
      queued:   queue.size() + shots.outboxSize(),
      settings: settings(),
      projects: config.get('projects') || [],
      tracker:  tracker.running ? tracker.snapshot() : null,
      shots:    shots.forUi(),
    };
  }

  function pushState() {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.webContents.send('state', buildState());
  }

  // ── Tray ────────────────────────────────────────────────────────────────────

  function createTray() {
    tray = new Tray(trayIcon('problem'));
    tray.on('click', () => (mainWindow.isVisible() ? mainWindow.hide() : showWindow()));
    refreshTray();
  }

  function liveKind() {
    if (stage() !== 'dashboard' || !tracker.running) return 'problem';
    return tracker.live().status;
  }

  function refreshTray() {
    if (!tray) return;
    trayState.at = Date.now();
    const kind = liveKind();
    if (kind !== trayState.kind) { tray.setImage(trayIcon(kind)); trayState.kind = kind; }

    const status = tracker.running ? STATUS_LABEL[kind] : stage() === 'blocked' ? 'Tracking off' : 'Setup needed';
    const pending = config.get('reg_status') === 'pending' ? ' · waiting for approval' : '';
    tray.setToolTip(`${userName() || 'Activity Tracker'} — ${status} · ${fmtDur(todayTotals().worked)} worked today${pending}`);

    const projects = config.get('projects') || [];
    const menuKey = JSON.stringify([kind, userName(), tracker.projectId, projects.map(p => p.id), tracker.mode]);
    if (menuKey === trayState.menuKey) return;
    trayState.menuKey = menuKey;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `${userName() || 'Activity Tracker'} — ${status}`, enabled: false },
      { label: 'Open dashboard', click: () => showWindow('today') },
      { type: 'separator' },
      tracker.mode === 'break'
        ? { label: 'End break', click: () => tracker.endBreak() }
        : { label: 'Take a break', enabled: tracker.running, submenu: [
            { label: 'Break', click: () => tracker.startBreak('break') },
            { label: 'Lunch', click: () => tracker.startBreak('lunch') },
          ] },
      { label: 'Project', enabled: tracker.running && projects.length > 0, submenu: [
          { label: 'No project', type: 'radio', checked: !tracker.projectId, click: () => tracker.setProject(null) },
          ...projects.map(p => ({
            label: p.client ? `${p.name} (${p.client})` : p.name,
            type: 'radio', checked: tracker.projectId === p.id, click: () => tracker.setProject(p.id),
          })),
        ] },
      { type: 'separator' },
      { label: 'Quit', click: quit },
    ]));
  }

  // ── Notifications ───────────────────────────────────────────────────────────

  function notify(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    if (onClick) n.on('click', onClick);
    n.show();
  }

  function onDecisions(list) {
    for (const d of list) {
      const when = d.sessions ? `${fmtTime(d.sessions.start_time)}–${fmtTime(d.sessions.end_time)}` : 'your session';
      const note = d.owner_notes ? ` · "${d.owner_notes}"` : '';
      notify(`Adjustment ${d.status}`, `Request for ${when}${note}`, () => showWindow('requests'));
    }
    lastTodayAt = 0;
    loadToday(true);
  }

  function onScreenshot() {
    notify('Screenshot taken', 'You can review or delete it in the next 5 minutes.', () => showWindow('today'));
    pushState();
  }

  function checkEndOfDay(now) {
    const s = settings();
    if (!s.end_of_day_summary || !tracker.running) return;
    const d = new Date(now);
    const today = d.toDateString();
    const [h, m] = String(s.shift_end || '18:30').split(':').map(Number);
    if (config.get('eod_sent') === today || d.getHours() * 60 + d.getMinutes() < h * 60 + m) return;
    const t = todayTotals();
    if (t.worked < 1) return;
    config.set({ eod_sent: today });
    const pct = Math.round(t.worked / s.daily_goal_mins * 100);
    notify('Your day so far', `${fmtDur(t.worked)} worked (${pct}% of your ${fmtDur(s.daily_goal_mins)} goal) · ${fmtDur(t.idle)} idle`, () => showWindow('today'));
  }

  // ── "Where were you?" prompt ────────────────────────────────────────────────

  function showPrompt(rec) {
    promptData = { client_id: rec.client_id, start_time: rec.start_time, end_time: rec.end_time };
    clearTimeout(promptTimer);
    promptTimer = setTimeout(closePrompt, 5 * 60_000);
    if (promptWindow && !promptWindow.isDestroyed()) {
      promptWindow.webContents.send('prompt-refresh');
      promptWindow.showInactive();
      return;
    }
    const { workArea } = screen.getPrimaryDisplay();
    promptWindow = new BrowserWindow({
      width: 380, height: 216,
      x: workArea.x + workArea.width - 396, y: workArea.y + workArea.height - 232,
      frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false,
      backgroundColor: '#151515',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    promptWindow.loadFile('prompt.html');
    // Never steal focus from whatever the employee just went back to
    promptWindow.once('ready-to-show', () => promptWindow.showInactive());
    promptWindow.on('closed', () => { promptWindow = null; });
  }

  function closePrompt() {
    clearTimeout(promptTimer);
    promptData = null;
    if (promptWindow && !promptWindow.isDestroyed()) promptWindow.close();
  }

  // ── Quit, shutdown, update ──────────────────────────────────────────────────

  function shutdown(reason) {
    quitting = true;
    if (tracker && tracker.running) tracker.stop(reason);
  }

  async function quit() {
    if (quitting) return;
    shutdown('quit');
    await Promise.race([sync.run(), new Promise(r => setTimeout(r, 4000))]);
    app.exit(0);
  }

  function setupAutoUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('update-downloaded', async () => {
      shutdown('update');
      await Promise.race([sync.run(), new Promise(r => setTimeout(r, 4000))]);
      autoUpdater.quitAndInstall(true, true);
    });
    autoUpdater.on('error', () => {});
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 3600_000);
  }

  // ── IPC ─────────────────────────────────────────────────────────────────────

  ipcMain.handle('get-state', () => buildState());

  ipcMain.handle('set-name', (_, name) => {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) throw new Error('Please enter your name');
    config.set({ username: clean, user_name: clean });
    pushState();
    return true;
  });

  // Only before consent: afterwards the name is the employee's identity and only the admin can rename it
  ipcMain.handle('reset-name', () => {
    if (stage() !== 'consent') return false;
    config.set({ username: null });
    pushState();
    return true;
  });

  ipcMain.handle('accept-consent', () => {
    config.set({ consent_version: CONSENT_VERSION, consent_at: new Date().toISOString() });
    begin();
    refreshTray();
    pushState();
    setTimeout(() => {
      if (mainWindow) mainWindow.hide();
      notify('Activity Tracker is running', 'It works in the background. Click the dot in the system tray to see your day.');
    }, 1500);
    return true;
  });

  ipcMain.handle('start-break', (_, kind) => tracker.startBreak(kind));
  ipcMain.handle('end-break', () => tracker.endBreak());
  ipcMain.handle('set-project', (_, id) => tracker.setProject(id));
  ipcMain.handle('discard-screenshot', (_, id) => shots.discard(id));
  ipcMain.handle('sync-now', () => sync.run());
  ipcMain.handle('fetch-history', (_, { from, to }) => sync.fetchSessions(from, to));
  ipcMain.handle('fetch-requests', () => sync.fetchAdjustments());
  ipcMain.handle('request-adjustment', async (_, body) => {
    const adj = await sync.requestAdjustment(body);
    lastTodayAt = 0;
    loadToday(true);
    return adj;
  });

  ipcMain.handle('prompt-data', () => promptData);
  ipcMain.handle('prompt-answer', (_, { category, note }) => {
    const ok = !!promptData && tracker.explain(promptData.client_id, category, note);
    closePrompt();
    if (ok) sync.soon();
    return ok;
  });
  ipcMain.handle('prompt-dismiss', () => closePrompt());
}
