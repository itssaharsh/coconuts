// POST /api/reel: the player's pitch and the story so far in, the next reel's plan out. Claude writes it when its key
// is set, Gemini when Claude is absent or fails, and a written reel always stands in, so this never fails a reel:
// every 200 carries a plan that passes checkPlan, three pitches on three props, and a note.
import { claudeBackend } from './_lib/claude.js';
import { geminiJson, geminiKeys } from './_lib/gemini.js';
import { allow, clientIp } from './_lib/ratelimit.js';
import {
  type Attempt,
  type Backend,
  type CallOpts,
  DailyCap,
  DEADLINE_MS,
  parseReelRequest,
  type ReelRequest,
  type Trace,
  writeReel,
  writtenAnswer,
} from './_lib/reel-core.js';

const MAX_BODY = 8 * 1024;

// any origin may ask (a dev build of the game, pointed at this deployment, is one); the rate limit is per IP
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };

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

/** The backends the environment has keys for, in order. */
function envBackends(): Backend[] {
  const list: Backend[] = [];
  if (process.env.ANTHROPIC_API_KEY?.trim()) list.push(claudeBackend());
  if (geminiKeys().length) list.push(geminiBackend());
  return list;
}

/** The instance's count of model-written reels today. */
const DAILY = new DailyCap();

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
    if (!allow(clientIp(request))) return json({ error: 'Too many reels at once. Try again in a minute.' }, 429);
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

    const t0 = Date.now();
    let trace: Trace;
    let answer;
    const backends = d.backends();
    const capN = Number(process.env.REEL_DAILY_CAP ?? 300);
    if (process.env.REEL_DISABLED === '1') {
      answer = writtenAnswer(req);
      trace = { source: 'written', ms: 0, why: 'disabled', tries: [] };
    } else if (!backends.length) {
      answer = writtenAnswer(req);
      trace = { source: 'written', ms: 0, why: 'no-backend', tries: [] };
    } else if (!d.cap.take(Number.isFinite(capN) && capN >= 0 ? capN : 300)) {
      answer = writtenAnswer(req);
      trace = { source: 'written', ms: 0, why: 'cap', tries: [] };
    } else {
      ({ answer, trace } = await writeReel(req, backends, { deadlineMs: d.deadlineMs }));
    }
    trace.ms = Date.now() - t0;
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
