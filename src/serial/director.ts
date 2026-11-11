// The Director, as the stage sees it: ask the reel function for the next reel's plan. Whatever goes wrong (no network,
// a slow model, an answer that does not check) the answer is null and the Serial plays a written reel instead.
import { PROP_IDS, type PropId } from '../foley/types';
import { checkPlan, type Pitch, type ReelPlan } from './pieces';

/** What one finished reel was, for the Director to build on. */
export interface StoryLine {
  title: string;
  wrote: string[];
  flags: string[];
  cliffhanger: string;
}

export interface ReelRequest {
  /** The number of the reel to write (2 is the first one the Director writes). */
  reel: number;
  pitch: { prop?: PropId; text: string; spoken?: boolean };
  story: StoryLine[];
}

export interface ReelAnswer {
  plan: ReelPlan;
  pitches: Pitch[];
  note: string;
  source: string;
}

function base(): string {
  try {
    // VITE_DIRECTOR_BASE points a dev build at a deployment (the dev servers have no functions)
    return (import.meta.env?.VITE_DIRECTOR_BASE as string | undefined) || import.meta.env?.BASE_URL || '/';
  } catch {
    return '/';
  }
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Keep only an answer the stage can play: a plan that checks, three pitches on three props, a short note. */
export function readAnswer(data: unknown): ReelAnswer | null {
  const a = data as Partial<ReelAnswer> | null;
  if (!a || typeof a !== 'object' || checkPlan(a.plan).length) return null;
  const pitches = Array.isArray(a.pitches)
    ? a.pitches.filter((p): p is Pitch => !!p && PROP_IDS.includes(p.prop) && typeof p.text === 'string' && words(p.text) >= 1 && words(p.text) <= 8 && p.text.length <= 60)
    : [];
  const distinct = pitches.filter((p, i) => pitches.findIndex((q) => q.prop === p.prop) === i).slice(0, 3);
  const note = typeof a.note === 'string' && words(a.note) <= 16 ? a.note.trim() : '';
  return { plan: a.plan as ReelPlan, pitches: distinct.length === 3 ? distinct : [], note, source: typeof a.source === 'string' ? a.source : 'unknown' };
}

export async function requestReel(req: ReelRequest, timeoutMs = 9500): Promise<ReelAnswer | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base()}api/reel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    return readAnswer(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
