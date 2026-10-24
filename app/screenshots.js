const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { desktopCapturer, screen } = require('electron');

const REVIEW_MS  = 5 * 60_000;
const MAX_OUTBOX = 300;

// Random time inside each interval, only while the employee is active.
// Each capture waits 5 minutes on this computer so the employee can delete it before it uploads.
class Screenshots {
  constructor({ dir, getSettings, onChange, onTaken }) {
    Object.assign(this, { dir, getSettings, onChange, onTaken });
    this.pending = [];
    this.windowEnd = null;
    this.nextAt = null;
    this.capturing = false;
    fs.mkdirSync(dir, { recursive: true });
  }

  tick(now, isActive, context) {
    const s = this.getSettings();
    if (!s.screenshots_enabled) {
      this.windowEnd = this.nextAt = null;
      if (this.pending.length) { this.pending = []; this.onChange(); }
      return;
    }
    if (!this.windowEnd || now >= this.windowEnd) this.plan(now, s.screenshot_interval_mins * 60_000);
    if (this.nextAt && now >= this.nextAt && isActive && !this.capturing) {
      this.nextAt = null;
      this.capture(now, s.screenshot_blur, context).catch(err => console.error('Screenshot failed:', err.message));
    }
    const due = this.pending.filter(p => p.uploadAt <= now);
    if (due.length) {
      this.pending = this.pending.filter(p => p.uploadAt > now);
      due.forEach(p => this.toOutbox(p));
      this.onChange();
    }
  }

  plan(now, intervalMs) {
    const start = this.windowEnd && now - this.windowEnd < intervalMs ? this.windowEnd : now;
    this.windowEnd = start + intervalMs;
    this.nextAt = start + Math.random() * intervalMs;
  }

  async capture(now, blur, context) {
    this.capturing = true;
    try {
      const displays = screen.getAllDisplays();
      const w = Math.max(...displays.map(d => d.size.width * d.scaleFactor));
      const h = Math.max(...displays.map(d => d.size.height * d.scaleFactor));
      const scale = Math.min(1, 1600 / w);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(w * scale), height: Math.round(h * scale) },
      });
      const images = [];
      sources.forEach((src, i) => {
        let img = src.thumbnail;
        if (img.isEmpty()) return;
        if (blur) {
          const size = img.getSize();
          img = img.resize({ width: Math.max(1, Math.round(size.width / 16)), quality: 'good' })
                   .resize({ width: size.width, height: size.height, quality: 'good' });
        }
        images.push({ display: i, jpeg: img.toJPEG(60), thumb: i === 0 ? img.resize({ width: 320, quality: 'good' }).toDataURL() : null });
      });
      if (!images.length) return;
      const shot = {
        id: crypto.randomUUID(),
        taken_at: new Date(now).toISOString(),
        uploadAt: now + REVIEW_MS,
        blurred: !!blur,
        activity_pct: context.activityPct,
        app: context.app,
        images,
      };
      this.pending.push(shot);
      this.onChange();
      this.onTaken(shot);
    } finally {
      this.capturing = false;
    }
  }

  discard(id) {
    const before = this.pending.length;
    this.pending = this.pending.filter(p => p.id !== id);
    if (this.pending.length !== before) this.onChange();
    return this.pending.length !== before;
  }

  forUi() {
    return this.pending.map(p => ({ id: p.id, taken_at: p.taken_at, uploadAt: new Date(p.uploadAt).toISOString(), blurred: p.blurred, thumb: p.images[0].thumb, count: p.images.length }));
  }

  toOutbox(shot) {
    for (const img of shot.images) {
      const base = path.join(this.dir, `${shot.id}_${img.display}`);
      fs.writeFileSync(base + '.jpg', img.jpeg);
      fs.writeFileSync(base + '.json', JSON.stringify({ taken_at: shot.taken_at, display: img.display, blurred: shot.blurred, activity_pct: shot.activity_pct, app: shot.app }));
    }
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_OUTBOX))) this.removeFromOutbox(f.replace(/\.json$/, ''));
  }

  removeFromOutbox(base) {
    for (const ext of ['.jpg', '.json']) fs.rmSync(path.join(this.dir, base + ext), { force: true });
  }

  outboxSize() {
    return fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).length;
  }

  // upload(meta, base64) resolves { ok, reason } or throws on network/auth errors
  async uploadOutbox(upload) {
    for (const f of fs.readdirSync(this.dir).filter(n => n.endsWith('.json')).sort()) {
      const base = f.replace(/\.json$/, '');
      let meta, image;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        image = fs.readFileSync(path.join(this.dir, base + '.jpg')).toString('base64');
      } catch {
        this.removeFromOutbox(base);
        continue;
      }
      await upload({ ...meta, image });
      this.removeFromOutbox(base);
    }
  }
}

module.exports = Screenshots;
