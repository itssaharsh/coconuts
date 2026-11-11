// POST /api/director: the take in, one line from the Director out. The model is tried first; the rule line
// answers whenever the model is slow, wrong or absent, so this never fails a take.
import { composeDirector, parseDirectorInput, ruleLine, type DirectorInput } from './_lib/director-core.js';
import { geminiJson } from './_lib/gemini.js';
import { allow, clientIp } from './_lib/ratelimit.js';

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

export async function POST(request: Request): Promise<Response> {
  let input: DirectorInput | null = null;
  try {
    if (!allow(clientIp(request))) return json({ error: 'Too many takes at once. Try again in a minute.' }, 429);
    const raw = await readBody(request, MAX_BODY);
    if (raw === null) return json({ error: 'The take is too large.' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'The body must be JSON.' }, 400);
    }
    input = parseDirectorInput(body);
    if (!input) return json({ error: 'The take is not in the expected shape.' }, 400);
    const out = await composeDirector(
      input,
      (prompt) =>
        geminiJson(prompt, { timeoutMs: 2000, maxOutputTokens: 160 }).then((r) => {
          console.log('director model', r.model, JSON.stringify(r.text).slice(0, 200));
          return r;
        }),
      2200,
    );
    if (out.source === 'rules') console.log('director fell back to the rules');
    return json({ line: out.line, source: out.source, model: out.model ?? null });
  } catch {
    if (input) return json({ line: ruleLine(input), source: 'rules', model: null });
    return json({ error: 'The Director stepped out.' }, 500);
  }
}
