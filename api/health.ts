// Probe: makes the cheapest real model call and answers {"ok":true} only when it succeeds. The answer is kept
// for ten minutes per instance, so a watcher polling this route does not spend the model quota.
import { geminiJson } from './_lib/gemini.js';

let cached: { at: number; body: string; status: number } | null = null;
const KEEP_MS = 10 * 60 * 1000;

export async function GET(_req: Request): Promise<Response> {
  if (cached && performance.now() - cached.at < KEEP_MS) {
    return new Response(cached.body, { status: cached.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  try {
    const r = await geminiJson('Reply with the JSON object {"ok":true} and nothing else.', { timeoutMs: 4000, maxOutputTokens: 20 });
    const ok = /"ok"\s*:\s*true/.test(r.text);
    const body = JSON.stringify({ ok, model: r.model });
    if (ok) cached = { at: performance.now(), body, status: 200 };
    return new Response(body, {
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
