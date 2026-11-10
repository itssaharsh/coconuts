// Cue matching: a hit lands a cue when it is the right prop inside the cue's window; each cue lands once.
import type { HitEvent, PropId } from './types';

export interface Cue {
  /** Seconds into the clip. */
  t: number;
  prop: PropId;
  /** What happens on screen, two to four words. */
  label: string;
  /** Seconds of grace before and after `t`. */
  window: [number, number];
}

export interface CueState {
  cue: Cue;
  hit: boolean;
  /** How far from the cue time the landing hit was, seconds (signed). */
  offset: number | null;
}

export class CueTracker {
  readonly states: CueState[];

  constructor(cues: Cue[]) {
    this.states = [...cues].sort((a, b) => a.t - b.t).map((cue) => ({ cue, hit: false, offset: null }));
  }

  reset(): void {
    for (const s of this.states) {
      s.hit = false;
      s.offset = null;
    }
  }

  /** Returns the cue this hit lands, if any (the nearest open cue of that prop whose window contains the hit). */
  register(hit: HitEvent): CueState | null {
    let best: CueState | null = null;
    for (const s of this.states) {
      if (s.hit || s.cue.prop !== hit.prop) continue;
      const [before, after] = s.cue.window;
      if (hit.t < s.cue.t - before || hit.t > s.cue.t + after) continue;
      if (!best || Math.abs(hit.t - s.cue.t) < Math.abs(hit.t - best.cue.t)) best = s;
    }
    if (best) {
      best.hit = true;
      best.offset = hit.t - best.cue.t;
    }
    return best;
  }

  get hits(): number {
    return this.states.filter((s) => s.hit).length;
  }

  get total(): number {
    return this.states.length;
  }

  /** The cues within a look-ahead window, for the lane. */
  upcoming(now: number, ahead = 6, behind = 1.5): CueState[] {
    return this.states.filter((s) => s.cue.t >= now - behind && s.cue.t <= now + ahead);
  }

  /** A short sentence for the result card. */
  summary(): string {
    return `${this.hits} of ${this.total} cues hit`;
  }

  /** The best-timed hit and the latest one, for the Director. */
  highlights(): { best: CueState | null; late: CueState | null; missed: CueState[] } {
    const landed = this.states.filter((s) => s.hit && s.offset !== null);
    const best = landed.reduce<CueState | null>((a, s) => (!a || Math.abs(s.offset!) < Math.abs(a.offset!) ? s : a), null);
    const late = landed.reduce<CueState | null>((a, s) => (s.offset! > 0.25 && (!a || s.offset! > a.offset!) ? s : a), null);
    return { best, late, missed: this.states.filter((s) => !s.hit) };
  }
}
