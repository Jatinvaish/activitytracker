// Simulated-clock tests for app/tracker.js — plain Node, no Electron: npm test
const path = require('path');
const os = require('os');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const Tracker = require(path.join(ROOT, 'app/tracker.js'));
const Queue = require(path.join(ROOT, 'app/queue.js'));

let failures = 0;
function ok(cond, msg) { if (!cond) { failures++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); }
const fmt = ms => new Date(ms).toTimeString().slice(0, 8);

function setup({ start, store = {}, meeting = false, settings = {} }) {
  const env = { t: start, idle: 0, state: 'active', meeting };
  const qfile = path.join(os.tmpdir(), 'q-' + Math.random().toString(36).slice(2) + '.json');
  const queue = new Queue(qfile);
  const kv = { ...store };
  const tracker = new Tracker({
    power: { getSystemIdleTime: () => env.idle, getSystemIdleState: () => env.state },
    now: () => env.t,
    queue,
    store: { get: k => kv[k], set: p => Object.assign(kv, p) },
    sampleApp: () => ({ app: 'Code', label: '' }),
    inMeeting: () => Promise.resolve(env.meeting),
    getSettings: () => ({ idle_threshold_mins: 5, prompt_after_idle_mins: 10, meeting_detection: true, app_tracking: true, ...settings }),
  });
  const prompts = [];
  tracker.on('prompt', p => prompts.push(p));
  tracker.start();
  clearInterval(tracker.timer);
  // Advance N seconds; input=true means the user touched keyboard/mouse each second
  async function run(secs, { input }) {
    for (let i = 0; i < secs; i++) {
      env.t += 1000;
      env.idle = input ? 0 : env.idle + 1;
      tracker.tick();
      if (i % 5 === 0) await new Promise(r => setImmediate(r));
    }
  }
  const segs = () => tracker.snapshot().segments;
  return { env, tracker, queue, kv, prompts, run, segs, cleanup: () => fs.rmSync(qfile, { force: true }) };
}

(async () => {
  const base = new Date(2026, 9, 24, 9, 0, 0).getTime();

  console.log('1. Work, go idle, come back after 12 min');
  {
    const s = setup({ start: base });
    await s.run(600, { input: true });
    ok(s.segs().length === 1 && s.segs()[0].status === 'active', '10 min of input = one active segment');
    await s.run(400, { input: false });
    const segs = s.segs();
    ok(segs.length === 2 && segs[1].status === 'idle', 'idle after 5 min without input');
    ok(segs[0].end_time === new Date(base + 600_000).toISOString(), `active ends at last input (${fmt(Date.parse(segs[0].end_time))})`);
    ok(segs[0].activity_pct === 100, `active segment activity 100% (got ${segs[0].activity_pct})`);
    await s.run(320, { input: false });
    await s.run(5, { input: true });
    const after = s.segs();
    ok(after.length === 3 && after[2].status === 'active', 'active again after input');
    ok(s.prompts.length === 1 && Math.round((Date.parse(s.prompts[0].end_time) - Date.parse(s.prompts[0].start_time)) / 60000) === 12, `prompt fired for a 12-min idle (${s.prompts.length})`);
    ok(s.tracker.explain(s.prompts[0].client_id, 'meeting', 'client call'), 'idle segment can be explained');
    ok(s.queue.items.seg[s.prompts[0].client_id].data.category === 'meeting', 'explanation queued for upload');
    s.cleanup();
  }

  console.log('2. Call with no typing keeps time as meeting, ends when the mic turns off');
  {
    const s = setup({ start: base, meeting: true });
    await s.run(120, { input: true });
    await s.run(420, { input: false });
    let segs = s.segs();
    ok(segs[segs.length - 1].status === 'active' && segs[segs.length - 1].category === 'meeting', 'no input + mic in use = meeting, not idle');
    s.env.meeting = false;
    await s.run(40, { input: false });
    segs = s.segs();
    ok(segs[segs.length - 1].status === 'idle', 'meeting ends → idle');
    ok(s.prompts.length === 0, 'no prompt yet');
    s.cleanup();
  }

  console.log('3. Lock → away, unlock → active');
  {
    const s = setup({ start: base });
    await s.run(60, { input: true });
    s.env.state = 'locked';
    await s.run(900, { input: false });
    ok(s.segs()[s.segs().length - 1].status === 'away', 'locked screen = away (not idle)');
    s.env.state = 'active';
    await s.run(10, { input: true });
    const segs = s.segs();
    ok(segs.map(x => x.status).join(',') === 'active,away,active', `sequence ${segs.map(x => x.status).join(',')}`);
    s.cleanup();
  }

  console.log('4. PC asleep 2 hours with no event → away for that gap');
  {
    const s = setup({ start: base });
    await s.run(60, { input: true });
    s.env.t += 2 * 3600_000;
    s.env.idle = 0;
    await s.run(5, { input: true });
    const segs = s.segs();
    ok(segs.map(x => x.status).join(',') === 'active,away,active', `sequence ${segs.map(x => x.status).join(',')}`);
    const away = segs[1];
    ok(Math.round((Date.parse(away.end_time) - Date.parse(away.start_time)) / 60000) === 120, 'away covers the 2-hour gap');
    s.cleanup();
  }

  console.log('5. Midnight splits the segment and starts a fresh day');
  {
    const s = setup({ start: new Date(2026, 9, 24, 23, 58, 0).getTime() });
    await s.run(240, { input: true });
    const segs = s.segs();
    ok(segs.length === 1 && segs[0].start_time === new Date(2026, 9, 25).toISOString(), 'today only shows the part after midnight');
    const queued = Object.values(s.queue.items.seg).map(i => i.data);
    ok(queued.some(q => q.end_time === new Date(2026, 9, 25).toISOString() && q.end_reason === 'midnight'), 'yesterday’s part queued, ending at midnight');
    s.cleanup();
  }

  console.log('6. Break and project switch');
  {
    const s = setup({ start: base });
    await s.run(60, { input: true });
    s.tracker.startBreak('lunch');
    await s.run(1800, { input: false });
    ok(s.tracker.live().status === 'break', 'live status = break during lunch, never idle');
    s.tracker.endBreak();
    s.tracker.setProject('11111111-1111-4111-8111-111111111111');
    await s.run(30, { input: true });
    const segs = s.segs();
    ok(segs[1].status === 'away' && segs[1].category === 'lunch', 'lunch stored as away + lunch');
    ok(segs[segs.length - 1].project_id === '11111111-1111-4111-8111-111111111111', 'new segment carries the project');
    s.cleanup();
  }

  console.log('7. Crash recovery and upload snapshot');
  {
    const open = { client_id: '22222222-2222-4222-8222-222222222222', start_time: new Date(base - 3600_000).toISOString(), end_time: new Date(base - 1800_000).toISOString(), status: 'active', is_open: true };
    const s = setup({ start: base, store: { open_segment: open } });
    const rec = s.queue.items.seg[open.client_id];
    ok(rec && rec.data.end_reason === 'crash' && rec.data.is_open === false, 'last open segment closed as crash');
    ok(!s.kv.open_segment, 'crash marker cleared');
    await s.run(120, { input: true });
    s.tracker.pushSnapshot();
    const live = Object.values(s.queue.items.seg).map(i => i.data).find(d => d.is_open);
    ok(live && live.status === 'active', 'snapshot queues the open segment as live');
    ok(Object.keys(s.queue.items.act).length >= 1, 'activity slot queued');
    ok(Object.keys(s.queue.items.app).length >= 1 && Object.values(s.queue.items.app)[0].data.seconds > 0, 'app usage queued');
    const batch = s.queue.take();
    s.tracker.pushSnapshot();
    s.queue.ack(batch.revs);
    ok(Object.values(s.queue.items.seg).some(i => i.data.is_open), 'live segment re-queued during upload survives the ack');
    s.cleanup();
  }

  console.log('8. Server edits (approved adjustments) replace uploaded segments, never unsent ones');
  {
    const s = setup({ start: base });
    await s.run(60, { input: true });
    s.tracker.startBreak('break');
    await s.run(60, { input: false });
    s.tracker.endBreak();
    const brk = s.segs().find(x => x.category === 'break');
    const serverRow = { ...brk, id: 'srv-1', device_id: 'dev', status: 'active', category: null, adjustments: [{ status: 'approved' }] };
    s.tracker.mergeServer([serverRow]);
    ok(s.segs().find(x => x.client_id === brk.client_id).category === 'break', 'unsent local segment is kept');
    s.queue.ack(s.queue.take().revs);
    s.tracker.mergeServer([serverRow]);
    const after = s.segs().find(x => x.client_id === brk.client_id);
    ok(after.status === 'active' && after.category === null, 'after upload, the approved change from the server shows');
    ok(after.source === 'local' && after.server.adjustments[0].status === 'approved', 'still treated as this computer’s segment');
    s.cleanup();
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
