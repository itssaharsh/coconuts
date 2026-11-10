#!/usr/bin/env node
// Scripted emulator run of the judge path, through the IWSDK CLI.
// Requires: `npx iwsdk dev up --ai-mode agent --allow-browser-automation` (with LD_LIBRARY_PATH for libasound on this box).
// Usage: node tools/xr/run-take.mjs [--until start|hits|replay|review] [--state offline|online] [--shots qa/take] [--glasses] [--perf] [--keep] [--record qa/rec] [--cues [skip,list]] [--fov 55]
// --cues plays the clip's own cue sheet: a far pinch on each cue's prop at its time (skipping the listed cue indexes, so the take looks human).
// --record starts tools/xr/record-cdp.mjs (screencast + soundtrack when the sound flag is on) just before the clapper and stops it at the end.
// --perf waits for the stage's PERF log once the models are in and fails above 100 draw calls.
// --until review waits for the Director's review line after the take; --state says where it must come from
// (offline: the rules, as on the dev server with no /api; online: the model).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const until = opt('until', 'start');
const state = opt('state', null);
const shots = opt('shots', null);
const glasses = !!opt('glasses', false);
const perf = !!opt('perf', false);
const record = opt('record', null);
const fov = opt('fov', null); // the emulator view's vertical field of view while recording (it resets on a reload)
const cuesMode = opt('cues', null);
const FILM_LAG_MS = 800; // the film starts about this long after the clapper's TAKE start
const PINCH_LEAD_MS = 2800; // look-at plus select take about this long to land as a HIT (measured: hits logged 1.3 s after a 950 ms lead)
let recorder = null;
function stopRecorder() {
  if (!recorder) return Promise.resolve();
  const child = recorder;
  recorder = null;
  return new Promise((resolve) => {
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(resolve, 15000);
  });
}
if (shots) mkdirSync(shots, { recursive: true });

const CLI = resolve('node_modules/@iwsdk/cli/dist/cli.js');
function iw(cmdArgs, input) {
  const a = [CLI, ...cmdArgs];
  if (input) a.push('--input-json', JSON.stringify(input));
  const out = execFileSync('node', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
  const start = out.indexOf('{');
  if (start < 0) return out;
  try {
    return JSON.parse(out.slice(start));
  } catch {
    return out;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[run]', ...m);

function logs(pattern, count = 80) {
  const r = iw(['browser', 'logs'], { pattern, count });
  const items = r?.data?.result ?? r?.result ?? [];
  return (Array.isArray(items) ? items : []).map((x) => (typeof x === 'string' ? x : x.message ?? JSON.stringify(x)));
}
/** Log lines matching `pattern` written at or after `sinceMs` (the console buffer is a ring, so counts drift). */
function logsSince(pattern, sinceMs, count = 80) {
  const r = iw(['browser', 'logs'], { pattern, count });
  const items = r?.data?.result ?? r?.result ?? [];
  return (Array.isArray(items) ? items : []).filter((x) => typeof x !== 'string' && (x.timestamp ?? 0) >= sinceMs).map((x) => x.message ?? '');
}

function shot(name) {
  if (!shots) return;
  try {
    iw(['browser', 'screenshot', '--output-file', `${shots}/${name}.png`]);
    log('shot', name);
  } catch (e) {
    log('shot failed', name, String(e.message).split('\n')[0]);
  }
}

function clipDuration() {
  const m = logs('^FILM loaded').pop()?.match(/loaded \S+ ([\d.]+) s/);
  return m ? Number(m[1]) : 30;
}

function targets() {
  const r = iw(['xr', 'list-targets']);
  const list = r?.data?.result?.targets ?? r?.data?.targets ?? r?.result?.targets ?? r?.targets ?? r?.data?.result ?? [];
  return Array.isArray(list) ? list : [];
}

function centerOf(t) {
  const c = t.center ?? t.box?.center ?? t.worldPosition ?? t.position;
  if (Array.isArray(c)) return { x: c[0], y: c[1], z: c[2] };
  return c;
}

const GRABBABLE = ['coconuts', 'thunder', 'whistle', 'glass'];
/** The named target a prop answers to: grabbable props expose their invisible hit box. */
const targetName = (prop) => (GRABBABLE.includes(prop) ? `hit-${prop}` : prop === 'clapper' ? 'clapper' : `prop-${prop}`);

async function pinchAt(name, lift = 0.03) {
  const list = targets();
  const t = list.find((x) => (x.name ?? x.id ?? '') === name);
  if (!t) throw new Error(`target ${name} not found; have: ${list.map((x) => x.name ?? x.id).join(', ')}`);
  const c = centerOf(t);
  const target = { x: c.x, y: c.y + lift, z: c.z };
  if (glasses) {
    iw(['xr', 'look-at'], { device: 'gaze', target });
    await sleep(400);
    iw(['xr', 'select'], { device: 'hand-right' });
  } else {
    iw(['xr', 'look-at'], { device: 'hand-right', target });
    await sleep(250);
    iw(['xr', 'select'], { device: 'hand-right' });
  }
  await sleep(cuesMode ? 150 : 500);
  if (!cuesMode) log('pinched', name, JSON.stringify(target));
}

/** Pinch each cue's prop at the cue's time, from the TAKE start log's own timestamp. */
async function playCues(startLine) {
  const clipId = startLine.split(' ')[2];
  const sheet = JSON.parse(readFileSync(`public/clips/${clipId}.json`, 'utf8'));
  const r = iw(['browser', 'logs'], { pattern: '^TAKE start', count: 5 });
  const items = r?.data?.result ?? [];
  const startAt = items.length ? items[items.length - 1].timestamp : Date.now();
  const skip = new Set(typeof cuesMode === 'string' ? cuesMode.split(',').map(Number) : []);
  const cues = [...sheet.cues].sort((a, b) => a.t - b.t);
  let lastDone = 0;
  let drift = 0; // wall ms the film clock has fallen behind, measured from each HIT's film time
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (skip.has(i)) {
      log(`cue ${i} ${cue.t}s ${cue.prop} skipped on purpose`);
      continue;
    }
    const due = startAt + FILM_LAG_MS + cue.t * 1000 + drift - PINCH_LEAD_MS;
    const wait = due - Date.now();
    if (wait < -1500) {
      log(`cue ${i} ${cue.t}s ${cue.prop} missed (behind by ${-wait} ms)`);
      continue;
    }
    if (wait > 0) await sleep(wait);
    await pinchAt(targetName(cue.prop), 0.045);
    lastDone = Date.now();
    const hit = logs('^HIT ', 3).pop();
    const filmT = hit ? Number(hit.split(' ')[3]) : NaN;
    if (Number.isFinite(filmT)) {
      drift = Math.max(0, lastDone - startAt - FILM_LAG_MS - filmT * 1000 - 600); // the select lands about 600 ms before the log
    }
    log(`cue ${i} ${cue.t}s ${cue.prop} '${cue.label}' pinched -> ${hit ? hit.split(' ').slice(1, 4).join(' ') : 'no hit'} drift ${drift} ms`);
  }
  return lastDone;
}

async function waitReady(maxMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const st = iw(['dev', 'status']);
      if (st?.data?.state?.browserCommandReady) return true;
    } catch {
      // the runtime is still coming up
    }
    await sleep(2000);
  }
  throw new Error('browser command bridge not ready');
}

async function main() {
  await waitReady();
  // start from a fresh page, so no earlier take is still rolling (--keep leaves the page as it is, e.g. for recording)
  try {
    if (opt('keep', false)) throw new Error('kept');
    iw(['browser', 'reload']);
    await sleep(4000);
    await waitReady();
  } catch (e) {
    log('reload skipped:', String(e.message).split('\n')[0]);
  }
  // the stage is placed for the head's height soon after entering, so the head takes its seat first
  const HEAD = { x: 0, y: 1.2, z: 0 };
  const placedFor = () => {
    const l = logs('^STAGE placed').filter((x) => x.endsWith('xr')).pop();
    return l ? Number(l.split(' ')[2].split(',')[1]) : null;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = iw(['xr', 'status']);
    const active = status?.data?.result?.sessionActive ?? status?.data?.sessionActive ?? status?.sessionActive;
    if (!active) iw(['xr', 'enter']);
    iw(['xr', 'set-transform'], { device: 'headset', position: HEAD });
    iw(['xr', 'set-input-mode'], { mode: 'hand' });
    iw(['xr', 'set-transform'], { device: 'hand-right', position: { x: 0.15, y: 1.3, z: -0.25 } });
    const n0 = logs('^STAGE placed').filter((x) => x.endsWith('xr')).length;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      if (logs('^STAGE placed').filter((x) => x.endsWith('xr')).length > n0 || (attempt === 0 && active)) break;
    }
    const y = placedFor();
    if (y !== null && Math.abs(y - (HEAD.y - 0.25)) < 0.02) break;
    log('stage placed for another height', y, '- entering again');
    iw(['xr', 'exit']);
    await sleep(1500);
  }
  log('stage:', logs('^STAGE ').slice(-2).join(' | '));
  log('film:', logs('^FILM ').slice(-2).join(' | '));
  if (perf) {
    // the stage logs its draw calls once every model is in (or has failed)
    let line = null;
    for (let i = 0; i < 30 && !line; i++) {
      await sleep(1000);
      line = logs('^PERF ').pop() ?? null;
    }
    log('perf:', line ?? 'no PERF log in 30 s');
    const calls = line ? Number((line.match(/calls (\d+)/) ?? [])[1]) : NaN;
    const models = line ? line.match(/models (\d+)\/(\d+)/) : null;
    if (!line || !(calls <= 100) || (models && models[1] !== models[2])) {
      console.error('FAIL: perf (want every model in and draw calls <= 100)');
      process.exit(1);
    }
  }
  if (fov) {
    iw(['xr', 'set-device-state'], { state: { fov: Number(fov) } });
    await sleep(1000);
  }
  shot('00-stage');
  if (record) {
    recorder = spawn(process.execPath, ['tools/xr/record-cdp.mjs'], { env: { ...process.env, REC_DIR: String(record), REC_SECONDS: '420' }, stdio: ['ignore', 'inherit', 'inherit'] });
    await sleep(2500);
  }
  const clapAt = Date.now() - 1000;
  await pinchAt('clapper');
  await sleep(1200);
  shot('01-rolling');
  const started = logsSince('^TAKE start', clapAt);
  log('take:', started.join(' | '));
  if (!started.length) {
    console.error('FAIL: no TAKE start log');
    await stopRecorder();
    process.exit(1);
  }
  if (until === 'start') return log('PASS start');
  if (cuesMode) {
    await playCues(started[started.length - 1]);
  } else {
    for (const p of ['coconuts', 'door', 'bell', 'whistle']) {
      await pinchAt(targetName(p));
    }
  }
  shot('02-hits');
  const hits = logsSince('^HIT ', clapAt);
  log('hits:', hits.join(' | '));
  if (hits.length < (cuesMode ? 6 : 4)) {
    console.error(`FAIL: expected ${cuesMode ? 6 : 4} HIT logs`);
    await stopRecorder();
    process.exit(1);
  }
  if (until === 'hits') return log('PASS hits');
  const dur = clipDuration();

  log(`waiting for the clip to end (${dur.toFixed(0)} s)`);
  const giveUp = Date.now() + Math.min(300, dur * 1.4 + 10) * 1000;
  let ended = [];
  while (Date.now() < giveUp) {
    await sleep(2000);
    ended = logsSince('^TAKE end', clapAt);
    if (ended.length) break;
  }
  await sleep(1500);
  shot('03-end');
  log('end:', ended.join(' | '));
  const replay = logs('^REPLAY ');
  log('replay:', replay.join(' | '));
  if (!ended.length) {
    console.error('FAIL: no TAKE end');
    await stopRecorder();
    process.exit(1);
  }
  if (until !== 'review') return log('PASS replay');
  // the Director's review: within 2.5 s of the take's end, from the model or the rules
  let review = [];
  for (let i = 0; i < 8 && !review.length; i++) {
    await sleep(500);
    review = logsSince('^DIRECTOR review', clapAt);
  }
  shot('04-review');
  log('director:', logs('^DIRECTOR').join(' | '));
  if (!review.length) {
    console.error('FAIL: no DIRECTOR review log');
    process.exit(1);
  }
  const source = review[review.length - 1].split(' ')[2];
  const want = state === 'offline' ? 'rules' : state === 'online' ? 'model' : null;
  if (want && source !== want) {
    console.error(`FAIL: review came from ${source}, expected ${want}`);
    process.exit(1);
  }
  log('PASS review', source);
}

main()
  .then(() => stopRecorder())
  .catch(async (e) => {
    console.error('FAIL', e.message);
    await stopRecorder();
    process.exit(1);
  });
