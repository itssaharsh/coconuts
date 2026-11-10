// The one place the model is called from. The key lives in the function's environment, never in the client.

export interface GeminiText {
  text: string;
  model: string;
}

const MODELS = ['gemini-3-flash-preview', 'gemini-2.5-flash'];

export async function geminiJson(prompt: string, opts: { timeoutMs?: number; maxOutputTokens?: number } = {}): Promise<GeminiText> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const timeoutMs = opts.timeoutMs ?? 2200;
  let lastErr: unknown = null;
  for (const model of MODELS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: opts.maxOutputTokens ?? 200,
            temperature: 0.9,
            thinkingConfig: model.startsWith('gemini-2.5') ? { thinkingBudget: 0 } : { thinkingLevel: 'low' },
          },
        }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = new Error(`${model}: HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) {
        lastErr = new Error(`${model}: empty`);
        continue;
      }
      return { text, model };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('no model answered');
}
