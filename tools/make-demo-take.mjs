#!/usr/bin/env node
// Builds the landing page's demo take from a clip's cue sheet: a plausible human performance
// (most cues hit, a couple late, one missed), written to public/takes/<id>-demo.json.
// Usage: node tools/make-demo-take.mjs one-week
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const id = process.argv[2] ?? 'one-week';
const root = resolve(import.meta.dirname, '..');
const clip = JSON.parse(readFileSync(resolve(root, 'public/clips', `${id}.json`), 'utf8'));

const KIND = { coconuts: 'clop', door: 'knock', bell: 'ding', thunder: 'rumble', whistle: 'whistle', glass: 'crash' };
// deterministic pseudo-random so the file is reproducible
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const events = [];
clip.cues.forEach((cue, i) => {
  if (i === Math.floor(clip.cues.length / 3)) return; // one cue missed entirely
  const late = i === Math.floor(clip.cues.length / 2) ? 0.9 : 0; // one fashionably late
  const jitter = (rnd() - 0.4) * 0.3 + late;
  const t = Math.max(0, cue.t + jitter);
  if (cue.prop === 'coconuts') {
    // a gallop: four clops, alternating shells
    for (let k = 0; k < 4; k++) events.push({ t: +(t + k * 0.22).toFixed(2), prop: 'coconuts', kind: 'clop', v: +(0.6 + rnd() * 0.4).toFixed(2), hand: k % 2 ? 'left' : 'right' });
  } else if (cue.prop === 'door' && /slam|shut|bang/i.test(cue.label)) {
    events.push({ t: +t.toFixed(2), prop: 'door', kind: 'slam', v: 1, hand: 'right' });
  } else {
    events.push({ t: +t.toFixed(2), prop: cue.prop, kind: KIND[cue.prop], v: +(0.7 + rnd() * 0.3).toFixed(2), hand: 'right' });
  }
});
events.sort((a, b) => a.t - b.t);
const take = { clipId: id, events, startedAt: '2026-11-16T10:00:00Z', note: 'demo take built from the cue sheet by tools/make-demo-take.mjs' };
mkdirSync(resolve(root, 'public/takes'), { recursive: true });
writeFileSync(resolve(root, 'public/takes', `${id}-demo.json`), JSON.stringify(take, null, 1) + '\n');
console.log(`public/takes/${id}-demo.json`, events.length, 'events from', clip.cues.length, 'cues');
