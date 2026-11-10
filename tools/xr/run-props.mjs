#!/usr/bin/env node
// Drives each prop with a natural hand sequence in the emulator and checks the hit it should make.
// Requires the dev runtime (`iwsdk dev up --ai-mode agent --allow-browser-automation`).
// Usage: node tools/xr/run-props.mjs [--all] [--only coconuts,door] [--shots qa/props] [--glasses]
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
  if (res?.warnings?.length) log('warnings:', JSON.stringify(res.warnings).slice(0, 300));
  return res;
}

// relative-to-head positions: x right, y up, z back (negative = forward)
const shake = (dx, z, n, amp = 0.09) => {
  const steps = [];
  for (let i = 0; i < n; i++) {
    steps.push({ label: `up${i}`, position: { relativeTo: 'head', x: dx, y: -0.08, z }, anchor: 'grasp', duration: 0.14 });
    steps.push({ label: `down${i}`, position: { relativeTo: 'head', x: dx, y: -0.08 - amp, z }, anchor: 'grasp', duration: 0.14 });
  }
  return steps;
};

const PLANS = {
  coconuts: {
    expect: /^HIT coconuts clop/,
    min: 3,
    steps: [
      { label: 'grab', target: 'prop-coconuts', approach: { distance: 0.06 }, pinch: { value: 1, at: 'arrival' } },
      { label: 'lift', position: { relativeTo: 'head', x: -0.2, y: -0.1, z: -0.55 }, anchor: 'grasp', duration: 0.4 },
      ...shake(-0.2, -0.55, 4),
      { label: 'release', pinch: 0, duration: 0.15 },
    ],
  },
  thunder: {
    expect: /^HIT thunder rumble/,
    min: 1,
    steps: [
      { label: 'grab', target: 'prop-thunder', approach: { distance: 0.06 }, pinch: { value: 1, at: 'arrival' } },
      { label: 'lift', position: { relativeTo: 'head', x: 0.1, y: -0.05, z: -0.6 }, anchor: 'grasp', duration: 0.4 },
      ...shake(0.1, -0.6, 5, 0.12),
      { label: 'release', pinch: 0, duration: 0.15 },
    ],
  },
  whistle: {
    expect: /^HIT whistle/,
    min: 1,
    steps: [
      { label: 'grab', target: 'prop-whistle', approach: { distance: 0.06 }, pinch: { value: 1, at: 'arrival' } },
      { label: 'pull up', position: { relativeTo: 'head', x: 0.24, y: 0.05, z: -0.6 }, anchor: 'grasp', duration: 0.9 },
      { label: 'pull down', position: { relativeTo: 'head', x: 0.24, y: -0.18, z: -0.6 }, anchor: 'grasp', duration: 0.9 },
      { label: 'release', pinch: 0, duration: 0.15 },
    ],
  },
  glass: {
    expect: /^HIT glass crash/,
    min: 1,
    steps: [
      { label: 'grab', target: 'prop-glass', approach: { distance: 0.06 }, pinch: { value: 1, at: 'arrival' } },
      { label: 'lift', position: { relativeTo: 'head', x: 0.3, y: 0.0, z: -0.65 }, anchor: 'grasp', duration: 0.6 },
      { label: 'drop', pinch: 0, duration: 0.1 },
      { label: 'away', position: { relativeTo: 'head', x: 0.3, y: -0.1, z: -0.4 }, anchor: 'grasp', duration: 0.5 },
    ],
  },
  door: {
    expect: /^HIT door (knock|slam)/,
    min: 1,
    steps: [{ label: 'knock', target: 'prop-door', press: { depth: 0.01, hold: 0.12, retract: 0.05 } }],
  },
  bell: {
    expect: /^HIT bell ding/,
    min: 1,
    steps: [{ label: 'ding', target: 'prop-bell', press: { depth: 0.008, hold: 0.1, retract: 0.05 } }],
  },
};

async function main() {
  await waitReady();
  const st = iw(['xr', 'status']);
  if (!(st?.data?.result?.sessionActive ?? st?.data?.sessionActive)) {
    iw(['xr', 'enter']);
    await sleep(3000);
  }
  iw(['xr', 'set-transform'], { device: 'headset', position: { x: 0, y: 1.2, z: 0 } });
  iw(['xr', 'set-input-mode'], { mode: 'hand' });
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    if (logs('^STAGE placed').some((l) => l.endsWith('xr'))) break;
  }
  const picks = only ? only.split(',') : Object.keys(PLANS);
  const results = {};
  for (const prop of picks) {
    const plan = PLANS[prop];
    const before = logs(plan.expect.source).length;
    log(`-- ${prop}`);
    try {
      const res = sequence(plan.steps);
      log('events:', JSON.stringify(res?.events ?? []).slice(0, 200));
    } catch (e) {
      log('sequence failed:', String(e.message).split('\n')[0]);
    }
    await sleep(800);
    shot(`${prop}`);
    const after = logs(plan.expect.source).length;
    const n = after - before;
    results[prop] = n;
    log(`${prop}: ${n} hit(s)`, n >= plan.min ? 'PASS' : 'FAIL');
    // put the hand back out of the way
    try {
      iw(['xr', 'set-transform'], { device: 'hand-right', position: { x: 0.15, y: 1.0, z: -0.25 } });
    } catch {}
    await sleep(1200);
  }
  const grab = logs('^(GRAB|RELEASE) ');
  log('grab log:', grab.slice(-8).join(' | '));
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
