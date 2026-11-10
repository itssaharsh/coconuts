#!/usr/bin/env node
// Drives each prop with a natural hand in the emulator and checks the sound it should make.
// Requires the dev runtime (`iwsdk dev up --ai-mode agent --allow-browser-automation`).
// Usage: node tools/xr/run-props.mjs [--only coconuts,door] [--shots qa/props] [--glasses]
// --glasses: the Meta VR Glasses way, gaze at each prop and pinch, which fires its one-shot (needs dev.emulator.device metaVRGlasses).
// Grabs run as one hand sequence (reach, pinch, lift); the shaking that follows is driven by short
// animations, because a sequence smooths every move to a natural reach and that is too slow to strike.
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
const only = opt('only', null);
const glasses = !!opt('glasses', false);
if (shots) mkdirSync(shots, { recursive: true });

const CLI = resolve('node_modules/@iwsdk/cli/dist/cli.js');
function iw(cmdArgs, input, timeout = 120000) {
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
const log = (...m) => console.log('[props]', ...m);
function logs(pattern, count = 120) {
  const r = iw(['browser', 'logs'], { pattern, count });
  const items = r?.data?.result ?? [];
  return (Array.isArray(items) ? items : []).map((x) => (typeof x === 'string' ? x : x.message ?? ''));
}
function shot(name) {
  if (!shots) return;
  try {
    iw(['browser', 'screenshot', '--output-file', `${shots}/${name}.png`]);
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
function sequence(steps) {
  const r = iw(['xr', 'run-sequence'], { device: 'hand-right', steps }, 180000);
  const res = r?.data?.result ?? r;
  if (res?.warnings?.length) log('warnings:', JSON.stringify(res.warnings).slice(0, 200));
  if (res?.completed === false) log('sequence stopped:', res.reason);
  return res;
}
/** Move the right hand's grasp point to a world position in `duration` seconds, at a steady speed. */
function anim(x, y, z, duration) {
  iw(['xr', 'animate-to'], { device: 'hand-right', position: { x, y, z }, duration, easing: 'linear', anchor: 'grasp' }, 30000);
}
function openPinch() {
  iw(['xr', 'set-select-value'], { device: 'hand-right', value: 0 });
}
/** Gaze at a named target's centre and pinch once, as the glasses' player does. */
function gazePinch(name) {
  const r = iw(['xr', 'list-targets']);
  const list = r?.data?.result?.targets ?? r?.data?.result ?? [];
  const t = (Array.isArray(list) ? list : []).find((x) => x.name === name);
  if (!t) throw new Error(`target ${name} not found`);
  const c = t.position ?? t.center ?? t.box?.center;
  const target = Array.isArray(c) ? { x: c[0], y: c[1], z: c[2] } : c;
  iw(['xr', 'look-at'], { device: 'gaze', target });
  return sleep(500).then(() => iw(['xr', 'select'], { device: 'hand-right' }));
}
/** The glasses path: every prop answers a gaze-and-pinch with its one-shot. */
const GAZE = {
  coconuts: { expect: /^HIT coconuts clop/, target: 'hit-coconuts' },
  thunder: { expect: /^HIT thunder rumble/, target: 'hit-thunder' },
  whistle: { expect: /^HIT whistle/, target: 'hit-whistle' },
  glass: { expect: /^HIT glass crash/, target: 'hit-glass' },
  door: { expect: /^HIT door knock/, target: 'prop-door' },
  bell: { expect: /^HIT bell ding/, target: 'prop-bell' },
};

// The head sits at (0, 1.2, 0) facing -Z, so head-relative offsets are world offsets from there.
const HEAD = { x: 0, y: 1.2, z: 0 };
const grab = (target) => ({ label: 'grab', target, approach: { distance: 0.06 }, pinch: { value: 1, at: 'arrival' } });
const lift = (x, y, z) => ({ label: 'lift', position: { relativeTo: 'head', x, y, z }, anchor: 'grasp', duration: 0.5 });
const release = [{ label: 'release', pinch: 0, duration: 0.15 }];

const PLANS = {
  coconuts: {
    expect: /^HIT coconuts clop/,
    min: 3,
    run() {
      sequence([grab('hit-coconuts'), lift(-0.2, -0.05, -0.55)]);
      shot('coconuts-held');
      // four strikes: the hand drops 24 cm in 0.3 s and comes back up
      for (let i = 0; i < 4; i++) {
        anim(HEAD.x - 0.2, HEAD.y - 0.29, HEAD.z - 0.55, 0.3);
        anim(HEAD.x - 0.2, HEAD.y - 0.05, HEAD.z - 0.55, 0.3);
      }
      sequence(release);
    },
  },
  thunder: {
    expect: /^HIT thunder rumble/,
    min: 1,
    run() {
      sequence([grab('hit-thunder'), lift(0.1, -0.05, -0.6)]);
      shot('thunder-held');
      // a vigorous side-to-side shake
      for (let i = 0; i < 5; i++) {
        anim(HEAD.x + 0.26, HEAD.y - 0.05, HEAD.z - 0.6, 0.22);
        anim(HEAD.x - 0.06, HEAD.y - 0.05, HEAD.z - 0.6, 0.22);
      }
      sequence(release);
    },
  },
  whistle: {
    expect: /^HIT whistle/,
    min: 1,
    run() {
      sequence([grab('hit-whistle'), lift(0.24, -0.15, -0.6)]);
      shot('whistle-held');
      anim(HEAD.x + 0.24, HEAD.y + 0.05, HEAD.z - 0.6, 0.9); // slide up
      anim(HEAD.x + 0.24, HEAD.y - 0.18, HEAD.z - 0.6, 0.9); // and down
      sequence(release);
    },
  },
  glass: {
    expect: /^HIT glass crash/,
    min: 1,
    run() {
      sequence([grab('hit-glass'), lift(0.3, 0.0, -0.65)]);
      shot('glass-held');
      sequence(release); // let go from 20 cm up: a drop, not a put-down
    },
  },
  door: {
    expect: /^HIT door (knock|slam)/,
    min: 1,
    run() {
      sequence([{ label: 'knock', target: 'prop-door', press: { depth: 0.01, hold: 0.12, retract: 0.05 } }]);
    },
  },
  bell: {
    expect: /^HIT bell ding/,
    min: 1,
    run() {
      sequence([{ label: 'ding', target: 'prop-bell', press: { depth: 0.008, hold: 0.1, retract: 0.05 } }]);
    },
  },
};

async function main() {
  await waitReady();
  // the stage is placed for the head's height soon after entering, so the head goes to its seat first
  const placedFor = () => {
    const l = logs('^STAGE placed').filter((x) => x.endsWith('xr')).pop();
    return l ? Number(l.split(' ')[2].split(',')[1]) : null;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const st = iw(['xr', 'status']);
    const active = st?.data?.result?.sessionActive ?? st?.data?.sessionActive;
    if (!active) iw(['xr', 'enter']);
    iw(['xr', 'set-transform'], { device: 'headset', position: HEAD });
    iw(['xr', 'set-input-mode'], { mode: 'hand' });
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
  const picks = only ? only.split(',') : Object.keys(PLANS);
  const results = {};
  if (glasses) {
    const st = iw(['xr', 'status'])?.data?.result ?? {};
    log('device:', st.deviceName, 'features:', (st.enabledFeatures ?? []).join(','));
    if (st.deviceName !== 'Meta VR Glasses') log('WARNING: not the glasses profile; set dev.emulator.device to metaVRGlasses');
    // hands rest by the hips; only the gaze aims
    iw(['xr', 'set-transform'], { device: 'hand-right', position: { x: 0.2, y: 0.8, z: -0.1 } });
    iw(['xr', 'set-transform'], { device: 'hand-left', position: { x: -0.2, y: 0.8, z: -0.1 } });
    await sleep(800);
  }
  for (const prop of picks) {
    const plan = glasses ? { expect: GAZE[prop].expect, min: 1, run: () => gazePinch(GAZE[prop].target) } : PLANS[prop];
    const before = logs(plan.expect.source).length;
    log(`-- ${prop}`);
    openPinch();
    try {
      await plan.run();
    } catch (e) {
      log('failed:', String(e.message).split('\n')[0]);
    }
    await sleep(800);
    shot(prop);
    const after = logs(plan.expect.source).length;
    const n = after - before;
    results[prop] = n;
    log(`${prop}: ${n} hit(s)`, n >= plan.min ? 'PASS' : 'FAIL');
    // open the hand and put it out of the way while the prop eases home
    openPinch();
    if (!glasses) {
      try {
        iw(['xr', 'set-transform'], { device: 'hand-right', position: { x: 0.15, y: 1.0, z: -0.25 } });
      } catch {}
    }
    await sleep(glasses ? 600 : 1500);
  }
  log('grab log:', logs('^(GRAB|RELEASE) ').slice(-8).join(' | '));
  const failed = picks.filter((p) => results[p] < PLANS[p].min);
  console.log(JSON.stringify(results));
  if (failed.length) {
    console.error('FAIL:', failed.join(', '));
    process.exit(1);
  }
  log('PASS all');
}

main().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
