// POST /api/reel: the player's pitch and the story so far in, the next reel's plan out. Claude writes it when its key
// is set, Gemini when Claude is absent or fails, and a written reel always stands in, so this never fails a reel:
// every 200 carries a plan that passes checkPlan, three pitches on three props, and a note.
// GET /api/reel: warm the Director before the player's first reel (the schema's grammar compiled, the system prompt
// cached), at most once per instance every four minutes. It never writes a reel and never fails.
import { claudeBackend, type WarmResult, warmClaude } from './_lib/claude.js';
import { geminiJson, geminiKeys } from './_lib/gemini.js';
import { allow, clientIp, limiter } from './_lib/ratelimit.js';
import {
  type Attempt,
  type Backend,
  type CallOpts,
  DailyCap,
  DEADLINE_MS,
  monoNow,
  parseReelRequest,
  type ReelRequest,
  type Trace,
  writeReel,
  writtenAnswer,
} from './_lib/reel-core.js';

const MAX_BODY = 8 * 1024;

// any origin may ask (a dev build of the game, pointed at this deployment, is one); the rate limit is per IP
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}

/** Read at most `max` bytes of the body; null when it is longer. */
async function readBody(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const GEMINI_TAIL = 'Reply with the JSON answer only, no prose and no code fence.';

/** The reel Director on Gemini: one prompt (the system text, then the user JSON); the repair resends it with the errors. */
export function geminiBackend(call: typeof geminiJson = geminiJson): Backend {
  const ask = async (prompt: string, opts: CallOpts): Promise<Attempt> => {
    const r = await call(prompt, { timeoutMs: opts.timeoutMs, maxOutputTokens: 2048 });
    return { text: r.text, model: r.model, repair: (feedback, o) => ask(`${prompt}\n\nYour answer was:\n${r.text}\n\n${feedback}\n${GEMINI_TAIL}`, o) };
  };
  return { name: 'gemini', first: (system, user, opts) => ask(`${system}\n\n${GEMINI_TAIL}\n\nThe story so far and the pitch:\n${user}`, opts) };
}

export type Director = 'claude' | 'gemini' | 'written';

/** The backend a POST would try first, from the environment. */
export function firstDirector(): Director {
  if (process.env.REEL_DISABLED === '1') return 'written';
  if (process.env.ANTHROPIC_API_KEY?.trim()) return 'claude';
  if (geminiKeys().length) return 'gemini';
  return 'written';
}

/** The backends the environment has keys for, in order. */
function envBackends(): Backend[] {
  const list: Backend[] = [];
  if (process.env.ANTHROPIC_API_KEY?.trim()) list.push(claudeBackend());
  if (geminiKeys().length) list.push(geminiBackend());
  return list;
}

/** The instance's count of model-written reels today. */
const DAILY = new DailyCap();
/** A player needs a reel every minute or two. One address gets eight a minute from the model, however many tabs it opens. */
const allowReel = limiter(8);
/** Reels from the model per UTC day per instance, unless REEL_DAILY_CAP says otherwise; past it the written reels play. */
const REEL_DAILY_DEFAULT = 120;

export interface ReelDeps {
  backends: () => Backend[];
  cap: DailyCap;
  deadlineMs: number;
  /** Sees every request's trace (the batch tool's numbers come from here). */
  onTrace?: (trace: Trace, req: ReelRequest) => void;
}

const DEFAULTS: ReelDeps = { backends: envBackends, cap: DAILY, deadlineMs: DEADLINE_MS };

/** The handler with its backends passed in; POST is this with the environment's. */
export async function handleReel(request: Request, deps: Partial<ReelDeps> = {}): Promise<Response> {
  const d = { ...DEFAULTS, ...deps };
  let req: ReelRequest | null = null;
  try {
    const ip = clientIp(request);
    if (!allow(ip) || !allowReel(ip)) return json({ error: 'Too many reels at once. Try again in a minute.' }, 429);
    const raw = await readBody(request, MAX_BODY);
    if (raw === null) return json({ error: 'The request is too large.' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'The body must be JSON.' }, 400);
    }
    const parsed = parseReelRequest(body);
    if ('error' in parsed) return json({ error: parsed.error }, 400);
    req = parsed.req;

    const t0 = monoNow();
    let trace: Trace;
    let answer;
    const backends = d.backends();
    const capN = Number(process.env.REEL_DAILY_CAP ?? REEL_DAILY_DEFAULT);
    if (process.env.REEL_DISABLED === '1') {
      answer = writtenAnswer(req);
      trace = { source: 'written', ms: 0, why: 'disabled', tries: [] };
    } else if (!backends.length) {
      answer = writtenAnswer(req);
      trace = { source: 'written', ms: 0, why: 'no-backend', tries: [] };
    } else if (!d.cap.take(Number.isFinite(capN) && capN >= 0 ? capN : REEL_DAILY_DEFAULT)) {
      answer = writtenAnswer(req);
      trace = { source: 'written', ms: 0, why: 'cap', tries: [] };
    } else {
      ({ answer, trace } = await writeReel(req, backends, { deadlineMs: d.deadlineMs }));
    }
    trace.ms = Math.round(monoNow() - t0);
    // a reel that reached Claude kept its prompt cache and grammar warm: no warm-up needed for a while
    if (trace.tries.some((t) => t.backend === 'claude' && t.usage.length)) WARM.last = monoNow();
    console.log(
      'REEL',
      req.reel,
      answer.source,
      `${trace.ms}ms`,
      trace.why ?? '',
      trace.tries.map((t) => `${t.backend}:${t.ok ? (t.repaired ? 'repaired' : 'ok') : (t.error ?? 'invalid')}`).join(' '),
    );
    d.onTrace?.(trace, req);
    return json(answer);
  } catch (e) {
    console.log('REEL failed', e instanceof Error ? e.message : String(e));
    if (req) return json(writtenAnswer(req));
    return json({ error: 'The Director stepped out.' }, 500);
  }
}

export function POST(request: Request): Promise<Response> {
  return handleReel(request);
}

// ---- the warm-up ------------------------------------------------------------------------------------

/** One warm call per instance at most this often (the prompt cache lives five minutes). */
export const WARM_EVERY_MS = 4 * 60_000;
/** The warm call gives up after this. */
export const WARM_TIMEOUT_MS = 20_000;
/** Warm calls per UTC day per instance; separate from the reel cap. */
export const WARM_DAILY_CAP = 80;

/** When this instance last warmed Claude, or last wrote a reel with it (monotonic ms). */
const WARM = { last: Number.NEGATIVE_INFINITY, cap: new DailyCap() };

export interface WarmDeps {
  warm: (timeoutMs: number) => Promise<WarmResult>;
  director: () => Director;
  cap: DailyCap;
  /** Monotonic milliseconds. */
  now: () => number;
  /** The instance's memory of the last warm (a test passes its own). */
  state: { last: number };
}

const WARM_DEFAULTS: WarmDeps = { warm: (ms) => warmClaude(ms), director: firstDirector, cap: WARM.cap, now: monoNow, state: WARM };

/** The warm-up with its parts passed in; GET is this with the instance's own. Answers { ok, warmed, ms, director }. */
export async function handleWarm(request: Request, deps: Partial<WarmDeps> = {}): Promise<Response> {
  const d = { ...WARM_DEFAULTS, ...deps };
  let director: Director = 'written';
  try {
    if (!allow(clientIp(request))) return json({ error: 'Too many requests at once. Try again in a minute.' }, 429);
    director = d.director();
    // only Claude has a grammar to compile and a prompt to cache; Gemini and the written reels need no warming
    if (director !== 'claude') return json({ ok: true, warmed: false, ms: 0, director });
    const t0 = d.now();
    if (t0 - d.state.last < WARM_EVERY_MS) return json({ ok: true, warmed: false, ms: 0, director });
    if (!d.cap.take(WARM_DAILY_CAP)) return json({ ok: true, warmed: false, ms: 0, director });
    d.state.last = t0; // claimed before the call, so a second GET meanwhile does not warm twice
    try {
      const r = await d.warm(WARM_TIMEOUT_MS);
      const ms = Math.round(d.now() - t0);
      console.log('REEL warm', `${ms}ms`, r.model, r.speed);
      return json({ ok: true, warmed: true, ms, director });
    } catch (e) {
      const ms = Math.round(d.now() - t0);
      const kind = e instanceof Error && 'kind' in e ? String((e as { kind: unknown }).kind) : 'api';
      console.log('REEL warm failed', `${ms}ms`, e instanceof Error ? e.message : String(e));
      return json({ ok: false, warmed: false, ms, director, error: kind });
    }
  } catch (e) {
    console.log('REEL warm failed', e instanceof Error ? e.message : String(e));
    return json({ ok: false, warmed: false, ms: 0, director });
  }
}

export function GET(request: Request): Promise<Response> {
  return handleWarm(request);
}
