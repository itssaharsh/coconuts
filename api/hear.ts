// POST /api/hear: a few seconds of the player's speech in, its words out. Used once between reels, when the player
// holds the megaphone and says what should happen next. Any failure is a plain error status: the game then falls
// back to the pitch cards, so this never blocks a reel.
import { geminiKeys, geminiTranscribe } from './_lib/gemini.js';
import { allow, clientIp } from './_lib/ratelimit.js';

const MAX_BODY = 400 * 1024; // about eight seconds of Opus at a generous bitrate
const DEADLINE_MS = 8500;
const TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg', 'application/octet-stream'];
const GEMINI_BUDGET_MS = 4000;
const POLL_MS = 200;
// both listen at once: the first words win (a short take costs a fraction of a cent on each), so a slow answer from
// one of them no longer adds its wait to the player's
const HEDGE_MS = 0;
const API = 'https://api.assemblyai.com/v2';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}

// words that do not go on a card in a family show; the Director is told separately to steer, this only cleans the echo
const RUDE = /\b(fuck\w*|shit\w*|bitch\w*|cunt\w*|asshole\w*|dick\w*|bastard\w*|slut\w*|whore\w*|nigg\w*|fag\w*|retard\w*)\b/gi;

/** What goes on the card and to the Director: one short line, no control characters, nothing rude. */
export function cleanSpeech(text: string): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(RUDE, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“”']+|["“”']+$/g, '');
  const words = flat.split(' ').filter(Boolean).slice(0, 14);
  return words.join(' ').slice(0, 110).trim();
}

export interface HearDeps {
  key?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Gemini keys; by default from the environment (none when a fake `fetch` is passed without them). */
  geminiKeys?: string[];
  /** When Gemini is still silent after this long, AssemblyAI starts too and the first answer wins. */
  hedgeMs?: number;
}

/** What to tell Gemini the bytes are: the request's type, or for a bare octet-stream the file's own first bytes. */
export function audioMime(type: string, b: Uint8Array): string {
  if (type !== 'application/octet-stream') return type;
  const ascii = (a: number, n: number) => String.fromCharCode(...b.slice(a, a + n));
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'RIFF') return 'audio/wav';
  if (ascii(4, 4) === 'ftyp') return 'audio/mp4';
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return 'audio/webm';
}

// what a model writes when it was told to answer with nothing and cannot quite manage it
const NOT_SPEECH = /^(?:[\[(*<_-]*\s*)?(?:no (?:speech|words?|audio|transcript)(?: (?:detected|found|heard))?|silence|silent|inaudible|unintelligible|empty|none|n\/a|noise|static|background noise|music|blank|nothing)(?:\s*[\])*>_-]*)?[.!]?$/i;

/** One call to Gemini: the words, '' when it answered that there is no speech, null when it did not answer (no key, unsupported format, too slow). */
export async function transcribeGemini(audio: Uint8Array, mime: string, deps: HearDeps = {}, budgetMs = GEMINI_BUDGET_MS): Promise<string | null> {
  const keys = deps.geminiKeys ?? (deps.fetch ? [] : geminiKeys());
  if (!keys.length) return null;
  try {
    const { text } = await geminiTranscribe(audio, mime, { keys, fetch: deps.fetch, now: deps.now, timeoutMs: budgetMs });
    const flat = text.trim();
    if (NOT_SPEECH.test(flat) || !/[a-z]{3}/i.test(flat)) return ''; // a lone digit or a bare sound is a guess, not speech
    return cleanSpeech(flat);
  } catch {
    return null;
  }
}

/** Upload, ask for a transcript, poll until it is done or the deadline passes. Null when it could not be heard. */
export async function transcribe(audio: Uint8Array, deps: HearDeps = {}, deadlineMs = DEADLINE_MS): Promise<string | null> {
  const key = deps.key ?? process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!key) return null;
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + deadlineMs;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deadlineMs);
  try {
    const up = await f(`${API}/upload`, { method: 'POST', headers: { authorization: key, 'content-type': 'application/octet-stream' }, body: new Blob([audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer]), signal: ctl.signal });
    if (!up.ok) return null;
    const { upload_url } = (await up.json()) as { upload_url?: string };
    if (!upload_url) return null;
    const made = await f(`${API}/transcript`, {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: upload_url, language_code: 'en', punctuate: true, format_text: true }),
      signal: ctl.signal,
    });
    if (!made.ok) return null;
    const { id } = (await made.json()) as { id?: string };
    if (!id) return null;
    while (now() < until) {
      await sleep(POLL_MS);
      const res = await f(`${API}/transcript/${id}`, { headers: { authorization: key }, signal: ctl.signal });
      if (!res.ok) return null;
      const t = (await res.json()) as { status?: string; text?: string | null };
      if (t.status === 'completed') return cleanSpeech(t.text ?? '') || null;
      if (t.status === 'error') return null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleHear(request: Request, deps: HearDeps = {}): Promise<Response> {
  if (!allow(clientIp(request))) return json({ error: 'slow down' }, 429);
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!TYPES.includes(type)) return json({ error: 'send audio' }, 415);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'too long' }, 413);
  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.byteLength > MAX_BODY) return json({ error: 'too long' }, 413);
  if (audio.byteLength < 800) return json({ error: 'nothing recorded' }, 400);
  const aaiKey = deps.key ?? process.env.ASSEMBLYAI_API_KEY?.trim();
  const gKeys = deps.geminiKeys ?? (deps.fetch ? [] : geminiKeys());
  if (!aaiKey && !gKeys.length) return json({ error: 'hearing is off' }, 503);
  const now = deps.now ?? (() => performance.now());
  const started = now();
  let text: string | null = null;
  let heardBy = '';
  const aai = (left: number) => (aaiKey && left > 1500 ? transcribe(audio, { ...deps, key: aaiKey }, left) : Promise.resolve(null));
  if (gKeys.length) {
    const g = transcribeGemini(audio, audioMime(type, audio), { ...deps, geminiKeys: gKeys });
    const slow = Symbol('slow');
    let hedge: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([g, new Promise<typeof slow>((r) => (hedge = setTimeout(() => r(slow), deps.hedgeMs ?? HEDGE_MS)))]);
    clearTimeout(hedge);
    if (first !== slow) {
      if (first) {
        text = first;
        heardBy = 'gemini';
      } else if (first === '') {
        return json({ error: 'not heard' }, 502); // Gemini heard it and found no speech: the same answer as before, without a second wait
      } else {
        text = await aai(DEADLINE_MS - (now() - started)); // Gemini did not answer (format, quota, error): AssemblyAI gets what is left
        if (text) heardBy = 'assemblyai';
      }
    } else {
      // Gemini is slow: AssemblyAI starts now and the first words win; a silence from Gemini is final
      const a = aai(DEADLINE_MS - (now() - started));
      const tag = <T,>(p: Promise<T>, who: string) => p.then((v) => ({ v, who }));
      const pending = [tag(g, 'gemini'), tag(a, 'assemblyai')];
      while (pending.length) {
        const r = await Promise.race(pending.map((p, i) => p.then((x) => ({ ...x, i }))));
        pending.splice(r.i, 1);
        if (r.v) {
          text = r.v as string;
          heardBy = r.who;
          break;
        }
        if (r.v === '') break;
      }
    }
  } else {
    text = await aai(DEADLINE_MS);
    if (text) heardBy = 'assemblyai';
  }
  if (!text) return json({ error: 'not heard' }, 502);
  console.log('HEAR words', text.split(' ').length, heardBy, Math.round(now() - started), 'ms');
  return json({ text });
}

export async function POST(request: Request): Promise<Response> {
  return handleHear(request);
}

/** Whether hearing is switched on here: the page shows its voice control only when it is. */
export async function GET(): Promise<Response> {
  return json({ ok: !!process.env.ASSEMBLYAI_API_KEY?.trim() || geminiKeys().length > 0 });
}
