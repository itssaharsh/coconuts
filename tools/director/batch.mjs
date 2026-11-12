#!/usr/bin/env node
// Batch-test the reel Director: call the /api/reel handler in-process N times with varied pitches and story histories,
// then print what came back from where, how often the first plan checked, how often a repair was needed or the
// written reel stood in, the latency, and the tokens. Every answer is saved to qa/director/ (git-ignored).
//
//   node tools/director/batch.mjs [--n 20] [--backend auto|claude|gemini|mock] [--max-gemini 8] [--verbose]
//   node tools/director/batch.mjs --url http://127.0.0.1:8797/ [--n 24]
//
// --url sends the same requests to a running tools/director/serve.mjs instead (its model, REEL_FAST and keys are the
// server's; the trace comes back on the stand-in's x-reel-trace header).
//
// auto (the default) is what the function itself would do: Claude when ANTHROPIC_API_KEY is set (in the environment
// or .env.local), else Gemini when GEMINI_API_KEY(S) is (at most --max-gemini calls: its free quota is small), else a
// mock backend that exercises the same paths with scripted answers. Key values are never printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'qa', 'director');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
let N = Math.max(1, Number(flag('n', 20)) || 20);
const WANT = flag('backend', 'auto');
const MAX_GEMINI = Math.max(1, Number(flag('max-gemini', 8)) || 8);
const VERBOSE = args.includes('--verbose');

const URL_BASE = flag('url', '');

// keys: .env.local only, as serve.mjs does (the shell's ANTHROPIC_API_KEY may belong to a coding agent); names only
// are ever logged
for (const name of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API_KEYS']) delete process.env[name];
for (const f of ['.env.local', '.env']) {
  const p = join(ROOT, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^(ANTHROPIC_API_KEY|GEMINI_API_KEY|GEMINI_API_KEYS)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
const hasClaude = !!process.env.ANTHROPIC_API_KEY?.trim();
const hasGemini = !!(process.env.GEMINI_API_KEY?.trim() || process.env.GEMINI_API_KEYS?.trim());

const load = async (id) => (await runnerImport(id, { root: ROOT, configFile: false, logLevel: 'error' })).module;
const reelFn = await load('/api/reel.ts');
const core = await load('/api/_lib/reel-core.ts');
const claude = await load('/api/_lib/claude.ts');
const pieces = await load('/src/serial/pieces.ts');

let backend = URL_BASE ? 'server' : WANT;
if (backend === 'auto') backend = hasClaude ? 'claude' : hasGemini ? 'gemini' : 'mock';
if (backend === 'claude' && !hasClaude) throw new Error('--backend claude needs ANTHROPIC_API_KEY');
if (backend === 'gemini' && !hasGemini) throw new Error('--backend gemini needs GEMINI_API_KEY or GEMINI_API_KEYS');
if (backend === 'gemini' && N > MAX_GEMINI) {
  console.log(`(gemini: ${N} capped to ${MAX_GEMINI} calls; raise with --max-gemini)`);
  N = MAX_GEMINI;
}

// ---- varied requests ------------------------------------------------------------------------------

const PROPS = ['coconuts', 'door', 'bell', 'thunder', 'whistle', 'glass'];
/** Spoken pitches; the first asks for something the company cannot stage. */
const SPOKEN = ['A dragon attacks the castle', 'The thief hides in the market and a bull gets loose', 'Make the thief fall in love with a skeleton'];

/** What reel one's sounds really did (the client's facts), in the order they land. */
const REEL_ONE_DID = [
  'door: opened the castle gate',
  'coconuts: carried the knight down the road',
  'bell: woke the thief, who thought it was supper',
  'thunder: burst the toy theatre open to the size of the wall',
  'door: slammed the door in the thief’s face',
  'bell: rang every blow of the duel',
  'glass: broke the picture and let the thief out of it, onto the player’s table',
  'whistle: sent the thief over the edge of the table',
];
const REEL_ONE = {
  title: 'The Midnight Knock',
  wrote: ['Knock for him', 'Clop the coconuts', 'A bell! “Supper?”', 'Shake the thunder!', 'Slam it shut!', 'Ring: the last blow!', 'Smash! He jumps!', 'Whistle him off the edge'],
  did: REEL_ONE_DID,
  flags: ['thief_hungry', 'thief_out'],
  cliffhanger: 'The thief is loose in your room.',
};
/** Reel one when the player missed the last cue: the whistle did nothing, so five props were used. */
const REEL_ONE_MISSED = { ...REEL_ONE, wrote: REEL_ONE.wrote.slice(0, 7), did: REEL_ONE_DID.slice(0, 7) };
/** Later reels, with the facts their sounds would report. */
const HISTORY = [
  {
    title: 'The Chase',
    wrote: ['Clop the coconuts', 'A tune. A little dance.', 'Shake the thunder', 'Ring: the last blow!'],
    did: ['coconuts: outran the wolves on the north road', 'whistle: woke the brute, who danced to it', 'thunder: made the camp fire spit', 'bell: rang every blow of the duel with the brute'],
    flags: ['woke_merry'],
    cliffhanger: 'The thief runs for the graveyard.',
  },
  {
    title: 'The Graveyard Shortcut',
    wrote: ['Shake the thunder', 'Ring: the last blow!', 'Whistle for help'],
    did: ['thunder: raised two skeletons from their graves', 'bell: rang every blow of the duel with the skeleton', 'whistle: called the thief out of hiding'],
    flags: [],
    cliffhanger: 'The dead do not stay down.',
  },
  {
    title: 'Last Orders',
    wrote: ['Knock for him', 'Ring the bell!', 'Ring: the last blow!', 'Smash a bottle!'],
    did: ['door: knocked up the innkeeper', 'bell: rang for a round of drinks', 'bell: rang every blow of the duel with the thief', 'glass: smashed a bottle and made everyone jump'],
    flags: [],
    cliffhanger: 'The thief was never the thief.',
  },
];

/**
 * The 24 requests: reels 2, 3 and 4 in turn; 21 prop pitches across all six props and three spoken pitches (one for a
 * dragon); every one with facts for the reel before it (reel one's real facts, every other time without the whistle).
 */
function request(i) {
  const reel = 2 + (i % 3);
  const one = i % 2 ? REEL_ONE_MISSED : REEL_ONE;
  const later = [HISTORY[i % 3], HISTORY[(i + 1) % 3]];
  const story = [one, ...later.slice(0, reel - 2)];
  const spoken = { 5: 0, 13: 1, 21: 2 }[i];
  const prop = PROPS[i % 6];
  const pitch = spoken !== undefined ? { text: SPOKEN[spoken], spoken: true } : { prop, text: core.STOCK_PITCH[prop] };
  return { reel, pitch, story };
}

// ---- a mock backend: the same paths with scripted answers (good, bad then repaired, bad twice) -----------------

function mockBackend(i) {
  const roll = (i * 37) % 10; // 0-6 good, 7-8 repaired, 9 hopeless
  const answer = (req) => {
    const prop = req.pitch.prop ?? core.bestProp(req.pitch.text);
    return { plan: pieces.WRITTEN[prop], pitches: core.stockPitches(prop, req), note: 'Your sounds wrote this one. The Duke is not amused.' };
  };
  const bad = { plan: { title: 'Nowhere', scenes: [{ set: 'moon', cast: [], pieces: [] }], cliffhanger: '' }, pitches: [], note: '' };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    name: 'claude',
    async first(system, user) {
      await wait(20 + ((i * 53) % 120));
      const req = JSON.parse(user);
      const text = JSON.stringify(roll <= 6 ? answer(req) : bad);
      return {
        text,
        model: 'mock',
        repair: async () => {
          await wait(20);
          return { text: roll === 9 ? 'not json' : JSON.stringify(answer(req)), model: 'mock', repair: async () => ({ text: '', model: 'mock' }) };
        },
      };
    },
  };
}

// ---- run ------------------------------------------------------------------------------------------

/** One reel from the running stand-in server: its answer, and its trace from the x-reel-trace header. */
async function viaServer(req, i) {
  const res = await fetch(new URL('api/reel', URL_BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.77.1.${i}` },
    body: JSON.stringify(req),
  });
  const raw = res.headers.get('x-reel-trace');
  return { res, trace: raw ? JSON.parse(decodeURIComponent(raw)) : null };
}

const pick = (i) => (backend === 'claude' ? [claude.claudeBackend()] : backend === 'gemini' ? [reelFn.geminiBackend()] : [mockBackend(i)]);
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
mkdirSync(OUT, { recursive: true });
console.log(
  `reel batch: ${N} reels, backend ${backend}${backend === 'mock' ? ' (no key found: scripted answers, latency and tokens are not real)' : ''}, model ${backend === 'claude' ? claude.reelModel() : backend === 'server' ? `the server's at ${URL_BASE}` : backend}`,
);

const log = console.log;
const rows = [];
for (let i = 0; i < N; i++) {
  const req = request(i);
  let trace = null;
  if (!VERBOSE) console.log = () => undefined;
  const t0 = performance.now();
  let res;
  if (backend === 'server') ({ res, trace } = await viaServer(req, i));
  else {
    res = await reelFn.handleReel(
      new Request('http://batch/api/reel', { method: 'POST', headers: { 'x-forwarded-for': `10.77.0.${i}` }, body: JSON.stringify(req) }),
      { backends: () => pick(i), cap: new core.DailyCap(), onTrace: (t) => (trace = t) },
    );
  }
  const ms = performance.now() - t0;
  console.log = log;
  const answer = await res.json();
  const plan = answer.plan;
  const sounds = plan.scenes.flatMap((s) => s.pieces.map((p) => core.pieceSound(p.piece))).filter((s) => s && s !== 'any');
  const row = {
    i,
    status: res.status,
    source: answer.source,
    ms: Math.round(ms),
    trace,
    // the written fallback is exempt from the last-reel variety rule (it is never checked at run time)
    checks: pieces.checkPlan(plan).length === 0 && (answer.source === 'written' || core.serverChecks(plan, req).length === 0),
    noteFacts: core.checkNoteFacts(answer.note, req),
    cues: core.reelCues(plan),
    soundingProps: new Set(sounds).size,
    soundingPieces: plan.scenes.flatMap((s) => s.pieces).filter((p) => core.pieceSound(p.piece) !== null).length,
    featuresPitch: !req.pitch.prop || sounds.includes(req.pitch.prop),
    pitches: answer.pitches.map((p) => p.prop).join(','),
  };
  rows.push(row);
  writeFileSync(join(OUT, `${runId}-${String(i).padStart(2, '0')}.json`), JSON.stringify({ request: req, answer, trace, ms: row.ms }, null, 2));
  const t = trace?.tries?.[0];
  log(
    `${String(i).padStart(2)} ${answer.source.padEnd(7)} ${String(row.ms).padStart(5)}ms  ${t ? (t.ok ? (t.repaired ? 'repaired' : 'first try') : `fell through (${t.error ?? 'invalid twice'})`) : trace?.why ?? ''}  | ${plan.title} | props ${row.soundingProps} | next ${row.pitches} | “${answer.note}”`,
  );
}

// ---- numbers ----------------------------------------------------------------------------------------

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : 'n/a');
const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0;
};
const tries = rows.map((r) => r.trace?.tries?.[0]).filter(Boolean);
const claudeValid = rows.filter((r) => r.source === 'claude' && r.checks && r.status === 200).length;
const bySource = rows.reduce((m, r) => ((m[r.source] = (m[r.source] ?? 0) + 1), m), {});
const lat = rows.map((r) => r.ms);
// each call's usage with the speed that answered it (the trace lists them in the same order)
const calls = tries.flatMap((t) => (t.usage ?? []).map((u, j) => ({ ...u, speed: t.speeds?.[j] ?? 'standard' })));
const avg = (k) => (calls.length ? Math.round(calls.reduce((s, u) => s + u[k], 0) / calls.length) : 0);

log('\n== results ==');
log(`answers by source: ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(', ')} (of ${N}; all ${rows.every((r) => r.status === 200 && r.checks) ? 'pass' : 'DO NOT all pass'} checkPlan)`);
log(`plan valid on the first try: ${pct(tries.filter((t) => t.ok && !t.repaired).length, tries.length)}`);
log(`repair asked: ${pct(tries.filter((t) => t.repaired).length, tries.length)}; repair saved it: ${pct(tries.filter((t) => t.repaired && t.ok).length, tries.filter((t) => t.repaired).length)}`);
log(`fell through to the written reel: ${pct(rows.filter((r) => r.source === 'written').length, N)}`);
log(`written by Claude with a plan that passes every check: ${claudeValid} of ${N} (${pct(claudeValid, N)})`);
const errs = tries.filter((t) => t.error).map((t) => t.error);
if (errs.length) log(`errors: ${errs.join(' | ')}`);
log(`pitches or note mended locally: ${pct(tries.filter((t) => t.mended?.length).length, tries.length)}`);
log(`latency ms: p50 ${q(lat, 0.5)}, p90 ${q(lat, 0.9)}, max ${Math.max(...lat)}`);
log(`plans with 3+ sounding props: ${pct(rows.filter((r) => r.soundingProps >= 3).length, N)}; 3 to 6 sounding pieces: ${pct(rows.filter((r) => r.soundingPieces >= 3 && r.soundingPieces <= 6).length, N)}; feature the pitched prop: ${pct(rows.filter((r) => r.featuresPitch).length, N)}`);
if (calls.length) {
  log(`tokens per call (avg of ${calls.length}): input ${avg('input')}, output ${avg('output')}, cache read ${avg('cacheRead')}, cache write ${avg('cacheWrite')}`);
  if (backend === 'claude' || backend === 'server') {
    // $ per MTok: input, output, cache read; 5-minute cache writes are 1.25x input. Fast mode (Opus 5.5) is twice the price.
    const PRICE = { 'claude-opus-5-5': [4, 20, 0.2], 'claude-sonnet-5-5': [2, 10, 0.1] };
    const model = tries.find((t) => t.model)?.model ?? claude.reelModel();
    const [pin, pout, pread] = PRICE[Object.keys(PRICE).find((k) => model.startsWith(k)) ?? 'claude-opus-5-5'];
    // fast mode: twice the price, cache multipliers on top
    const usd = (u) => ((u.speed === 'fast' ? 2 : 1) * (u.input * pin + u.output * pout + u.cacheRead * pread + u.cacheWrite * pin * 1.25)) / 1e6;
    const total = calls.reduce((s, u) => s + usd(u), 0);
    const bySpeed = calls.reduce((m, u) => ((m[u.speed] = (m[u.speed] ?? 0) + 1), m), {});
    log(`speeds that answered: ${Object.entries(bySpeed).map(([k, v]) => `${k} ${v}`).join(', ')}; fast retried at standard: ${tries.filter((t) => t.retried).length}`);
    log(`cost: $${total.toFixed(3)} for the batch, $${(total / N).toFixed(4)} per reel (${model} prices, fast calls at twice the price)`);
  }
} else log('tokens: none reported (mock or Gemini backend)');
log(`saved: ${OUT}/${runId}-*.json`);
