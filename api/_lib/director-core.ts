// The Director's brain without the network: the rule line, the prompt, the checks on a model line, and the WAV wrapper.
// Pure functions only, so the tests can drive every path with fixtures.

interface DirectorCue {
  t: number;
  prop: string;
  label: string;
}

interface DirectorEvent {
  t: number;
  prop: string;
  kind: string;
  v: number;
}

interface DirectorMark {
  label: string;
  offset: number;
}

export interface DirectorInput {
  clipId: string;
  title: string;
  year: number;
  cues: DirectorCue[];
  events: DirectorEvent[];
  hits: { hit: string[]; missed: string[]; best?: DirectorMark | null; late?: DirectorMark | null };
}

export interface DirectorResult {
  line: string;
  source: 'model' | 'rules';
  model?: string;
}

/** What a model call hands back: the raw text, and the model name when known. */
export type ModelReply = string | { text: string; model?: string };

const q = (label: string) => `“${label}”`;

const sameMark = (a: DirectorMark, b: DirectorMark) => a.label === b.label && a.offset === b.offset;

/** The rule-based line, word for word the same family as the client's directorLine. */
export function ruleLine(input: DirectorInput): string {
  const hits = input.hits.hit.length;
  const total = input.cues.length;
  const best = input.hits.best ?? null;
  const late = input.hits.late ?? null;
  if (hits === 0) return 'Not a single cue, and yet a performance.';
  if (best && late && !sameMark(best, late)) return `Right on time: ${q(best.label)}. Fashionably late: ${q(late.label)}.`;
  if (best) return `Right on time: ${q(best.label)}. The rest can rehearse.`;
  return `${hits} of ${total}. The horse would like a word.`;
}

/** The six props and the everyday words a line may use for each. */
const PROP_WORDS = new Map<string, string>([
  ['coconut', 'coconuts'],
  ['coconuts', 'coconuts'],
  ['horse', 'coconuts'],
  ['horses', 'coconuts'],
  ['hooves', 'coconuts'],
  ['hoofbeats', 'coconuts'],
  ['clop', 'coconuts'],
  ['clops', 'coconuts'],
  ['door', 'door'],
  ['doors', 'door'],
  ['slam', 'door'],
  ['slams', 'door'],
  ['slammed', 'door'],
  ['knock', 'door'],
  ['knocks', 'door'],
  ['knocked', 'door'],
  ['bell', 'bell'],
  ['bells', 'bell'],
  ['ding', 'bell'],
  ['thunder', 'thunder'],
  ['rumble', 'thunder'],
  ['whistle', 'whistle'],
  ['whistles', 'whistle'],
  ['fall', 'whistle'],
  ['falls', 'whistle'],
  ['glass', 'glass'],
  ['crash', 'glass'],
  ['crashes', 'glass'],
  ['crashed', 'glass'],
]);

/** Sound makers that are not on this table; a line naming one invented it. */
const FOREIGN_PROPS = new Set(
  (
    'accordion banjo bagpipe bagpipes bugle castanets cello clarinet cowbell cymbal cymbals drum drums drumroll fiddle flute ' +
    'gong guitar harmonica harp horn kazoo klaxon maracas oboe organ piano rattle saxophone siren snare tambourine ' +
    'triangle trombone trumpet tuba ukulele viola violin washboard woodblock xylophone'
  ).split(' '),
);

const NUMBER_WORDS = new Map<string, number>([
  ['zero', 0],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
  ['thirteen', 13],
  ['fourteen', 14],
  ['fifteen', 15],
  ['sixteen', 16],
  ['seventeen', 17],
  ['eighteen', 18],
  ['nineteen', 19],
  ['twenty', 20],
]);

const PROP_NAMES = new Map<string, string>([
  ['coconuts', 'coconut shells'],
  ['door', 'little door'],
  ['bell', 'desk bell'],
  ['thunder', 'thunder sheet'],
  ['whistle', 'slide whistle'],
  ['glass', 'bag of glass'],
]);

/** Props this take touched: the cue sheet's and the ones the player actually used. */
function propsInPlay(input: DirectorInput): Set<string> {
  return new Set([...input.cues.map((c) => c.prop), ...input.events.map((e) => e.prop)]);
}

const words = (s: string) => s.toLowerCase().match(/[a-z]+/g) ?? [];

/** The prompt: the take in plain facts, then the Director's brief. */
export function buildPrompt(input: DirectorInput): string {
  const hits = input.hits.hit.length;
  const total = input.cues.length;
  const list = (labels: string[]) => (labels.length ? labels.map(q).join(', ') : 'none');
  const counts = new Map<string, number>();
  for (const e of input.events) counts.set(e.prop, (counts.get(e.prop) ?? 0) + 1);
  const sounds = [...counts].map(([p, n]) => `${p} x${n}`).join(', ') || 'none';
  const props = [...propsInPlay(input)].map((p) => (PROP_NAMES.has(p) ? `${p} (${PROP_NAMES.get(p)})` : p)).join(', ');
  const best = input.hits.best;
  const late = input.hits.late;
  const facts = [
    `Film: ${q(input.title)} (${input.year}).`,
    `Cues hit: ${hits} of ${total}.`,
    `Cues landed: ${list(input.hits.hit)}.`,
    `Cues missed: ${list(input.hits.missed)}.`,
    best ? `Best timed: ${q(best.label)}, ${Math.abs(best.offset).toFixed(2)} s off.` : 'Best timed: none.',
    late && (!best || !sameMark(best, late)) ? `Latest: ${q(late.label)}, ${late.offset.toFixed(2)} s late.` : 'Latest: none.',
    `Sounds made: ${sounds}.`,
    `Props in play: ${props || 'none'}.`,
  ];
  return [
    'You are the Director: a dry, warm silent-era studio director who has seen worse.',
    'A player just performed the sound effects for a silent film live, with toy foley props, and you review the take.',
    '',
    'The take:',
    ...facts,
    '',
    'Write ONE sentence of at most 18 words.',
    'Name at most two cues, quoting their labels exactly as written above, inside “ ”.',
    'Mention only the cues and props listed above. Never invent events, people, props or sounds.',
    `The only numbers you may use are ${hits} and ${total}.`,
    'No emoji, no exclamation marks, no dashes.',
    'Reply with JSON only: {"line": "..."}',
  ].join('\n');
}

const QUOTED = /“([^”]*)”|"([^"]*)"|‘([^’]*)’/g;
const EMOJI = /\p{Extended_Pictographic}/u;

/** True when the line is short, one sentence, and only names cues, props and numbers the take contains. */
export function validateLine(line: string, input: DirectorInput): boolean {
  if (typeof line !== 'string') return false;
  const s = line.trim();
  if (!s || s.length > 140) return false;
  if ((s.match(/[.?]/g) ?? []).length > 2) return false;
  if (/[!\u2014{}<>\\]/.test(s) || EMOJI.test(s)) return false;

  const labels = new Set(input.cues.map((c) => c.label.trim().toLowerCase()));
  const present = propsInPlay(input);
  const known = new Set([...input.cues.flatMap((c) => words(c.label)), ...words(input.title)]);

  // every quoted phrase is a cue label, or a prop that is in play
  let named = 0;
  for (const m of s.matchAll(QUOTED)) {
    const phrase = (m[1] ?? m[2] ?? m[3] ?? '').trim().replace(/[.,;:?]+$/, '').toLowerCase();
    if (labels.has(phrase)) {
      named++;
      continue;
    }
    const prop = PROP_WORDS.get(phrase);
    if (!prop || !present.has(prop)) return false;
  }
  if (named > 2) return false;

  // outside the quotes: no props or numbers the take does not have
  const rest = s.replace(QUOTED, ' ');
  const allowedNumbers = new Set([input.hits.hit.length, input.cues.length]);
  for (const n of rest.match(/\d+(?:[.,]\d+)?/g) ?? []) {
    if (!/^\d+$/.test(n) || !allowedNumbers.has(Number(n))) return false;
  }
  for (const w of words(rest)) {
    if (known.has(w)) continue;
    if (FOREIGN_PROPS.has(w)) return false;
    const prop = PROP_WORDS.get(w);
    if (prop && !present.has(prop)) return false;
    const n = NUMBER_WORDS.get(w);
    if (n !== undefined && !allowedNumbers.has(n)) return false;
  }

  // a capitalised word mid-sentence looks like a name or a label; it must come from the take
  const allowedCaps = new Set([...known, ...PROP_WORDS.keys(), 'i', 'director']);
  for (const m of rest.matchAll(/[A-Za-z]+/g)) {
    const w = m[0];
    if (w[0] !== w[0].toUpperCase()) continue;
    const before = rest.slice(0, m.index).trimEnd();
    const sentenceStart = before === '' || /[.?:;(]$/.test(before);
    if (sentenceStart) continue;
    if (!allowedCaps.has(w.toLowerCase())) return false;
  }
  return true;
}

/** Pull {"line": "..."} out of a model reply, forgiving code fences and stray text around the object. */
export function parseLine(text: string): string | null {
  if (typeof text !== 'string') return null;
  const body = text.replace(/```(?:json)?/gi, '').trim();
  const candidates = [body];
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(body.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const data = JSON.parse(c) as unknown;
      const line = data && typeof data === 'object' ? (data as { line?: unknown }).line : null;
      if (typeof line === 'string' && line.trim()) {
        let out = line.trim().replace(/\s+/g, ' ');
        // a line wrapped whole in quotes loses them
        const wrapped = /^["“]([^"“”]*)["”]$/.exec(out);
        if (wrapped) out = wrapped[1].trim();
        // straight quotes become the curly ones the rest of the game uses
        return out.replace(/"([^"]*)"/g, '“$1”');
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Ask the model for a line; anything wrong (bad JSON, a failed check, a throw, a slow answer) gives the rule line. */
export async function composeDirector(
  input: DirectorInput,
  call: (prompt: string) => Promise<ModelReply>,
  timeoutMs = 2200,
): Promise<DirectorResult> {
  const rules = (): DirectorResult => {
    try {
      return { line: ruleLine(input), source: 'rules' };
    } catch {
      return { line: 'Not a single cue, and yet a performance.', source: 'rules' };
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('director timeout')), timeoutMs);
    });
    const work = Promise.resolve().then(() => call(buildPrompt(input)));
    work.catch(() => undefined); // a late failure after the timeout must not surface as an unhandled rejection
    const reply = await Promise.race([work, timeout]);
    const text = typeof reply === 'string' ? reply : reply?.text;
    const model = typeof reply === 'string' ? undefined : reply?.model;
    const line = parseLine(text ?? '');
    if (line && validateLine(line, input)) return model ? { line, source: 'model', model } : { line, source: 'model' };
    return rules();
  } catch {
    return rules();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- request parsing -------------------------------------------------------------------------------

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v
    .replace(/[\u0000-\u001f\u007f“”"{}<>\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s && s.length <= max ? s : null;
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Check a request body field by field; null when anything is the wrong shape or too big. */
export function parseDirectorInput(body: unknown): DirectorInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const clipId = clean(b.clipId, 64);
  const title = clean(b.title, 120);
  const year = num(b.year);
  if (!clipId || !title || year === null || !Number.isInteger(year) || year < 1850 || year > 2100) return null;
  if (!Array.isArray(b.cues) || b.cues.length > 64 || !Array.isArray(b.events) || b.events.length > 400) return null;

  const cues: DirectorCue[] = [];
  for (const c of b.cues as unknown[]) {
    if (!c || typeof c !== 'object') return null;
    const r = c as Record<string, unknown>;
    const t = num(r.t);
    const prop = clean(r.prop, 24);
    const label = clean(r.label, 80);
    if (t === null || !prop || !label) return null;
    cues.push({ t, prop, label });
  }
  const events: DirectorEvent[] = [];
  for (const e of b.events as unknown[]) {
    if (!e || typeof e !== 'object') return null;
    const r = e as Record<string, unknown>;
    const t = num(r.t);
    const prop = clean(r.prop, 24);
    const kind = clean(r.kind, 24);
    const v = num(r.v);
    if (t === null || !prop || !kind || v === null) return null;
    events.push({ t, prop, kind, v });
  }

  const h = b.hits;
  if (!h || typeof h !== 'object') return null;
  const hr = h as Record<string, unknown>;
  const labels = new Set(cues.map((c) => c.label));
  const labelList = (v: unknown): string[] | null => {
    if (!Array.isArray(v) || v.length > 64) return null;
    const out: string[] = [];
    for (const x of v) {
      const s = clean(x, 80);
      if (!s) return null;
      if (labels.has(s)) out.push(s);
    }
    return out;
  };
  const mark = (v: unknown): DirectorMark | null | undefined => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object') return undefined;
    const r = v as Record<string, unknown>;
    const label = clean(r.label, 80);
    const offset = num(r.offset);
    if (!label || offset === null) return undefined;
    return labels.has(label) ? { label, offset } : null;
  };
  const hit = labelList(hr.hit);
  const missed = labelList(hr.missed);
  const best = mark(hr.best);
  const late = mark(hr.late);
  if (!hit || !missed || best === undefined || late === undefined) return null;
  return { clipId, title, year, cues, events, hits: { hit, missed, best, late } };
}

// ---- audio -----------------------------------------------------------------------------------------

/** Wrap raw 16-bit little-endian PCM in a WAV header so a browser can decodeAudioData it. */
export function wavFromPcm16(pcm: Uint8Array, sampleRate = 24000, channels = 1): ArrayBuffer {
  const out = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(out);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  const blockAlign = channels * 2;
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, pcm.byteLength, true);
  new Uint8Array(out, 44).set(pcm);
  return out;
}

/** Turn a model's inline audio into WAV bytes: WAV passes through, raw PCM (audio/L16, audio/pcm) gets a header. */
export function audioToWav(mimeType: string, bytes: Uint8Array): ArrayBuffer | null {
  const mt = (mimeType || '').toLowerCase();
  if (!bytes.byteLength) return null;
  if (mt.includes('wav')) {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return copy;
  }
  if (mt.includes('l16') || mt.includes('pcm')) {
    const rate = Number(/rate=(\d+)/.exec(mt)?.[1] ?? 24000);
    const channels = Number(/channels=(\d+)/.exec(mt)?.[1] ?? 1);
    return wavFromPcm16(bytes, rate > 0 ? rate : 24000, channels > 0 ? channels : 1);
  }
  return null;
}
