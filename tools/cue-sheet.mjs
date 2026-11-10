#!/usr/bin/env node
// cue-sheet.mjs: Gemini watches a trimmed clip and proposes foley cues; prints a diff against the hand-checked sheet.
//
//   node --env-file=<path to .env with GEMINI_API_KEY> tools/cue-sheet.mjs <clip-id>|--all [--model m] [--fps n] [--inline] [--diff-only]
//
// Node 22, no dependencies. Reads public/films/<id>.mp4, writes public/clips/<id>.proposed.json (the raw proposal),
// and never touches public/clips/<id>.json (the shipped sheet is checked by hand against frames).

import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIP_IDS = ['one-week', 'safety-last', 'trip-to-the-moon'];
const PROPS = {
  coconuts: 'coconut shells: hoofbeats, footsteps, running, a horse',
  door: 'a little door: knock, slam, creak (also hammering, a door or window banging)',
  bell: 'a counter bell: ding (a bicycle, a shop bell, a sign revealed, a punchline)',
  thunder: 'a thunder sheet: rumble (storms, trains, engines, collapses, big impacts, explosions)',
  whistle: 'a slide whistle: falls, rises, pratfalls, slips, dizziness, something flying up or down',
  glass: 'a bag of broken glass: crash (breaking, smashing, wreckage, something dropped and shattering)',
};
const PROP_IDS = Object.keys(PROPS);
const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-3-flash-preview'];
const API = 'https://generativelanguage.googleapis.com';
const INLINE_LIMIT = 20 * 1024 * 1024;
const PROMPT_VERSION = 'cue-v1';

function args() {
  const a = process.argv.slice(2);
  const o = { ids: [], models: null, fps: 2, inline: false, diffOnly: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--all') o.ids = [...CLIP_IDS];
    else if (a[i] === '--model') o.models = [a[++i]];
    else if (a[i] === '--fps') o.fps = Number(a[++i]);
    else if (a[i] === '--inline') o.inline = true;
    else if (a[i] === '--diff-only') o.diffOnly = true;
    else if (CLIP_IDS.includes(a[i])) o.ids.push(a[i]);
    else throw new Error(`unknown argument ${a[i]} (clip ids: ${CLIP_IDS.join(', ')})`);
  }
  if (!o.ids.length) throw new Error(`usage: cue-sheet.mjs <${CLIP_IDS.join('|')}>|--all [--model m] [--fps n] [--inline] [--diff-only]`);
  return o;
}

function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  for (const f of ['.env.local', '.env']) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^GEMINI_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('GEMINI_API_KEY not set (use node --env-file=<file> or a .env.local in the repo root)');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(url, init, what) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(4000 * (attempt + 1));
      continue;
    }
    const err = new Error(`${what}: HTTP ${res.status} ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
}

/** Resumable upload to the Files API, then wait until the file is ACTIVE. */
async function uploadFile(key, path, displayName) {
  const bytes = await readFile(path);
  const start = await call(
    `${API}/upload/v1beta/files`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(bytes.length),
        'X-Goog-Upload-Header-Content-Type': 'video/mp4',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    },
    'upload start',
  );
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('upload start: no upload URL returned');
  const done = await call(
    uploadUrl,
    {
      method: 'POST',
      headers: {
        'Content-Length': String(bytes.length),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: bytes,
    },
    'upload bytes',
  );
  let file = (await done.json()).file;
  for (let i = 0; i < 60 && file.state === 'PROCESSING'; i++) {
    await sleep(3000);
    file = await (await call(`${API}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': key } }, 'file state')).json();
  }
  if (file.state !== 'ACTIVE') throw new Error(`file ${file.name} ended in state ${file.state}`);
  return file;
}

function prompt(clip) {
  const props = PROP_IDS.map((p) => `- "${p}": ${PROPS[p]}`).join('\n');
  return `You are a foley artist cueing a silent film. The video is a ${Math.round(clip.duration)}-second clip from "${clip.title}" (${clip.year}, ${clip.director}). It has no sound.
A player will perform the sound effects live on a table of six props, in time with the picture. Watch the clip and list the moments a foley artist would hit, choosing for each the one prop that fits best:
${props}

Rules:
- Use only those six prop ids.
- t is the time in seconds from the start of this clip (decimals allowed), at the exact moment of the visible action (the impact, the fall, the knock), not the start of the shot.
- label: 2 to 4 words, what happens on screen (e.g. "horse trots in", "door slams shut").
- Only physical, visible actions that make a sound. No intertitles, no dialogue.
- 8 to 16 cues, in time order, at least 1.5 seconds apart. Prefer the clearest, funniest beats.
- "why": one short sentence on what you see.`;
}

const schema = {
  type: 'OBJECT',
  properties: {
    cues: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          t: { type: 'NUMBER' },
          prop: { type: 'STRING', enum: PROP_IDS },
          label: { type: 'STRING' },
          why: { type: 'STRING' },
        },
        required: ['t', 'prop', 'label'],
        propertyOrdering: ['t', 'prop', 'label', 'why'],
      },
    },
  },
  required: ['cues'],
};

async function generate(key, model, videoPart, text) {
  const res = await call(
    `${API}/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [videoPart, { text }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 },
      }),
    },
    `generateContent ${model}`,
  );
  const json = await res.json();
  const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (!raw) throw new Error(`generateContent ${model}: empty response ${JSON.stringify(json).slice(0, 300)}`);
  return { raw, usage: json.usageMetadata ?? null };
}

function cleanCues(parsed, duration) {
  const out = [];
  for (const c of parsed?.cues ?? []) {
    if (typeof c.t !== 'number' || !PROP_IDS.includes(c.prop) || typeof c.label !== 'string') continue;
    if (c.t < 0 || c.t > duration) continue;
    out.push({ t: Math.round(c.t * 10) / 10, prop: c.prop, label: c.label.trim(), why: c.why ?? '' });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Pairs proposals with hand cues of the same prop within `tol` seconds (greedy, nearest first). */
function diff(proposed, hand, tol = 1.5) {
  const pairs = [];
  for (const [i, p] of proposed.entries())
    for (const [j, h] of hand.entries()) if (p.prop === h.prop && Math.abs(p.t - h.t) <= tol) pairs.push([Math.abs(p.t - h.t), i, j]);
  pairs.sort((a, b) => a[0] - b[0]);
  const pu = new Set(), hu = new Set(), matches = [];
  for (const [d, i, j] of pairs) {
    if (pu.has(i) || hu.has(j)) continue;
    pu.add(i), hu.add(j);
    matches.push({ proposed: proposed[i], hand: hand[j], dt: Math.round((hand[j].t - proposed[i].t) * 10) / 10, d });
  }
  return {
    matches: matches.sort((a, b) => a.hand.t - b.hand.t),
    rejected: proposed.filter((_, i) => !pu.has(i)),
    handOnly: hand.filter((_, j) => !hu.has(j)),
  };
}

function printDiff(id, proposed, hand) {
  if (!hand) {
    console.log(`  no hand sheet yet at public/clips/${id}.json`);
    return;
  }
  const d = diff(proposed, hand.cues);
  const f = (c) => `${c.t.toFixed(1).padStart(6)}  ${c.prop.padEnd(8)} ${c.label}`;
  console.log(`  kept (proposal matched a hand cue, same prop within 1.5 s): ${d.matches.length}/${proposed.length}`);
  for (const m of d.matches) console.log(`   = ${f(m.hand)}   (proposed ${m.proposed.t.toFixed(1)} "${m.proposed.label}", moved ${m.dt >= 0 ? '+' : ''}${m.dt} s)`);
  // A rejected proposal that lands on a hand cue's moment with another prop: the moment survived, the prop did not.
  const reprop = d.rejected.filter((c) => d.handOnly.some((h) => Math.abs(h.t - c.t) <= 1.5));
  console.log(`  proposals not in the hand sheet: ${d.rejected.length} (of which ${reprop.length} on a hand moment with another prop, marked ~)`);
  for (const c of d.rejected) {
    const h = d.handOnly.find((x) => Math.abs(x.t - c.t) <= 1.5);
    console.log(`   ${h ? '~' : '-'} ${f(c)}${h ? `   (hand: ${h.t.toFixed(1)} ${h.prop})` : ''}`);
  }
  console.log(`  hand cues Gemini did not propose: ${d.handOnly.length}`);
  for (const c of d.handOnly) console.log(`   + ${f(c)}`);
}

async function readJson(p) {
  return existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : null;
}

async function run(id, o, key) {
  const film = join(ROOT, 'public/films', `${id}.mp4`);
  const handPath = join(ROOT, 'public/clips', `${id}.json`);
  const outPath = join(ROOT, 'public/clips', `${id}.proposed.json`);
  const hand = await readJson(handPath);
  console.log(`\n== ${id}`);
  if (o.diffOnly) {
    const prev = await readJson(outPath);
    if (!prev) throw new Error(`${outPath} missing; run without --diff-only first`);
    printDiff(id, prev.cues, hand);
    return;
  }
  const meta = hand ?? { title: id, year: '', director: '', duration: 120 };
  const size = (await stat(film)).size;
  let videoPart, via;
  if (!o.inline) {
    try {
      const file = await uploadFile(key, film, `coconuts-${id}`);
      videoPart = { file_data: { mime_type: 'video/mp4', file_uri: file.uri }, video_metadata: { fps: o.fps } };
      via = 'files-api';
    } catch (e) {
      if (size >= INLINE_LIMIT) throw e;
      console.log(`  Files API failed (${e.message.slice(0, 120)}); sending inline`);
    }
  }
  if (!videoPart) {
    if (size >= INLINE_LIMIT) throw new Error(`${film} is ${size} bytes, over the inline limit`);
    videoPart = { inline_data: { mime_type: 'video/mp4', data: (await readFile(film)).toString('base64') }, video_metadata: { fps: o.fps } };
    via = 'inline';
  }
  const text = prompt(meta);
  let lastErr;
  for (const model of o.models ?? DEFAULT_MODELS) {
    try {
      const t0 = Date.now();
      const { raw, usage } = await generate(key, model, videoPart, text);
      const cues = cleanCues(JSON.parse(raw), meta.duration ?? 120);
      const proposal = {
        id,
        model,
        proposed_by: `gemini:${model}`,
        proposed_at: new Date().toISOString(),
        prompt_version: PROMPT_VERSION,
        video: { file: `films/${id}.mp4`, bytes: size, via, fps: o.fps },
        latency_ms: Date.now() - t0,
        usage,
        cues,
        raw,
      };
      await writeFile(outPath, `${JSON.stringify(proposal, null, 2)}\n`);
      console.log(`  ${model} via ${via}: ${cues.length} cues in ${proposal.latency_ms} ms -> public/clips/${id}.proposed.json`);
      printDiff(id, cues, hand);
      return;
    } catch (e) {
      lastErr = e;
      console.log(`  ${model} failed: ${e.message.slice(0, 200)}`);
    }
  }
  throw lastErr;
}

const o = args();
const key = o.diffOnly ? '' : apiKey();
let failed = 0;
for (const id of o.ids) {
  try {
    await run(id, o, key);
  } catch (e) {
    failed++;
    console.error(`  ${id} FAILED: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
