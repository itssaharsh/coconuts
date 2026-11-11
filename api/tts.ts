// GET /api/tts?t=<text>&v=director: the Director's voice as WAV. The URL is the cache key, so a line is
// synthesized once and then served from the CDN. Any failure is a 503 and the client keeps the text bubble.
import { geminiKeys } from './_lib/gemini.js';
import { Buffer } from 'node:buffer';
import { audioToWav } from './_lib/director-core.js';
import { allow, clientIp } from './_lib/ratelimit.js';

const ATTEMPTS: [model: string, voice: string][] = [
  ['gemini-3.8-flash-tts', 'Charon'],
  ['gemini-3.8-flash-tts', 'Puck'],
  ['gemini-2.5-flash-preview-tts', 'Charon'],
];
const BUDGET_MS = 9000;

// any origin may ask (a dev build of the game, pointed at this deployment, is one); the rate limit is per IP
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };

const fail = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}

async function speakOnce(key: string, model: string, voice: string, text: string, timeoutMs: number): Promise<ArrayBuffer> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Say in a measured, dry, slightly amused voice, like an old film director: ${text}` }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`${model}/${voice}: HTTP ${res.status}`);
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
    };
    const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    const wav = inline?.data ? audioToWav(inline.mimeType ?? 'audio/L16;rate=24000', Buffer.from(inline.data, 'base64')) : null;
    if (!wav) throw new Error(`${model}/${voice}: no audio`);
    return wav;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    if (!allow(clientIp(request))) return fail(429, 'Too many lines at once. Try again in a minute.');
    const params = new URL(request.url).searchParams;
    const text = (params.get('t') ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    const voice = params.get('v') ?? 'director';
    if (!text || text.length > 160 || voice !== 'director') return fail(400, 'Give a line of at most 160 characters.');
    const key = geminiKeys()[0];
    if (!key) return fail(503, 'The voice is not set up.');
    const deadline = Date.now() + BUDGET_MS;
    for (const [model, name] of ATTEMPTS) {
      const left = deadline - Date.now();
      if (left < 500) break;
      try {
        const wav = await speakOnce(key, model, name, text, left);
        return new Response(wav, {
          status: 200,
          headers: { 'content-type': 'audio/wav', 'cache-control': 'public, max-age=31536000, immutable', ...CORS },
        });
      } catch {
        // the next voice or model
      }
    }
    return fail(503, 'The Director lost his voice.');
  } catch {
    return fail(503, 'The Director lost his voice.');
  }
}
