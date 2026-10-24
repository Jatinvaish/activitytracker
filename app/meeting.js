const { execFile } = require('child_process');

// Windows records every app's mic/camera use; LastUsedTimeStop = 0 means "in use right now".
// That covers Zoom, Teams, Meet in a browser, WhatsApp calls, etc. without knowing the app.
const KEYS = ['microphone', 'webcam'].map(k =>
  `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\${k}`);

let cache = { at: 0, value: false };

function keyInUse(key) {
  return new Promise(resolve => {
    execFile('reg', ['query', key, '/s'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(!err && /LastUsedTimeStop\s+REG_QWORD\s+0x0\s*$/m.test(stdout));
    });
  });
}

async function inMeeting() {
  if (process.platform !== 'win32') return false;
  if (Date.now() - cache.at < 15_000) return cache.value;
  const results = await Promise.all(KEYS.map(keyInUse));
  cache = { at: Date.now(), value: results.some(Boolean) };
  return cache.value;
}

module.exports = { inMeeting };
