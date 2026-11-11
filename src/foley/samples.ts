// Pure helpers for the recorded samples: which bank a hit draws from, and which take to play.
import type { HitKind } from './types';

export type StageSound = 'curtain' | 'creak' | 'whinny' | 'clang' | 'applause' | 'clap' | 'boing' | 'step' | 'thud';

/** Manifest keys a hit kind may draw from, best first (the first one that has a decoded take wins). */
export const HIT_BANKS: Record<HitKind, string[]> = {
  clop: ['coconuts'],
  knock: ['door-knock'],
  slam: ['door-slam'],
  ding: ['bell'],
  crash: ['glass'],
  rumble: ['thunder-crack', 'thunder'],
  whistle: ['whistle-fall'],
};

/** Index of the take to play: never `last` again when there are two or more, and every take comes up in time. */
export function pickTake(count: number, last: number, rand: () => number = Math.random): number {
  if (count <= 1) return 0;
  const skip = last >= 0 && last < count ? 1 : 0;
  const i = Math.min(count - 1 - skip, Math.floor(rand() * (count - skip)));
  return skip && i >= last ? i + 1 : i;
}
