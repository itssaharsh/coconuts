// A take is the list of hits you made while the film played; it encodes into a short share code.
import { PROP_IDS, type HitEvent, type HitKind, type Take } from './types';

const KINDS: HitKind[] = ['clop', 'knock', 'slam', 'ding', 'rumble', 'whistle', 'crash'];
const HANDS = ['right', 'left', 'gaze'] as const;

export class Recorder {
  private take: Take | null = null;

  start(clipId: string, startedAt = new Date().toISOString()): void {
    this.take = { clipId, events: [], startedAt };
  }

  add(hit: HitEvent): void {
    if (!this.take) return;
    this.take.events.push({ ...hit, t: Math.round(hit.t * 100) / 100 });
  }

  stop(): Take | null {
    const t = this.take;
    this.take = null;
    return t;
  }

  get open(): boolean {
    return this.take !== null;
  }

  get count(): number {
    return this.take?.events.length ?? 0;
  }
}

/** Compact, URL-safe: clip id, then 4 bytes per event (time in 10 ms steps as 2 bytes, prop|kind, hand|strength). */
export function encodeTake(take: Take): string {
  const bytes = new Uint8Array(take.events.length * 4);
  take.events.forEach((e, i) => {
    const t = Math.max(0, Math.min(65535, Math.round(e.t * 100)));
    bytes[i * 4] = t >> 8;
    bytes[i * 4 + 1] = t & 255;
    bytes[i * 4 + 2] = (PROP_IDS.indexOf(e.prop) << 4) | KINDS.indexOf(e.kind);
    bytes[i * 4 + 3] = ((e.hand ? HANDS.indexOf(e.hand) + 1 : 0) << 5) | Math.round(Math.max(0, Math.min(1, e.v)) * 31);
  });
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${take.clipId}.${b64}`;
}

export function decodeTake(code: string): Take | null {
  const dot = code.indexOf('.');
  if (dot <= 0) return null;
  const clipId = code.slice(0, dot);
  let b64 = code.slice(dot + 1).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length % 4 !== 0) return null;
  const events: HitEvent[] = [];
  for (let i = 0; i < bin.length; i += 4) {
    const t = ((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1)) / 100;
    const pk = bin.charCodeAt(i + 2);
    const hs = bin.charCodeAt(i + 3);
    const prop = PROP_IDS[pk >> 4];
    const kind = KINDS[pk & 15];
    if (!prop || !kind) return null;
    const handIdx = hs >> 5;
    events.push({ t, prop, kind, v: (hs & 31) / 31, hand: handIdx ? HANDS[handIdx - 1] : undefined });
  }
  return { clipId, events, startedAt: '' };
}
