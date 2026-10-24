const { db, HttpError, getGlobalSettings } = require('./db');

const BUCKET = 'screenshots';

async function uploadImage(path, buffer) {
  const { error } = await db().storage.from(BUCKET).upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new HttpError(500, 'uploadScreenshot: ' + error.message);
}

async function signedUrls(paths, expiresIn = 3600) {
  if (!paths.length) return {};
  const { data, error } = await db().storage.from(BUCKET).createSignedUrls(paths, expiresIn);
  if (error) throw new HttpError(500, 'signScreenshots: ' + error.message);
  return Object.fromEntries(data.filter(d => d.signedUrl).map(d => [d.path, d.signedUrl]));
}

async function removeImages(paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await db().storage.from(BUCKET).remove(paths.slice(i, i + 100));
    if (error) throw new HttpError(500, 'removeScreenshots: ' + error.message);
  }
}

// Called opportunistically from device syncs; the free Render instance sleeps, so there is no reliable cron
let lastCleanup = 0;
function cleanupOldScreenshots() {
  if (Date.now() - lastCleanup < 12 * 3600_000) return;
  lastCleanup = Date.now();
  (async () => {
    const { screenshot_retention_days: days } = await getGlobalSettings();
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    for (;;) {
      const { data, error } = await db().from('screenshots').select('id, path').lt('taken_at', cutoff).limit(200);
      if (error) throw error;
      if (!data.length) break;
      await removeImages(data.map(s => s.path));
      const { error: dErr } = await db().from('screenshots').delete().in('id', data.map(s => s.id));
      if (dErr) throw dErr;
      if (data.length < 200) break;
    }
  })().catch(err => console.error('Screenshot cleanup failed:', err.message));
}

module.exports = { uploadImage, signedUrls, removeImages, cleanupOldScreenshots };
