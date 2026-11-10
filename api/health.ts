// Probe: makes the cheapest real model call and answers {"ok":true} only when it succeeds.
import { geminiJson } from './_lib/gemini.js';

export async function GET(_req: Request): Promise<Response> {
  try {
    const r = await geminiJson('Reply with the JSON object {"ok":true} and nothing else.', { timeoutMs: 4000, maxOutputTokens: 20 });
    const ok = /"ok"\s*:\s*true/.test(r.text);
    return new Response(JSON.stringify({ ok, model: r.model }), {
      status: ok ? 200 : 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}
