// POST /api/hear: a few seconds of the player's speech in, its words out. Used once between reels, when the player
// holds the megaphone and says what should happen next. Any failure is a plain error status: the game then falls
// back to the pitch cards, so this never blocks a reel.
import { allow, clientIp } from './_lib/ratelimit.js';

const MAX_BODY = 400 * 1024; // about eight seconds of Opus at a generous bitrate
const DEADLINE_MS = 8500;
const TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg', 'application/octet-stream'];
const API = 'https://api.assemblyai.com/v2';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
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
}

/** Upload, ask for a transcript, poll until it is done or the deadline passes. Null when it could not be heard. */
export async function transcribe(audio: Uint8Array, deps: HearDeps = {}): Promise<string | null> {
  const key = deps.key ?? process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!key) return null;
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + DEADLINE_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DEADLINE_MS);
  try {
    const up = await f(`${API}/upload`, { method: 'POST', headers: { authorization: key, 'content-type': 'application/octet-stream' }, body: audio, signal: ctl.signal });
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
      await sleep(350);
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
  if (!(deps.key ?? process.env.ASSEMBLYAI_API_KEY?.trim())) return json({ error: 'hearing is off' }, 503);
  const text = await transcribe(audio, deps);
  if (!text) return json({ error: 'not heard' }, 502);
  console.log('HEAR words', text.split(' ').length);
  return json({ text });
}

export async function POST(request: Request): Promise<Response> {
  return handleHear(request);
}
