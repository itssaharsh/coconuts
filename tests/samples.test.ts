import { describe, expect, it } from 'vitest';
import { HIT_BANKS, pickTake } from '../src/foley/samples';

describe('pickTake', () => {
  it('never repeats the previous take and reaches every take', () => {
    for (const n of [2, 3, 5]) {
      const seen = new Set<number>();
      let last = -1;
      for (let k = 0; k < 500; k++) {
        const i = pickTake(n, last);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(n);
        if (last >= 0) expect(i).not.toBe(last);
        seen.add(i);
        last = i;
      }
      expect(seen.size).toBe(n);
    }
  });
  it('handles the extremes of the random source', () => {
    for (const r of [0, 0.999999]) for (let last = -1; last < 3; last++) {
      const i = pickTake(3, last, () => r);
      expect(i).toBeLessThan(3);
      if (last >= 0) expect(i).not.toBe(last);
    }
  });
  it('plays the only take', () => {
    expect(pickTake(1, 0)).toBe(0);
    expect(pickTake(0, -1)).toBe(0);
  });
});

describe('HIT_BANKS', () => {
  it('maps each hit kind to its recordings', () => {
    expect(HIT_BANKS).toEqual({
      clop: ['coconuts'], knock: ['door-knock'], slam: ['door-slam'], ding: ['bell'], crash: ['glass'],
      rumble: ['thunder-crack', 'thunder'], whistle: ['whistle-fall'],
    });
  });
});
