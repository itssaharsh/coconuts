#!/usr/bin/env node
// Plays a reel of the Serial in the emulator the way a seated player would: pinch the clapper, then answer every
// moment the stage waits for (the WAIT lines it logs) by pointing at the prop it wants and pinching.
// Requires the dev runtime (`iwsdk dev up --ai-mode agent --allow-browser-automation --headless`).
// Usage: node tools/xr/run-serial.mjs [--shots qa/serial] [--until ride|open|end] [--silent] [--open bell] [--reels 2] [--pitch thunder] [--glasses]
// --silent: answer nothing, to prove the reel reaches its end by itself. --open: the prop played at open moments.
// --reels N: after a reel, answer "What happens next?" with --pitch's prop (default: the second one offered) and play on.
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
const shots = opt('shots', null);
const until = opt('until', 'end');
const silent = !!opt('silent', false);
const openProp = opt('open', 'bell');
const glasses = !!opt('glasses', false);
const maxSeconds = Number(opt('max', 420));
const reels = Number(opt('reels', 1));
const pitchProp = opt('pitch', null);
if (shots) mkdirSync(shots, { recursive: true });

const CLI = resolve('node_modules/@iwsdk/cli/dist/cli.js');
function iw(cmdArgs, input, timeout = 90000) {
  const a = [CLI, ...cmdArgs];
  if (input) a.push('--input-json', JSON.stringify(input));
  const out = execFileSync('node', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
  const start = out.indexOf('{');
  if (start < 0) return out;
  try {
    return JSON.parse(out.slice(start));
  } catch {
    return out;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[serial]', ...m);
function entries(pattern, count = 120) {
  const r = iw(['browser', 'logs'], { pattern, count });
  const items = r?.data?.result ?? r?.result ?? [];
  return (Array.isArray(items) ? items : []).map((x) => (typeof x === 'string' ? { message: x, timestamp: 0 } : { message: x.message ?? '', timestamp: x.timestamp ?? 0 }));
}
const since = (pattern, t) => entries(pattern).filter((e) => e.timestamp >= t);
let shotN = 0;
function shot(name) {
  if (!shots) return;
  try {
    iw(['browser', 'screenshot', '--output-file', `${shots}/${String(++shotN).padStart(2, '0')}-${name}.png`]);
  } catch (e) {
    log('shot failed', name, String(e.message).split('\n')[0]);
  }
}
async function waitReady(maxMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      if (iw(['dev', 'status'])?.data?.state?.browserCommandReady) return;
    } catch {}
    await sleep(2000);
  }
  throw new Error('browser command bridge not ready');
}
function targets() {
  const r = iw(['xr', 'list-targets']);
  const list = r?.data?.result?.targets ?? r?.data?.targets ?? r?.data?.result ?? [];
  return Array.isArray(list) ? list : [];
}
const GRABBABLE = ['coconuts', 'thunder', 'whistle', 'glass'];
const targetName = (prop) => (GRABBABLE.includes(prop) ? `hit-${prop}` : prop === 'clapper' ? 'clapper' : `prop-${prop}`);
let targetCache = null;
/** Point at a prop from where the hand rests and pinch: the far pinch every prop answers with its sound. */
async function pinch(prop) {
  targetCache ??= targets();
  const name = targetName(prop);
  const t = targetCache.find((x) => (x.name ?? x.id ?? '') === name);
  if (!t) throw new Error(`target ${name} not found; have: ${targetCache.map((x) => x.name ?? x.id).join(', ')}`);
  const c0 = t.center ?? t.box?.center ?? t.worldPosition ?? t.position;
  const c = Array.isArray(c0) ? { x: c0[0], y: c0[1], z: c0[2] } : c0;
  const target = { x: c.x, y: c.y + 0.03, z: c.z };
  iw(['xr', 'look-at'], { device: glasses ? 'gaze' : 'hand-right', target });
  await sleep(glasses ? 400 : 200);
  iw(['xr', 'select'], { device: 'hand-right' });
}

async function main() {
  await waitReady();
  try {
    // the Serial remembers its place between visits: a test starts from reel one
    iw(['browser', 'run', 'tools/xr/clear-save.mjs']);
  } catch (e) {
    log('could not clear the saved place:', String(e.message).split('\n')[0]);
  }
  try {
    iw(['browser', 'reload']);
    await sleep(4000);
    await waitReady();
  } catch (e) {
    log('reload skipped:', String(e.message).split('\n')[0]);
  }
  const HEAD = { x: 0, y: 1.2, z: 0 };
  const TABLE_Y = HEAD.y - 0.38;
  const placedFor = () => {
    const l = entries('^STAGE placed').map((e) => e.message).filter((x) => x.endsWith('xr')).pop();
    return l ? Number(l.split(' ')[2].split(',')[1]) : null;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = iw(['xr', 'status']);
    const active = status?.data?.result?.sessionActive ?? status?.data?.sessionActive;
    if (!active) iw(['xr', 'enter']);
    iw(['xr', 'set-transform'], { device: 'headset', position: HEAD });
    iw(['xr', 'set-input-mode'], { mode: 'hand' });
    iw(['xr', 'set-transform'], { device: 'hand-right', position: { x: 0.44, y: 1.02, z: -0.14 } }); // resting clear of every prop, so a pinch is a far pinch
    iw(['xr', 'set-transform'], { device: 'hand-left', position: { x: -0.46, y: 0.95, z: -0.12 } });
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const y = placedFor();
      if (y !== null && Math.abs(y - TABLE_Y) < 0.02) break;
    }
    const y = placedFor();
    if (y !== null && Math.abs(y - TABLE_Y) < 0.02) break;
    log('stage placed for another height', y, '- entering again');
    iw(['xr', 'exit']);
    await sleep(1500);
  }
  log('stage:', entries('^STAGE ').slice(-1).map((e) => e.message).join(' | '));
  // the theatre loads its first set and cast behind the curtain
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = entries('^SERIAL ready').length > 0;
    if (!ready) await sleep(1000);
  }
  if (!ready) {
    console.error('FAIL: the Serial never became ready');
    log(entries('SERIAL|SET|THEATRE|CAST|rror').slice(-10).map((e) => e.message).join('\n'));
    process.exit(1);
  }
  log(entries('^SET |^REEL |^SERIAL ready|^PERF|^MODELS').slice(-6).map((e) => e.message).join(' | '));
  shot('curtain');
  targetCache = targets(); // before the clapper: listing takes seconds, and the stage does not wait for the driver
  const t0 = Date.now() - 500;
  await pinch('clapper');
  let started = false;
  for (let i = 0; i < 10 && !started; i++) {
    await sleep(700);
    started = since('^REEL start', t0).length > 0;
  }
  if (!started) {
    console.error('FAIL: the clapper did not roll the reel');
    log(since('.', t0).slice(-12).map((e) => e.message).join('\n'));
    process.exit(1);
  }
  log('rolling');
  let lastWait = 0;
  let waits = 0;
  let ended = false;
  let reelsDone = 0;
  const begun = Date.now();
  while (Date.now() - begun < maxSeconds * 1000) {
    const ends = since('^REEL end', t0).length;
    if (ends > reelsDone) {
      reelsDone = ends;
      if (reelsDone >= reels || (until !== 'end' && until !== 'pitch')) {
        ended = true;
        break;
      }
      // between reels: the card asks what happens next; answer it with a prop and wait for the next reel to roll
      let offer = null;
      for (let i = 0; i < 20 && !offer; i++) {
        offer = since('^PITCH [a-z]+:', t0).pop() ?? null;
        if (!offer) await sleep(800);
      }
      if (!offer) {
        console.error('FAIL: no pitches were offered after the reel');
        process.exit(1);
      }
      log(offer.message);
      shot('pitch');
      if (until === 'pitch') break;
      const offered = offer.message.replace(/^PITCH /, '').split(' | ').map((x) => x.split(':')[0].trim());
      const pick = pitchProp && offered.includes(pitchProp) ? pitchProp : offered[1] ?? offered[0];
      const before = since('^REEL start', t0).length;
      for (let i = 0; i < 4 && since('^PITCH chosen', t0).length < reelsDone; i++) await pinch(pick);
      shot('writing');
      let rolled = false;
      for (let i = 0; i < 40 && !rolled; i++) {
        rolled = since('^REEL start', t0).length > before;
        if (!rolled) await sleep(700);
      }
      if (!rolled) {
        console.error('FAIL: the next reel did not roll after the pitch');
        log(since('^(PITCH|REEL|SERIAL|DIRECTOR)', t0).slice(-8).map((e) => e.message).join('\n'));
        process.exit(1);
      }
      log(since('^REEL written', t0).pop()?.message ?? 'next reel rolling');
      continue;
    }
    const w = since('^WAIT ', t0).pop();
    if (w && w.timestamp > lastWait) {
      lastWait = w.timestamp;
      waits++;
      const [, kind, prop, progress] = w.message.split(' ');
      log(w.message);
      if (until !== 'end' && kind === until) {
        shot(`wait-${kind}-${prop}`);
        break;
      }
      if (silent) shot(`wait-${kind}-${prop}`);
      if (!silent) {
        const play = prop === 'any' ? openProp : prop;
        if (kind === 'ride') {
          for (let i = 0; i < 14 && !since('^CUE (hit|miss) ride', lastWait).length; i++) {
            await pinch(play);
            if (i === 5) shot('riding');
          }
        } else {
          const [got, need] = progress.split('/').map(Number);
          for (let i = got; i < need; i++) {
            await pinch(play);
            if (i === got) shot(`wait-${kind}-${prop}`);
          }
        }
        await sleep(1500);
        shot(`after-${kind}-${prop}`);
      }
    } else await sleep(250);
  }
  shot('end');
  const story = since('^(TITLE|CUE|REEL|SET|NUDGE|SCENE|CAST|HIT|PITCH|DIRECTOR)', t0).map((e) => e.message);
  log('story:\n  ' + story.join('\n  '));
  const perf = since('^PERF serial', t0).map((e) => e.message);
  const calls = perf.map((l) => Number((l.match(/calls (\d+)/) ?? [])[1])).filter(Number.isFinite);
  const tris = perf.map((l) => Number((l.match(/triangles (\d+)/) ?? [])[1])).filter(Number.isFinite);
  log('perf: max draw calls', Math.max(0, ...calls), 'max triangles', Math.max(0, ...tris), `(${perf.length} samples)`);
  const errors = since('rror|THEATRE .*failed|failed', t0).map((e) => e.message).filter((m) => !/favicon/.test(m));
  if (errors.length) log('errors:\n  ' + errors.slice(-8).join('\n  '));
  if (until === 'end' && !ended) {
    console.error(`FAIL: ${reelsDone} of ${reels} reel(s) reached the end`);
    process.exit(1);
  }
  log(until === 'end' ? `PASS: ${reelsDone} reel(s) played to the end` : `stopped at ${until}`, `(${waits} waits, ${Math.round((Date.now() - begun) / 1000)} s)`);
}
main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
