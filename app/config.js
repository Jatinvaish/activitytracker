const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

let cache = null;
const file = () => path.join(app.getPath('userData'), 'tracker-config.json');

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { cache = {}; }
  return cache;
}

function get(key) { return load()[key]; }

// Write to a temp file then rename, so a crash mid-write never leaves a corrupt config
function set(patch) {
  cache = { ...load(), ...patch };
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 1));
  fs.renameSync(tmp, file());
}

module.exports = { load, get, set };
