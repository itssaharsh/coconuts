#!/usr/bin/env node
// Scripted emulator run of the judge path, through the IWSDK CLI.
// Requires: `npx iwsdk dev up --ai-mode agent --allow-browser-automation` (with LD_LIBRARY_PATH for libasound on this box).
// Usage: node tools/xr/run-take.mjs [--until start|hits|replay|review] [--state offline|online] [--shots qa/take] [--glasses]
// --until review waits for the Director's review line after the take; --state says where it must come from
// (offline: the rules, as on the dev server with no /api; online: the model).
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
  await sleep(500);
  log('pinched', name, JSON.stringify(target));
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
  // start from a fresh page, so no earlier take is still rolling
  try {
    iw(['browser', 'reload']);
    await sleep(4000);
    await waitReady();
  } catch (e) {
    log('reload skipped:', String(e.message).split('\n')[0]);
  }
  const status = iw(['xr', 'status']);
  const active = status?.data?.result?.sessionActive ?? status?.data?.sessionActive ?? status?.sessionActive;
  if (!active) {
    iw(['xr', 'enter']);
    await sleep(3000);
  }
  iw(['xr', 'set-transform'], { device: 'headset', position: { x: 0, y: 1.2, z: 0 } });
  iw(['xr', 'set-input-mode'], { mode: 'hand' });
  iw(['xr', 'set-transform'], { device: 'hand-right', position: { x: 0.15, y: 1.0, z: -0.25 } });
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    if (logs('^STAGE placed').some((l) => l.endsWith('xr'))) break;
  }
  log('stage:', logs('^STAGE ').slice(-2).join(' | '));
  log('film:', logs('^FILM ').slice(-2).join(' | '));
  shot('00-stage');
  const startedBefore = logs('^TAKE start').length;
  await pinchAt('clapper');
  await sleep(1200);
  shot('01-rolling');
  const started = logs('^TAKE start').slice(startedBefore);
  log('take:', started.join(' | '));
  if (!started.length) {
    console.error('FAIL: no TAKE start log');
    process.exit(1);
  }
  if (until === 'start') return log('PASS start');
  const hitsBefore = logs('^HIT ').length;
  for (const p of ['coconuts', 'door', 'bell', 'whistle']) {
    await pinchAt(targetName(p));
  }
  shot('02-hits');
  const hits = logs('^HIT ').slice(hitsBefore);
  log('hits:', hits.join(' | '));
  if (hits.length < 4) {
    console.error('FAIL: expected 4 HIT logs');
    process.exit(1);
  }
  if (until === 'hits') return log('PASS hits');
  const dur = clipDuration();
  const endedBefore = logs('^TAKE end').length;
  const reviewBefore = logs('^DIRECTOR review').length;
  log(`waiting for the clip to end (${dur.toFixed(0)} s)`);
  await sleep(Math.min(200, dur + 4) * 1000);
  shot('03-end');
  const ended = logs('^TAKE end').slice(endedBefore);
  log('end:', ended.join(' | '));
  const replay = logs('^REPLAY ');
  log('replay:', replay.join(' | '));
  if (!ended.length) {
    console.error('FAIL: no TAKE end');
    process.exit(1);
  }
  if (until !== 'review') return log('PASS replay');
  // the Director's review: within 2.5 s of the take's end, from the model or the rules
  let review = [];
  for (let i = 0; i < 8 && !review.length; i++) {
    await sleep(500);
    review = logs('^DIRECTOR review').slice(reviewBefore);
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

main().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
