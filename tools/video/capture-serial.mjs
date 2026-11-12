#!/usr/bin/env node
// Films a reel of the Serial in the emulator as a smooth 30 frames-a-second video with its soundtrack.
// The emulator draws a few frames a second; in a capture run (?capture, kept in the browser's storage) every drawn
// frame is a thirtieth of a second of the show, so the frames played back at 30 a second are the show at full speed.
// The hands are moved in the same slow time. The sound is laid under afterwards from the game's own log of what it
// would have played (tools/video/soundtrack.py).
//
//   node tools/video/capture-serial.mjs --out qa/film/reel1 [--until pitch|end] [--reels 1] [--pitch thunder] [--open bell] [--size 1280x720]
//
// Needs the dev runtime (`iwsdk dev up --ai-mode agent --allow-browser-automation --headless`). Leaves capture mode off.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const out = String(opt('out', 'qa/film/take'));
const until = opt('until', 'pitch');
const reels = Number(opt('reels', 1));
const pitchProp = opt('pitch', null);
const openProp = opt('open', 'bell');
// --start bell: the first clapper rolls that prop's written reel instead of reel one (for clips of the later reels)
const startOn = String(opt('start', '') || '');
const [W, H] = String(opt('size', '1920x1080')).split('x').map(Number);
const maxSeconds = Number(opt('max', 3000));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const CLI = resolve('node_modules/@iwsdk/cli/dist/cli.js');
function iw(cmdArgs, input, timeout = 120000, env = {}) {
  const a = [CLI, ...cmdArgs];
  if (input) a.push('--input-json', JSON.stringify(input));
  const text = execFileSync('node', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, env: { ...process.env, ...env } });
  const start = text.indexOf('{');
  if (start < 0) return text;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return text;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[film]', ...m);
function entries(pattern, count = 200) {
  const r = iw(['browser', 'logs'], { pattern, count });
  const items = r?.data?.result ?? r?.result ?? [];
  return (Array.isArray(items) ? items : []).map((x) => (typeof x === 'string' ? { message: x, timestamp: 0 } : { message: x.message ?? '', timestamp: x.timestamp ?? 0 }));
}
const since = (pattern, t) => entries(pattern).filter((e) => e.timestamp >= t);
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
const targetName = (prop) => (GRABBABLE.includes(prop) ? `hit-${prop}` : prop === 'clapper' ? 'clapper' : prop === 'megaphone' ? 'megaphone' : `prop-${prop}`);

// every sound the app logs, kept as it comes (the console buffer is a ring)
const sounds = new Map();
const events = new Map();
function collect(t0) {
  for (const e of since('^SND ', t0)) sounds.set(`${e.timestamp}|${e.message}`, e.message);
  for (const e of since('^EVT ', t0)) events.set(`${e.timestamp}|${e.message}`, e.message);
}

/** Real seconds that one second of the show takes right now, from the app's FRAME lines. */
function slowdown(t0) {
  const f = since('^FRAME ', t0).slice(-6);
  if (f.length < 2) return 8;
  const a = f[0];
  const b = f[f.length - 1];
  const show = Number(b.message.split(' ')[2]) - Number(a.message.split(' ')[2]);
  const real = (b.timestamp - a.timestamp) / 1000;
  return show > 0 ? Math.max(1, Math.min(30, real / show)) : 8;
}

let cache = null;
let slow = 8;
/** Seconds of the show that one second of an emulator hand animation takes (measured before the take). */
let animRate = 0.3;
const REST = { x: 0.36, y: 0.98, z: -0.2 };

function centreOf(name) {
  cache ??= targets();
  const t = cache.find((x) => (x.name ?? x.id ?? '') === name);
  if (!t) throw new Error(`target ${name} not found; have: ${cache.map((x) => x.name ?? x.id).join(', ')}`);
  const c0 = t.center ?? t.box?.center ?? t.worldPosition ?? t.position;
  const c = Array.isArray(c0) ? { x: c0[0], y: c0[1], z: c0[2] } : c0;
  const size = t.size ?? t.box?.size ?? { x: 0.1, y: 0.1, z: 0.1 };
  return { ...c, bottom: c.y - size.y / 2 };
}

/** Move the right hand's fingertip to a point over `showSecs` of the show (the emulator animates in its own time). */
function reach(position, showSecs, easing = 'minimum-jerk') {
  iw(['xr', 'animate-to'], { device: 'hand-right', position, duration: Math.max(0.05, showSecs / animRate), easing, anchor: 'index-tip', orientation: 'auto' }, 400000);
}

/** Tip the head down (negative degrees) or back level, over `showSecs` of the show. */
function look(pitch, showSecs) {
  iw(['xr', 'animate-to'], { device: 'headset', orientation: { pitch, yaw: 0, roll: 0 }, duration: Math.max(0.05, showSecs / animRate), easing: 'minimum-jerk' }, 400000);
}

/** How fast the emulator's animations run against the show's clock: time one, and compare with the slow-down. */
function calibrate() {
  const t0 = Date.now();
  reach({ x: REST.x, y: REST.y + 0.002, z: REST.z }, 0.0001, 'linear'); // (the cost of a call by itself)
  const overhead = (Date.now() - t0) / 1000;
  const D = 2;
  const t1 = Date.now();
  iw(['xr', 'animate-to'], { device: 'hand-right', position: { x: REST.x, y: REST.y + 0.05, z: REST.z }, duration: D, easing: 'linear', anchor: 'index-tip', orientation: 'auto' }, 400000);
  const real = Math.max(0.2, (Date.now() - t1) / 1000 - overhead);
  animRate = Math.max(0.05, Math.min(2, real / slow / D));
  reach(REST, 0.2);
  log('hand animations: one emulator second is', animRate.toFixed(2), 'show seconds (call overhead', overhead.toFixed(1), 's)');
}

/** A pat with an open hand, in the show's slow time: reach over the prop, tap it `times`, come back to rest. */
async function pat(prop, times = 1) {
  // the fingertip goes to the thing itself (a touch is the finger on its shape, not in its hit box): upright
  // pieces are rapped on their face, low ones patted from above
  const c = centreOf(targetName(prop));
  const upright = prop === 'door' || prop === 'thunder';
  const over = upright ? { x: c.x, y: c.bottom + 0.07, z: c.z + 0.11 } : { x: c.x, y: c.bottom + 0.125, z: c.z + 0.01 };
  const down = upright ? { x: c.x, y: c.bottom + 0.07, z: c.z + 0.028 } : { x: c.x, y: c.bottom + 0.028, z: c.z + 0.01 };
  reach(over, 0.4);
  for (let i = 0; i < times; i++) {
    reach(down, 0.09, 'linear');
    await sleep(Math.max(900, 0.08 * slow * 1000)); // long enough to be drawn in a frame or two
    reach(over, 0.11, 'linear');
    if (i < times - 1) await sleep(0.05 * slow * 1000);
  }
  reach(REST, 0.45);
}

async function main() {
  await waitReady();
  log(JSON.stringify(iw(['browser', 'run', 'tools/video/flag.mjs'], null, 60000, { CAPTURE: '1', REEL: startOn })?.data?.result ?? {}));
  iw(['browser', 'reload']);
  await sleep(5000);
  await waitReady();
  const HEAD = { x: 0, y: 1.2, z: 0 };
  const boot = Date.now() - 8000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = iw(['xr', 'status']);
    if (!(status?.data?.result?.sessionActive ?? status?.data?.sessionActive)) iw(['xr', 'enter']);
    iw(['xr', 'set-transform'], { device: 'headset', position: HEAD });
    iw(['xr', 'set-input-mode'], { mode: 'hand' });
    iw(['xr', 'set-transform'], { device: 'hand-right', position: { x: 0.36, y: 0.98, z: -0.2 } });
    iw(['xr', 'set-transform'], { device: 'hand-left', position: { x: -0.4, y: 0.95, z: -0.16 } });
    let placed = null;
    for (let i = 0; i < 20 && placed === null; i++) {
      await sleep(1000);
      const l = entries('^STAGE placed').map((e) => e.message).filter((x) => x.endsWith('xr')).pop();
      const y = l ? Number(l.split(' ')[2].split(',')[1]) : null;
      if (y !== null && Math.abs(y - (HEAD.y - 0.38)) < 0.02) placed = y;
    }
    if (placed !== null) break;
    iw(['xr', 'exit']);
    await sleep(1500);
  }
  if (!since('^CAPTURE on', boot).length && !entries('^CAPTURE on').length) throw new Error('the app is not in capture mode');
  for (let i = 0; i < 90 && !entries('^SERIAL ready').length; i++) await sleep(1000);
  cache = targets();
  slow = slowdown(boot);
  log('slow time: one show second takes', slow.toFixed(1), 'real seconds');
  calibrate();

  const rec = spawn(process.execPath, ['tools/xr/record-cdp.mjs'], {
    env: { ...process.env, REC_DIR: out, REC_SECONDS: String(maxSeconds), REC_FPS: '240', REC_W: String(W), REC_H: String(H), REC_QUALITY: '93' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await sleep(4000);
  const t0 = Date.now() - 500;
  // a breath on the marquee, then the clapper
  await sleep(1.5 * slow * 1000);
  await pat('clapper');
  let lastWait = 0;
  let reelsDone = 0;
  const begun = Date.now();
  while (Date.now() - begun < maxSeconds * 1000) {
    collect(t0);
    slow = slowdown(Date.now() - 20000);
    const ends = since('^REEL end', t0).length;
    if (ends > reelsDone) {
      reelsDone = ends;
      let offer = null;
      for (let i = 0; i < 30 && !offer; i++) {
        offer = since('^PITCH [a-z]+:', t0).pop() ?? null;
        if (!offer) await sleep(1000);
      }
      if (until === 'end' && reelsDone >= reels) break;
      // hold on the card long enough to read it
      await sleep(3.5 * slow * 1000);
      if (reelsDone >= reels || !offer) break;
      const offered = offer.message.replace(/^PITCH /, '').split(' | ').map((x) => x.split(':')[0].trim());
      await pat(pitchProp && offered.includes(pitchProp) ? pitchProp : offered[1] ?? offered[0]);
      continue;
    }
    const w = since('^WAIT ', t0).pop();
    if (w && w.timestamp > lastWait) {
      lastWait = w.timestamp;
      const [, kind, prop, progress] = w.message.split(' ');
      log(w.message);
      // the player reads the cue for a moment before answering
      await sleep(0.9 * slow * 1000);
      const play = prop === 'any' ? openProp : prop;
      const label = w.message.split(' ').slice(4).join(' ');
      if (kind === 'ride') {
        for (let i = 0; i < 4 && !since('^CUE (hit|miss) ride', lastWait).length; i++) await pat(play, 4);
      } else {
        const [got, need] = progress.split('/').map(Number);
        await pat(play, Math.max(1, need - got));
        // the film breaks out: the player looks down at the desk, where the thief has landed, until he is over its edge
        if (/jumps/i.test(label)) {
          await sleep(1.6 * slow * 1000);
          look(-24, 0.7);
        } else if (/edge/i.test(label)) {
          await sleep(2.6 * slow * 1000);
          look(0, 0.8);
        }
      }
    } else await sleep(500);
  }
  await sleep(2 * slow * 1000);
  collect(t0);
  rec.kill('SIGTERM');
  await new Promise((r) => rec.once('exit', r));
  writeFileSync(join(out, 'log.txt'), [...sounds.values()].join('\n') + '\n');
  // what happened in the story, on the show's clock: `EVT <seconds> <line>` (cues, cards, scene changes)
  writeFileSync(join(out, 'events.txt'), [...events.values()].join('\n') + '\n');
  iw(['browser', 'run', 'tools/video/flag.mjs'], null, 60000, { CAPTURE: '0', REEL: '' });

  // picture: every captured frame is a thirtieth of a second
  const frames = JSON.parse(readFileSync(join(out, 'frames.json'), 'utf8'));
  const mark = existsSync(join(out, 'mark.json')) ? JSON.parse(readFileSync(join(out, 'mark.json'), 'utf8')) : { clock: 0, frame: 0 };
  const endMark = existsSync(join(out, 'mark-end.json')) ? JSON.parse(readFileSync(join(out, 'mark-end.json'), 'utf8')) : null;
  const seconds = frames.length / 30;
  log('frames', frames.length, '=', seconds.toFixed(1), 's of film; show clock ran', endMark ? (endMark.clock - mark.clock).toFixed(1) : '?', 's');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(out, 'frame-%05d.jpg'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '17', join(out, 'picture.mp4')]);
  try {
    execFileSync('python3', ['tools/video/soundtrack.py', join(out, 'log.txt'), join(out, 'sound.m4a'), '--offset', String(mark.clock), '--length', seconds.toFixed(2)], { stdio: 'inherit' });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(out, 'picture.mp4'), '-i', join(out, 'sound.m4a'), '-c:v', 'copy', '-c:a', 'copy', '-shortest', join(out, 'film.mp4')]);
    log('wrote', join(out, 'film.mp4'));
  } catch (e) {
    log('no soundtrack:', String(e.message).split('\n')[0], '- the picture is', join(out, 'picture.mp4'));
  }
}
main().catch((e) => {
  console.error('FAIL:', e.message);
  try {
    iw(['browser', 'run', 'tools/video/flag.mjs'], null, 60000, { CAPTURE: '0', REEL: '' });
  } catch {}
  process.exit(1);
});
