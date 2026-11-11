// The Director in the browser: a line before the take, a review after it (model first, rules always ready), and a voice.
import { CueTracker, type Cue } from './cues';
import { ensureAudio, playVoice } from './sound';
import type { PropId, Take } from './types';

/** The rule-based review: always available, never needs the network. */
export function directorLine(tracker: CueTracker): string {
  const { best, late } = tracker.highlights();
  if (tracker.hits === 0) return 'Not a single cue, and yet a performance.';
  const q = (label: string) => `“${label}”`;
  if (best && late && best !== late) return `Right on time: ${q(best.cue.label)}. Fashionably late: ${q(late.cue.label)}.`;
  if (best) return `Right on time: ${q(best.cue.label)}. The rest can rehearse.`;
  return `${tracker.hits} of ${tracker.total}. The props would like a word.`;
}

/** What the Director says before the clapper, keyed by the prop of the clip's first cue. */
export const DIRECTOR_LINES: Record<PropId, string> = {
  coconuts: 'Running feet first. Hold the coconuts and shake them.',
  door: 'A bang to start. Tap the door to knock, hold it to slam.',
  bell: 'A bell first. Poke it. Then it gets loud.',
  thunder: 'Thunder early. Hold the sheet and shake it.',
  whistle: 'Starts with a swing. Hold the whistle and pull.',
  glass: 'Something breaks early. Lift the bag and let it go.',
};

const QUIET_ON_SET = 'Quiet on set. Pinch the clapper when you are ready.';

export function preTakeLine(clip: { id: string; title: string; cues: Cue[] }): string {
  const first = [...clip.cues].sort((a, b) => a.t - b.t)[0];
  return (first && DIRECTOR_LINES[first.prop]) || QUIET_ON_SET;
}

/** The body /api/director expects (mirrors DirectorInput in api/_lib/director-core.ts). */
export interface DirectorPayload {
  clipId: string;
  title: string;
  year: number;
  cues: { t: number; prop: string; label: string }[];
  events: { t: number; prop: string; kind: string; v: number }[];
  hits: { hit: string[]; missed: string[]; best: { label: string; offset: number } | null; late: { label: string; offset: number } | null };
}

const MAX_EVENTS = 80;
const MAX_BYTES = 7500;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The take, compacted to fit the API's 8 KB limit: rounded numbers, and an even sample when there are many events. */
export function directorPayload(clip: { id: string; title: string; year: number }, tracker: CueTracker, take: Take): DirectorPayload {
  const { best, late, missed } = tracker.highlights();
  const sample = (n: number) => {
    const all = take.events;
    if (all.length <= n) return all;
    return Array.from({ length: n }, (_, i) => all[Math.floor((i * all.length) / n)]);
  };
  const mark = (s: typeof best) => (s && s.offset !== null ? { label: s.cue.label, offset: r2(s.offset) } : null);
  const payload: DirectorPayload = {
    clipId: clip.id,
    title: clip.title,
    year: clip.year,
    cues: tracker.states.map((s) => ({ t: r2(s.cue.t), prop: s.cue.prop, label: s.cue.label })),
    events: sample(MAX_EVENTS).map((e) => ({ t: r2(e.t), prop: e.prop, kind: e.kind, v: r2(e.v) })),
    hits: {
      hit: tracker.states.filter((s) => s.hit).map((s) => s.cue.label),
      missed: missed.map((s) => s.cue.label),
      best: mark(best),
      late: late && late !== best ? mark(late) : null,
    },
  };
  if (JSON.stringify(payload).length > MAX_BYTES) payload.events = sample(20).map((e) => ({ t: r2(e.t), prop: e.prop, kind: e.kind, v: r2(e.v) }));
  return payload;
}

const defaultBase = (): string => {
  try {
    // VITE_DIRECTOR_BASE points a dev build at a deployed Director (the dev server has no functions)
    return (import.meta.env?.VITE_DIRECTOR_BASE as string | undefined) || import.meta.env?.BASE_URL || '/';
  } catch {
    return '/';
  }
};

/** Fetch with a hard deadline that also covers reading the body. */
async function within<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Error('timeout'));
    }, ms);
  });
  const work = run(ctl.signal);
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The review after a take: the model's line when it answers in time, the rule line otherwise. Never throws. */
export async function reviewTake(args: {
  clip: { id: string; title: string; year: number };
  tracker: CueTracker;
  take: Take;
  base?: string;
  timeoutMs?: number;
}): Promise<{ line: string; source: 'model' | 'rules' }> {
  const { clip, tracker, take, base = defaultBase(), timeoutMs = 2500 } = args;
  const rules = () => ({ line: directorLine(tracker), source: 'rules' as const });
  try {
    const body = JSON.stringify(directorPayload(clip, tracker, take));
    const data = await within(timeoutMs, async (signal) => {
      const res = await fetch(`${base}api/director`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal });
      if (!res.ok) return null;
      return (await res.json()) as { line?: unknown; source?: unknown };
    });
    const line = typeof data?.line === 'string' ? data.line.trim() : '';
    if (!line || line.length > 200) return rules();
    return { line, source: data?.source === 'model' ? 'model' : 'rules' };
  } catch {
    return rules();
  }
}

/** Say a line in the Director's voice. Resolves true once it has played, false (quietly) when it could not. */
export async function speak(text: string, base: string = defaultBase(), timeoutMs = 2500): Promise<boolean> {
  try {
    const t = text.trim();
    if (!t || t.length > 160) return false;
    const ctx = await ensureAudio();
    if (!ctx) return false;
    const audio = await within(timeoutMs, async (signal) => {
      const res = await fetch(`${base}api/tts?t=${encodeURIComponent(t)}&v=director`, { signal });
      if (!res.ok) return null;
      return await res.arrayBuffer();
    });
    if (!audio || audio.byteLength < 64) return false;
    await playVoice(audio);
    return true;
  } catch {
    return false;
  }
}
