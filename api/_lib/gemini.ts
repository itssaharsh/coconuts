// The one place the model is called from. Keys live in the function's environment, never in the client.
// Several keys and several models are tried in turn inside one time budget: a quota that runs out on one
// key or one model costs a few hundred milliseconds, not the line.

export interface GeminiText {
  text: string;
  model: string;
}

// 2.5 Flash answers a short JSON ask in about a second and keeps to it; the newer Flash models are the
// fallbacks (3 Flash tends to spend a small output budget thinking and return a cut-off preamble).
const MODELS = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'];

/** GEMINI_API_KEYS (comma separated) first, then GEMINI_API_KEY; duplicates dropped. */
export function geminiKeys(): string[] {
  const list = `${process.env.GEMINI_API_KEYS ?? ''},${process.env.GEMINI_API_KEY ?? ''}`
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

const QUOTA = new Set([429, 403]);

export async function geminiJson(prompt: string, opts: { timeoutMs?: number; maxOutputTokens?: number } = {}): Promise<GeminiText> {
  const keys = geminiKeys();
  if (!keys.length) throw new Error('GEMINI_API_KEY is not set');
  const deadline = Date.now() + (opts.timeoutMs ?? 2200);
  let lastErr: unknown = null;
  for (const model of MODELS) {
    for (const key of keys) {
      const left = deadline - Date.now();
      if (left < 300) throw lastErr ?? new Error('no time left for a model');
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), left);
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              maxOutputTokens: opts.maxOutputTokens ?? 200,
              temperature: 0.8,
              // no thinking: a short line needs none, and the newer Flash models spend the output budget on it otherwise
              thinkingConfig: model.startsWith('gemini-2.5') ? { thinkingBudget: 0 } : { thinkingLevel: 'minimal' },
            },
          }),
          signal: ctl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          lastErr = new Error(`${model}: HTTP ${res.status}`);
          if (QUOTA.has(res.status)) continue; // this key is spent for this model: the next key, then the next model
          break; // another error on this model: try the next model with the first key
        }
        const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        if (!text.includes('{')) {
          lastErr = new Error(`${model}: not JSON`); // a cut-off preamble: let the next model try
          break;
        }
        return { text, model };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (Date.now() >= deadline) throw lastErr;
      }
    }
  }
  throw lastErr ?? new Error('no model answered');
}
