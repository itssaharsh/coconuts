// Smoke: the shipped data is whole. Every clip JSON parses with its film, poster and cues, and every demo take
// decodes back to itself through the share code, so the landing's first screen and /#take= links have what they need.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIP_IDS, parseClip, validateClip } from '../src/foley/clips';
import { decodeTake, encodeTake } from '../src/foley/recorder';
import type { Take } from '../src/foley/types';

const pub = join(__dirname, '..', 'public');

describe('shipped data', () => {
  for (const id of CLIP_IDS) {
    it(`clip ${id} is well formed and its files are in the repo`, () => {
      const raw = JSON.parse(readFileSync(join(pub, 'clips', `${id}.json`), 'utf8'));
      expect(validateClip(raw)).toEqual([]);
      const clip = parseClip(raw);
      expect(clip.cues.length).toBeGreaterThan(5);
      for (const f of [clip.film, clip.film.replace(/\.mp4$/, '.webm'), clip.poster]) {
        expect(() => readFileSync(join(pub, f))).not.toThrow();
      }
    });
  }

  it('every demo take survives the share code round trip', () => {
    const takes = readdirSync(join(pub, 'takes')).filter((f) => f.endsWith('-demo.json'));
    expect(takes.length).toBe(CLIP_IDS.length);
    for (const f of takes) {
      const take = JSON.parse(readFileSync(join(pub, 'takes', f), 'utf8')) as Take;
      const back = decodeTake(encodeTake(take));
      expect(back?.clipId).toBe(take.clipId);
      expect(back?.events.length).toBe(take.events.length);
      back?.events.forEach((e, i) => {
        expect(e.prop).toBe(take.events[i].prop);
        expect(e.kind).toBe(take.events[i].kind);
        expect(Math.abs(e.t - take.events[i].t)).toBeLessThan(0.011);
      });
    }
  });
});
