const fs = require('fs');

const KINDS = { seg: 'segments', act: 'activity', app: 'apps' };

// Everything waiting to upload, persisted to disk so nothing is lost offline or on a crash.
// Items are keyed (segment id, slot, app-hour), so re-queuing the same thing replaces it.
class Queue {
  constructor(file) {
    this.file = file;
    this.items = { seg: {}, act: {}, app: {} };
    this.rev = 0;
    this.timer = null;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const kind of Object.keys(KINDS)) {
        for (const [key, data] of Object.entries(saved[kind] || {})) this.items[kind][key] = { data, rev: ++this.rev };
      }
    } catch { /* first run or unreadable: start empty */ }
  }

  put(kind, key, data) {
    this.items[kind][key] = { data, rev: ++this.rev };
    this.schedule();
  }

  size() {
    return Object.values(this.items).reduce((n, m) => n + Object.keys(m).length, 0);
  }

  // A batch plus the revision of each item, so ack() keeps anything re-queued while the upload was in flight
  take(limits = { seg: 300, act: 1000, app: 1500 }) {
    const batch = { segments: [], activity: [], apps: [], revs: { seg: {}, act: {}, app: {} } };
    for (const [kind, field] of Object.entries(KINDS)) {
      for (const [key, item] of Object.entries(this.items[kind]).slice(0, limits[kind])) {
        batch[field].push(item.data);
        batch.revs[kind][key] = item.rev;
      }
    }
    return batch;
  }

  ack(revs) {
    for (const kind of Object.keys(KINDS)) {
      for (const [key, rev] of Object.entries(revs[kind] || {})) {
        if (this.items[kind][key] && this.items[kind][key].rev === rev) delete this.items[kind][key];
      }
    }
    this.schedule();
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 2000);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const out = {};
    for (const kind of Object.keys(KINDS)) {
      out[kind] = Object.fromEntries(Object.entries(this.items[kind]).map(([k, v]) => [k, v.data]));
    }
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(out));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (err) {
      console.error('Queue save failed:', err.message);
    }
  }
}

module.exports = Queue;
