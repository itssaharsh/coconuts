// Clips and cue sheets: the three bundled silent-film clips and the moments a foley artist would hit.
// Pure data and checks (no DOM): the JSON lives in public/clips/<id>.json, the film in public/films/<id>.mp4.

import { PROP_IDS, type PropId } from './types';

export const CLIP_IDS = ['one-week', 'safety-last', 'trip-to-the-moon'] as const;
export type ClipId = (typeof CLIP_IDS)[number];

/** Seconds before and after a cue's time that still count as a hit. */
export const DEFAULT_WINDOW: [number, number] = [0.6, 0.8];
/** Cue labels are shown on the cue cards: short enough to read at a glance. */
export const MAX_LABEL_WORDS = 4;

export interface Cue {
  /** Seconds into the clip (not the original film). */
  t: number;
  prop: PropId;
  /** What happens on screen, at most four words ("horse trots in"). */
  label: string;
  /** [before, after] seconds around `t` that count as a hit. */
  window: [number, number];
}

export interface ClipSource {
  /** archive.org item identifier. */
  item: string;
  /** File name inside the item. */
  file: string;
  /** Direct download URL of that file. */
  url: string;
  /** Where the clip was cut from the original, in seconds. */
  segment?: { start: number; length: number };
}

export interface CueProvenance {
  /** The model that proposed cues, e.g. "gemini-2.5-flash". */
  proposed_by: string;
  /** ISO time of the proposal. */
  proposed_at: string;
  /** Who checked the shipped sheet against the frames. */
  checked_by: 'hand';
  notes: string;
}

export interface CueSheet {
  clipId: ClipId;
  cues: Cue[];
  provenance: CueProvenance;
}

export interface Clip {
  id: ClipId;
  title: string;
  year: number;
  director: string;
  source: ClipSource;
  licence: string;
  /** Clip length in seconds (ffprobe of the trimmed file). */
  duration: number;
  /** Path of the film relative to the site base, e.g. "films/one-week.mp4". */
  film: string;
  /** First-frame poster relative to the site base. */
  poster: string;
  cues: Cue[];
  provenance: CueProvenance;
}

export function isClipId(id: string): id is ClipId {
  return (CLIP_IDS as readonly string[]).includes(id);
}

export function isPropId(id: string): id is PropId {
  return (PROP_IDS as readonly string[]).includes(id);
}

export function wordCount(label: string): number {
  return label.trim().split(/\s+/).filter(Boolean).length;
}

/** True when time `t` (seconds into the clip) falls inside the cue's hit window. */
export function inWindow(cue: Cue, t: number): boolean {
  const [before, after] = cue.window;
  return t >= cue.t - before && t <= cue.t + after;
}

/** The cue sheet view of a clip. */
export function cueSheetOf(clip: Clip): CueSheet {
  return { clipId: clip.id, cues: clip.cues, provenance: clip.provenance };
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Every problem with a clip JSON, empty when it is well formed. `minGap` is the smallest allowed spacing of cues. */
export function validateClip(x: unknown, minGap = 1.0): string[] {
  const errs: string[] = [];
  if (!x || typeof x !== 'object') return ['not an object'];
  const c = x as Record<string, unknown>;
  if (!str(c.id) || !isClipId(c.id)) errs.push(`id ${String(c.id)} is not a known clip`);
  if (!str(c.title)) errs.push('title missing');
  if (!num(c.year) || c.year < 1890 || c.year > 1928) errs.push('year missing or not before 1929');
  if (!str(c.director)) errs.push('director missing');
  if (!str(c.licence)) errs.push('licence missing');
  if (!str(c.film)) errs.push('film missing');
  if (!str(c.poster)) errs.push('poster missing');
  const s = c.source as Record<string, unknown> | undefined;
  if (!s || !str(s.item) || !str(s.file) || !str(s.url) || !/^https:\/\/archive\.org\//.test(s.url)) {
    errs.push('source {item, file, url} missing or not archive.org');
  }
  const duration = c.duration;
  if (!num(duration) || duration < 60 || duration > 120.5) errs.push('duration missing or outside 60-120 s');
  const p = c.provenance as Record<string, unknown> | undefined;
  if (!p || !str(p.proposed_by) || !str(p.proposed_at) || p.checked_by !== 'hand' || typeof p.notes !== 'string') {
    errs.push('provenance {proposed_by, proposed_at, checked_by: "hand", notes} missing');
  }
  if (!Array.isArray(c.cues)) return [...errs, 'cues missing'];
  let prev = -Infinity;
  c.cues.forEach((q: unknown, i: number) => {
    const cue = q as Record<string, unknown>;
    const at = `cue ${i}`;
    if (!num(cue.t)) {
      errs.push(`${at}: t missing`);
      return;
    }
    if (num(duration) && (cue.t < 0 || cue.t > duration)) errs.push(`${at}: t ${cue.t} outside the clip`);
    if (!str(cue.prop) || !isPropId(cue.prop)) errs.push(`${at}: prop ${String(cue.prop)} not allowed`);
    if (!str(cue.label) || wordCount(cue.label) > MAX_LABEL_WORDS) errs.push(`${at}: label "${String(cue.label)}" empty or over ${MAX_LABEL_WORDS} words`);
    const w = cue.window;
    if (!Array.isArray(w) || w.length !== 2 || !num(w[0]) || !num(w[1]) || w[0] <= 0 || w[1] <= 0) {
      errs.push(`${at}: window must be two positive numbers`);
    }
    if (cue.t < prev) errs.push(`${at}: cues not sorted`);
    else if (cue.t - prev < minGap) errs.push(`${at}: ${(cue.t - prev).toFixed(2)} s after the previous cue (< ${minGap})`);
    prev = cue.t;
  });
  return errs;
}

/** Checks a clip JSON and returns it typed; throws with every problem listed. */
export function parseClip(x: unknown): Clip {
  const errs = validateClip(x);
  if (errs.length) throw new Error(`bad clip: ${errs.join('; ')}`);
  return x as Clip;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Loads `${base}clips/<id>.json` (base defaults to "/", pass import.meta.env.BASE_URL in the app). */
export async function loadClipMeta(
  id: ClipId,
  opts: { base?: string; fetch?: FetchLike } = {},
): Promise<Clip> {
  const base = opts.base ?? '/';
  const f: FetchLike = opts.fetch ?? ((u) => fetch(u));
  const url = `${base.endsWith('/') ? base : `${base}/`}clips/${id}.json`;
  const res = await f(url);
  if (!res.ok) throw new Error(`clip ${id}: HTTP ${res.status} for ${url}`);
  return parseClip(await res.json());
}
