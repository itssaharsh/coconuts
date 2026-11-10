import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  audioToWav,
  buildPrompt,
  composeDirector,
  parseDirectorInput,
  parseLine,
  ruleLine,
  validateLine,
  wavFromPcm16,
  type DirectorInput,
  type ModelReply,
} from '../api/_lib/director-core';
import { allow } from '../api/_lib/ratelimit';
import { CueTracker, type Cue } from '../src/foley/cues';
import type { HitEvent, Take } from '../src/foley/types';

const sound = vi.hoisted(() => ({ ensureAudio: vi.fn(async () => ({}) as unknown), playVoice: vi.fn(async () => undefined) }));
vi.mock('../src/foley/sound', () => sound);

import { DIRECTOR_LINES, directorLine, directorPayload, preTakeLine, reviewTake, speak } from '../src/foley/director';
import { POST as directorPOST } from '../api/director';
import { GET as ttsGET } from '../api/tts';

const FIX = join(__dirname, 'fixtures', 'director');
const input = JSON.parse(readFileSync(join(FIX, 'input.json'), 'utf8')) as DirectorInput;

interface Fixture {
  name: string;
  reply?: ModelReply;
  throw?: string;
  hang?: boolean;
  timeoutMs?: number;
  expect: { source: 'model' | 'rules'; line: string; model?: string };
}
const fixtures = readdirSync(FIX)
  .filter((f) => f !== 'input.json')
  .map((f) => ({ file: f, fx: JSON.parse(readFileSync(join(FIX, f), 'utf8')) as Fixture }));

const cues: Cue[] = [
  { t: 2.0, prop: 'coconuts', label: 'horse trots in', window: [0.6, 0.8] },
  { t: 2.4, prop: 'coconuts', label: 'horse again', window: [0.3, 0.3] },
  { t: 5.0, prop: 'door', label: 'door slams', window: [0.6, 0.8] },
  { t: 9.0, prop: 'whistle', label: 'falls off roof', window: [0.6, 1.0] },
];
const clip = { id: 'test-reel', title: 'The Test Reel', year: 1921 };
const ev = (t: number, prop: HitEvent['prop'], kind: HitEvent['kind'] = 'clop'): HitEvent => ({ t, prop, kind, v: 0.8 });

function play(events: HitEvent[]): { tracker: CueTracker; take: Take } {
  const tracker = new CueTracker(cues);
  for (const e of events) tracker.register(e);
  return { tracker, take: { clipId: clip.id, events, startedAt: '2026-11-10T00:00:00Z' } };
}

const withHits = (h: Partial<DirectorInput['hits']>): DirectorInput => ({ ...input, hits: { ...input.hits, ...h } });

describe('composeDirector against the fixtures', () => {
  it('has the fixtures the contract names (ok, 429, timeout) and more', () => {
    const names = fixtures.map((f) => f.file);
    for (const n of ['ok.json', 'rate-limited.json', 'timeout.json', 'absent-prop.json', 'too-long.json', 'malformed.json']) {
      expect(names).toContain(n);
    }
  });

  for (const { file, fx } of fixtures) {
    it(`${file}: ${fx.name}`, async () => {
      const call = vi.fn(async (_prompt: string): Promise<ModelReply> => {
        if (fx.throw) throw new Error(fx.throw);
        if (fx.hang) return new Promise<ModelReply>(() => undefined);
        return fx.reply!;
      });
      const timeoutMs = fx.timeoutMs ?? 2200;
      // fake timers: the timeout path is measured on a virtual clock, so a loaded machine cannot skew it
      vi.useFakeTimers();
      try {
        const t0 = Date.now();
        const pending = composeDirector(input, call, timeoutMs);
        await vi.advanceTimersByTimeAsync(timeoutMs - 10);
        if (fx.hang) expect(Date.now() - t0).toBe(timeoutMs - 10);
        await vi.advanceTimersByTimeAsync(20);
        const out = await pending;
        const took = Date.now() - t0;
        expect(call).toHaveBeenCalledTimes(1);
        expect(out.source).toBe(fx.expect.source);
        expect(out.line).toBe(fx.expect.line);
        if (fx.expect.model) expect(out.model).toBe(fx.expect.model);
        if (out.source === 'rules') expect(out.line).toBe(ruleLine(input));
        expect(took).toBeLessThanOrEqual(timeoutMs + 10);
        if (fx.hang) expect(took).toBeGreaterThanOrEqual(timeoutMs);
      } finally {
        vi.useRealTimers();
      }
    }, 5000);
  }

  it('falls back when the call throws synchronously', async () => {
    const out = await composeDirector(input, () => {
      throw new Error('boom');
    });
    expect(out).toEqual({ line: ruleLine(input), source: 'rules' });
  });
});

describe('ruleLine', () => {
  it('zero hits', () => {
    expect(ruleLine(withHits({ hit: [], missed: cues.map((c) => c.label), best: null, late: null }))).toBe(
      'Not a single cue, and yet a performance.',
    );
  });
  it('best and late', () => {
    expect(ruleLine(input)).toBe('Right on time: “horse trots in”. Fashionably late: “door slams”.');
  });
  it('best only', () => {
    expect(ruleLine(withHits({ late: null }))).toBe('Right on time: “horse trots in”. The rest can rehearse.');
  });
  it('best and late the same cue reads as best only', () => {
    expect(ruleLine(withHits({ late: { label: 'horse trots in', offset: 0.05 } }))).toBe(
      'Right on time: “horse trots in”. The rest can rehearse.',
    );
  });
  it('hits without a best mark', () => {
    expect(ruleLine(withHits({ best: null, late: null }))).toBe('2 of 4. The horse would like a word.');
  });

  it('matches the client directorLine word for word for the same take', () => {
    const takes: HitEvent[][] = [
      [],
      [ev(2.05, 'coconuts')],
      [ev(2.05, 'coconuts'), ev(5.7, 'door', 'slam')],
      [ev(2.3, 'coconuts'), ev(2.3, 'coconuts'), ev(9.9, 'whistle', 'whistle')],
      [ev(5.6, 'door', 'slam')],
    ];
    for (const events of takes) {
      const { tracker, take } = play(events);
      const payload = parseDirectorInput(JSON.parse(JSON.stringify(directorPayload(clip, tracker, take))));
      expect(payload).not.toBeNull();
      expect(ruleLine(payload!)).toBe(directorLine(tracker));
    }
  });
});

describe('validateLine', () => {
  it('accepts a quoted label that exists and rejects it when it does not', () => {
    expect(validateLine('Right on time: “horse trots in”.', input)).toBe(true);
    const other = { ...input, cues: input.cues.filter((c) => c.label !== 'horse trots in') };
    expect(validateLine('Right on time: “horse trots in”.', other)).toBe(false);
  });
  it('accepts every rule line it could produce for this take', () => {
    for (const h of [{}, { late: null }, { best: null, late: null }, { hit: [], best: null, late: null }]) {
      const i = withHits(h);
      expect(validateLine(ruleLine(i), i)).toBe(true);
    }
  });
  it('rejects props and cues the take does not have', () => {
    expect(validateLine('The accordion was late.', input)).toBe(false);
    expect(validateLine('The glass shattered on cue.', input)).toBe(false);
    expect(validateLine('The bell rang twice.', input)).toBe(false);
    expect(validateLine('The door was early, the horse was not.', input)).toBe(true);
  });
  it('rejects counts that are not the hits or the total', () => {
    expect(validateLine('2 of 4, which is a start.', input)).toBe(true);
    expect(validateLine('3 of 4, which is a start.', input)).toBe(false);
    expect(validateLine('Within 0.05 seconds on “horse trots in”.', input)).toBe(false);
    expect(validateLine('It was 1921 all over again.', input)).toBe(false);
  });
  it('rejects names that are not in the take, and long, loud or multi-sentence lines', () => {
    expect(validateLine('A fine take, Mr Keaton would approve.', input)).toBe(false);
    expect(validateLine('Lovely work on “door slams”!', input)).toBe(false);
    expect(validateLine('Lovely work on “door slams” 🐴.', input)).toBe(false);
    expect(validateLine('Good. Better. Best. Again.', input)).toBe(false);
    expect(validateLine('x'.repeat(141), input)).toBe(false);
    expect(validateLine('“horse trots in”, “horse again” and “door slams” all came in.', input)).toBe(false);
  });
});

describe('buildPrompt and parseLine', () => {
  it('states the facts and the brief', () => {
    const p = buildPrompt(input);
    expect(p).toContain('ONE sentence of at most 18 words');
    expect(p).toContain('Cues hit: 2 of 4.');
    expect(p).toContain('“horse trots in”');
    expect(p).toContain('“falls off roof”');
    expect(p).toContain('Never invent events');
    expect(p).toContain('No emoji, no exclamation marks');
    expect(p).toContain('{"line": "..."}');
    expect(p).not.toContain('glass');
    expect(p).not.toMatch(/\u2014/);
  });
  it('reads the line out of fenced or wrapped replies', () => {
    expect(parseLine('```json\n{"line": "Fine."}\n```')).toBe('Fine.');
    expect(parseLine('Sure: {"line": "\\"Fine.\\""}')).toBe('Fine.');
    expect(parseLine('{"nope": 1}')).toBeNull();
    expect(parseLine('')).toBeNull();
  });
});

describe('parseDirectorInput', () => {
  it('accepts the client payload and the fixture', () => {
    const { tracker, take } = play([ev(2.05, 'coconuts')]);
    expect(parseDirectorInput(JSON.parse(JSON.stringify(directorPayload(clip, tracker, take))))).not.toBeNull();
    expect(parseDirectorInput(input)).toEqual(input);
  });
  it('rejects bad shapes', () => {
    expect(parseDirectorInput(null)).toBeNull();
    expect(parseDirectorInput({ ...input, cues: 'no' })).toBeNull();
    expect(parseDirectorInput({ ...input, year: '1921' })).toBeNull();
    expect(parseDirectorInput({ ...input, cues: [{ t: 'x', prop: 'door', label: 'a' }] })).toBeNull();
    expect(parseDirectorInput({ ...input, events: Array.from({ length: 401 }, () => input.events[0]) })).toBeNull();
    expect(parseDirectorInput({ ...input, hits: { hit: [], missed: [], best: 5 } })).toBeNull();
  });
  it('drops hit labels and marks that are not cues', () => {
    const out = parseDirectorInput({ ...input, hits: { hit: ['made up'], missed: [], best: { label: 'made up', offset: 0 } } });
    expect(out?.hits).toEqual({ hit: [], missed: [], best: null, late: null });
  });
  it('keeps the client payload under the 8 KB limit for a busy take', () => {
    const events = Array.from({ length: 600 }, (_, i) => ev(i * 0.2, 'coconuts'));
    const { tracker, take } = play(events);
    expect(JSON.stringify(directorPayload(clip, tracker, take)).length).toBeLessThan(8 * 1024);
  });
});

describe('WAV wrapper', () => {
  it('writes a 44-byte PCM header for 24 kHz mono', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const wav = new DataView(wavFromPcm16(pcm));
    const tag = (at: number) => String.fromCharCode(...new Uint8Array(wav.buffer, at, 4));
    expect(wav.byteLength).toBe(48);
    expect(tag(0)).toBe('RIFF');
    expect(wav.getUint32(4, true)).toBe(40);
    expect(tag(8)).toBe('WAVE');
    expect(tag(12)).toBe('fmt ');
    expect(wav.getUint16(20, true)).toBe(1);
    expect(wav.getUint16(22, true)).toBe(1);
    expect(wav.getUint32(24, true)).toBe(24000);
    expect(wav.getUint32(28, true)).toBe(48000);
    expect(wav.getUint16(34, true)).toBe(16);
    expect(tag(36)).toBe('data');
    expect(wav.getUint32(40, true)).toBe(4);
    expect(wav.getUint8(44)).toBe(1);
  });
  it('wraps L16 at the stated rate, passes WAV through and refuses the rest', () => {
    const pcm = new Uint8Array(8);
    expect(new DataView(audioToWav('audio/L16;codec=pcm;rate=16000', pcm)!).getUint32(24, true)).toBe(16000);
    expect(audioToWav('audio/wav', pcm)!.byteLength).toBe(8);
    expect(audioToWav('audio/mpeg', pcm)).toBeNull();
    expect(audioToWav('audio/L16', new Uint8Array(0))).toBeNull();
  });
});

describe('rate limit', () => {
  it('allows 30 a minute per IP and refills', () => {
    const t = 1_000_000;
    for (let i = 0; i < 30; i++) expect(allow('10.0.0.1', t)).toBe(true);
    expect(allow('10.0.0.1', t)).toBe(false);
    expect(allow('10.0.0.2', t)).toBe(true);
    expect(allow('10.0.0.1', t + 2000)).toBe(true);
    expect(allow('10.0.0.1', t + 2000)).toBe(false);
  });
});

describe('the API handlers without a key', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });
  afterAll(() => {
    if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
  });

  const post = (body: string, ip = '192.0.2.10') =>
    directorPOST(new Request('http://x/api/director', { method: 'POST', headers: { 'x-forwarded-for': `${ip}, 10.0.0.9` }, body }));

  it('/api/director answers with the rule line, no-store', async () => {
    const res = await post(JSON.stringify(input));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ line: ruleLine(input), source: 'rules', model: null });
  });
  it('/api/director refuses bad JSON, bad shapes and big bodies', async () => {
    expect((await post('{nope', '192.0.2.11')).status).toBe(400);
    expect((await post(JSON.stringify({ ...input, cues: 3 }), '192.0.2.11')).status).toBe(400);
    expect((await post('x'.repeat(9000), '192.0.2.11')).status).toBe(413);
  });
  it('/api/director rate-limits one IP at 30 a minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await post('{}', '192.0.2.12')).status);
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
  it('/api/tts validates, then says 503 JSON without a key', async () => {
    const get = (q: string, ip = '192.0.2.20') => ttsGET(new Request(`http://x/api/tts?${q}`, { headers: { 'x-forwarded-for': ip } }));
    expect((await get(`t=${encodeURIComponent('x'.repeat(161))}&v=director`)).status).toBe(400);
    expect((await get('t=hello&v=someone')).status).toBe(400);
    const res = await get(`t=${encodeURIComponent('Doors in this one. Mind the slam.')}&v=director`);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toHaveProperty('error');
  });
});

describe('client: lines before and after the take', () => {
  it('has the written bank, keyed by the first cue', () => {
    expect(DIRECTOR_LINES).toEqual({
      coconuts: 'Horse coming up. Grab the coconuts.',
      door: 'Doors in this one. Mind the slam.',
      bell: 'A bell first. Then it gets loud.',
      thunder: 'Thunder, then glass. Hold the sheet.',
      whistle: 'Starts with a fall. Whistle ready.',
      glass: 'Something breaks early. Hands on the bag.',
    });
    expect(preTakeLine({ id: 'x', title: 'X', cues: [cues[2], cues[0]] })).toBe('Horse coming up. Grab the coconuts.');
    expect(preTakeLine({ id: 'x', title: 'X', cues: [] })).toBe('Quiet on set. Pinch the clapper when you are ready.');
    for (const line of [...Object.values(DIRECTOR_LINES)]) expect(line).not.toMatch(/[\u2014!]/);
  });

  it('directorLine keeps its exact wording', () => {
    expect(directorLine(play([]).tracker)).toBe('Not a single cue, and yet a performance.');
    expect(directorLine(play([ev(2.05, 'coconuts'), ev(5.7, 'door', 'slam')]).tracker)).toBe(
      'Right on time: “horse trots in”. Fashionably late: “door slams”.',
    );
    expect(directorLine(play([ev(2.05, 'coconuts')]).tracker)).toBe('Right on time: “horse trots in”. The rest can rehearse.');
  });
});

describe('client: reviewTake and speak', () => {
  const { tracker, take } = play([ev(2.05, 'coconuts'), ev(5.7, 'door', 'slam')]);
  const rules = 'Right on time: “horse trots in”. Fashionably late: “door slams”.';

  beforeEach(() => {
    vi.unstubAllGlobals();
    sound.playVoice.mockClear();
    sound.ensureAudio.mockClear();
  });

  it('uses the model line when the API answers', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ line: 'The horse kept time.', source: 'model', model: 'm' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await reviewTake({ clip, tracker, take, base: 'http://t/' })).toEqual({ line: 'The horse kept time.', source: 'model' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://t/api/director');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body)).hits.best).toEqual({ label: 'horse trots in', offset: 0.05 });
  });

  it('falls back to the rule line on an error status, bad JSON or a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    expect(await reviewTake({ clip, tracker, take, base: 'http://t/' })).toEqual({ line: rules, source: 'rules' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    expect(await reviewTake({ clip, tracker, take, base: 'http://t/' })).toEqual({ line: rules, source: 'rules' });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    expect(await reviewTake({ clip, tracker, take, base: 'http://t/' })).toEqual({ line: rules, source: 'rules' });
  });

  it('falls back within its timeout when the API hangs', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const t0 = Date.now();
    const out = await reviewTake({ clip, tracker, take, base: 'http://t/', timeoutMs: 300 });
    expect(out).toEqual({ line: rules, source: 'rules' });
    expect(Date.now() - t0).toBeLessThanOrEqual(400);
  });

  it('speak fetches the voice and plays it', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(new Uint8Array(200), { status: 200, headers: { 'content-type': 'audio/wav' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await speak('Doors in this one. Mind the slam.', 'http://t/')).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`http://t/api/tts?t=${encodeURIComponent('Doors in this one. Mind the slam.')}&v=director`);
    expect(sound.playVoice).toHaveBeenCalledTimes(1);
  });

  it('speak returns false quietly on failure, silence or a long line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    expect(await speak('Hello there.', 'http://t/')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    expect(await speak('Hello there.', 'http://t/', 200)).toBe(false);
    expect(await speak('x'.repeat(161), 'http://t/')).toBe(false);
    sound.ensureAudio.mockResolvedValueOnce(null);
    expect(await speak('Hello there.', 'http://t/')).toBe(false);
    expect(sound.playVoice).not.toHaveBeenCalled();
  });
});
