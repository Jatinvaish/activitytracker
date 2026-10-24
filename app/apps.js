const { execFile } = require('child_process');

const BROWSERS = /^(chrome|msedge|firefox|brave|opera|vivaldi|arc|chromium|safari|google chrome|microsoft edge)$/i;

let win32 = null;
function loadWin32() {
  if (win32 !== null) return win32;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    win32 = {
      GetForegroundWindow:        user32.func('void* __stdcall GetForegroundWindow()'),
      GetWindowTextW:             user32.func('int __stdcall GetWindowTextW(void* hWnd, _Out_ uint16_t* text, int max)'),
      GetWindowThreadProcessId:   user32.func('uint32_t __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32_t* pid)'),
      OpenProcess:                kernel32.func('void* __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
      QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void* h, uint32_t flags, _Out_ uint16_t* name, _Inout_ uint32_t* size)'),
      CloseHandle:                kernel32.func('bool __stdcall CloseHandle(void* h)'),
    };
  } catch (err) {
    console.error('App tracking unavailable:', err.message);
    win32 = false;
  }
  return win32;
}

function decode(buf, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[i]);
  return s;
}

function foregroundWindows() {
  const w = loadWin32();
  if (!w) return null;
  const hwnd = w.GetForegroundWindow();
  if (!hwnd) return null;
  const titleBuf = new Uint16Array(512);
  const title = decode(titleBuf, w.GetWindowTextW(hwnd, titleBuf, 512));
  const pid = [0];
  w.GetWindowThreadProcessId(hwnd, pid);
  let exe = '';
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const h = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0]);
  if (h) {
    const nameBuf = new Uint16Array(1024);
    const size = [1024];
    if (w.QueryFullProcessImageNameW(h, 0, nameBuf, size)) exe = decode(nameBuf, size[0]);
    w.CloseHandle(h);
  }
  const app = (exe.split('\\').pop() || '').replace(/\.exe$/i, '');
  return app ? { app, title } : null;
}

function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim()));
  });
}

// Mac: app name only (window titles need extra permissions)
async function foregroundMac() {
  const app = await run('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true']);
  return app ? { app, title: '' } : null;
}

// Linux: needs xdotool; without it app tracking simply stays empty
async function foregroundLinux() {
  const pid = await run('xdotool', ['getactivewindow', 'getwindowpid']);
  if (!pid) return null;
  const [title, comm] = await Promise.all([
    run('xdotool', ['getactivewindow', 'getwindowname']),
    run('cat', [`/proc/${pid}/comm`]),
  ]);
  return comm ? { app: comm, title: title || '' } : null;
}

// Browsers: keep the site, not the full page title ("Inbox (3) - you@x.com - Gmail - Google Chrome" → "Gmail")
function siteFromTitle(title) {
  let t = title
    .replace(/\s+[-—–]\s+(Google Chrome|Microsoft​?\s?Edge|Mozilla Firefox|Brave|Opera|Vivaldi|Arc|Chromium|Safari)$/i, '')
    .replace(/\s+[-—–]\s+(Profile \d+|Personal|Work)$/i, '')
    .replace(/^\(\d+\)\s*/, '')
    .trim();
  const parts = t.split(/\s+[|\-—–·]\s+/).map(s => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  return (parts.length > 1 && last.length <= 40 ? last : t).slice(0, 120);
}

async function sample() {
  let r = null;
  try {
    if (process.platform === 'win32') r = foregroundWindows();
    else if (process.platform === 'darwin') r = await foregroundMac();
    else r = await foregroundLinux();
  } catch {
    return null;
  }
  if (!r) return null;
  return { app: r.app.slice(0, 80), label: BROWSERS.test(r.app) ? siteFromTitle(r.title) : '' };
}

module.exports = { sample, siteFromTitle };
