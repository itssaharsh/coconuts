import { describe, expect, it } from 'vitest';
import { cleanSpeech, handleHear, transcribe } from '../api/hear';

const audio = () => new Uint8Array(4000).fill(7);
const post = (body: Uint8Array, type = 'audio/webm', ip = '10.0.0.1') =>
  new Request('https://x.test/api/hear', { method: 'POST', headers: { 'content-type': type, 'x-forwarded-for': ip }, body });

/** A fake of the three calls the function makes; `polls` is how many "processing" answers come before the result. */
function fakeApi(result: { status: string; text?: string }, polls = 1, uploadOk = true) {
  const calls: string[] = [];
  let left = polls;
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/upload')) return new Response(JSON.stringify({ upload_url: 'https://cdn.test/a' }), { status: uploadOk ? 200 : 500 });
    if (u.endsWith('/transcript')) return new Response(JSON.stringify({ id: 't1' }), { status: 200 });
    if (left-- > 0) return new Response(JSON.stringify({ status: 'processing' }), { status: 200 });
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}
const instant = { sleep: async () => undefined };

describe('cleanSpeech', () => {
  it('makes one short clean line', () => {
    expect(cleanSpeech('  "The thief   hides\nin a barrel!"  ')).toBe('The thief hides in a barrel!');
    expect(cleanSpeech('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen').split(' ')).toHaveLength(14);
    expect(cleanSpeech('what the fuck happens')).not.toMatch(/fuck/i);
    expect(cleanSpeech('')).toBe('');
  });
});

describe('transcribe', () => {
  it('uploads, asks, polls and returns the cleaned words', async () => {
    const api = fakeApi({ status: 'completed', text: 'The knight falls in a well.' }, 2);
    expect(await transcribe(audio(), { key: 'k', fetch: api.f, ...instant })).toBe('The knight falls in a well.');
    expect(api.calls.filter((c) => c.includes('/transcript/t1'))).toHaveLength(3);
  });
  it('is null without a key, on an upload failure, on an error status and on empty speech', async () => {
    expect(await transcribe(audio(), { key: '', fetch: fakeApi({ status: 'completed', text: 'x' }).f, ...instant })).toBeNull();
    expect(await transcribe(audio(), { key: 'k', fetch: fakeApi({ status: 'completed', text: 'x' }, 1, false).f, ...instant })).toBeNull();
    expect(await transcribe(audio(), { key: 'k', fetch: fakeApi({ status: 'error' }).f, ...instant })).toBeNull();
    expect(await transcribe(audio(), { key: 'k', fetch: fakeApi({ status: 'completed', text: '   ' }).f, ...instant })).toBeNull();
  });
  it('gives up at the deadline', async () => {
    let t = 0;
    const api = fakeApi({ status: 'completed', text: 'late' }, 1000);
    const out = await transcribe(audio(), { key: 'k', fetch: api.f, now: () => (t += 900), sleep: async () => undefined });
    expect(out).toBeNull();
  });
});

describe('POST /api/hear', () => {
  it('answers with the words', async () => {
    const api = fakeApi({ status: 'completed', text: 'A dragon eats the crown.' });
    const res = await handleHear(post(audio()), { key: 'k', fetch: api.f, ...instant });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'A dragon eats the crown.' });
  });
  it('refuses what is not a short piece of audio', async () => {
    expect((await handleHear(post(audio(), 'text/plain', '10.0.0.2'), { key: 'k' })).status).toBe(415);
    expect((await handleHear(post(new Uint8Array(10), 'audio/webm', '10.0.0.3'), { key: 'k' })).status).toBe(400);
    expect((await handleHear(post(new Uint8Array(500 * 1024), 'audio/webm', '10.0.0.4'), { key: 'k' })).status).toBe(413);
  });
  it('says so when hearing is off or nothing was heard', async () => {
    expect((await handleHear(post(audio(), 'audio/webm', '10.0.0.5'), { key: '' })).status).toBe(503);
    const api = fakeApi({ status: 'error' });
    expect((await handleHear(post(audio(), 'audio/webm', '10.0.0.6'), { key: 'k', fetch: api.f, ...instant })).status).toBe(502);
  });
});
