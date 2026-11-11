import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROP_IDS } from '../src/foley/types';
import { assemble, checkPlan, PITCHES_2, type ReelPlan, SET_IDS, WRITTEN } from '../src/serial/pieces';
import { DERIVED_MARKS, type SetInfo, validateReel } from '../src/serial/schema';

/** The set catalogue the way the Serial builds it: mark names from the set files, plus the roads. */
function catalogue(): Record<string, SetInfo> {
  const out: Record<string, SetInfo> = {};
  const info = (id: string, marks: string[]): SetInfo => ({ id, marks: Object.fromEntries(marks.map((m) => [m, [0, 0] as [number, number]])) });
  for (const f of readdirSync('public/serial/sets').filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(`public/serial/sets/${f}`, 'utf8')) as { marks: Record<string, unknown> };
    out[f.replace('.json', '')] = info(f.replace('.json', ''), [...Object.keys(j.marks), ...DERIVED_MARKS]);
  }
  for (const r of ['road', 'road-forest', 'road-village']) out[r] = info(r, ['centre', 'left', 'right', 'wings_left', 'wings_right', ...DERIVED_MARKS]);
  return out;
}

describe('pieces', () => {
  const sets = catalogue();

  it('knows every set that is on disk', () => {
    for (const id of SET_IDS) expect(sets[id], id).toBeDefined();
  });

  it('has a written reel for every prop, and each one stages', () => {
    for (const prop of PROP_IDS) {
      const plan = WRITTEN[prop];
      expect(checkPlan(plan), prop).toEqual([]);
      const reel = assemble(plan, `written-${prop}`);
      expect(validateReel(reel, sets), prop).toEqual([]);
    }
  });

  it('offers three pitches after reel one, each on its own prop with a written reel behind it', () => {
    expect(PITCHES_2).toHaveLength(3);
    expect(new Set(PITCHES_2.map((p) => p.prop)).size).toBe(3);
    for (const p of PITCHES_2) expect(WRITTEN[p.prop]).toBeDefined();
  });

  it('stages a wolf chase and a monster, and keeps place names for places', () => {
    const plan: ReelPlan = {
      title: 'Teeth and Legs',
      scenes: [
        { set: 'road-forest', cast: [{ id: 'knight', char: 'knight' }], pieces: [{ piece: 'ride', who: 'knight', wolves: true, clops: 12 }] },
        { set: 'graveyard', cast: [{ id: 'knight', char: 'knight' }, { id: 'sage', char: 'mage' }], pieces: [{ piece: 'arrive', who: 'sage' }, { piece: 'boss', hero: 'knight', beast: 'spider' }] },
      ],
      cliffhanger: 'It was only the small one.',
    };
    expect(checkPlan(plan)).toEqual([]);
    const reel = assemble(plan, 'beasts');
    expect(validateReel(reel, sets)).toEqual([]);
    // the pack runs in the ride, the monster is in the second scene's cast
    const ride = reel.beats.find((b) => b.k === 'ride');
    expect(ride && ride.k === 'ride' ? ride.pursuers : []).toEqual(['wolf_a', 'wolf_b']);
    expect(reel.cast.map((c) => c.char)).toContain('wolf');
    const scene = reel.beats.find((b) => b.k === 'scene');
    expect(scene && scene.k === 'scene' ? scene.cast?.map((c) => c.id) : []).toContain('monster');
    // an actor may not take a place's name, or the monster's
    for (const id of ['door', 'left', 'centre', 'lair', 'monster']) {
      const bad = JSON.parse(JSON.stringify(plan)) as ReelPlan;
      bad.scenes[1].cast[1].id = id;
      (bad.scenes[1].pieces[0] as { who: string }).who = id;
      expect(checkPlan(bad), id).not.toEqual([]);
    }
  });

  it('rejects what a model might get wrong', () => {
    const good = WRITTEN.thunder;
    const bad = (change: (p: ReelPlan) => void): string[] => {
      const p = JSON.parse(JSON.stringify(good)) as ReelPlan;
      change(p);
      return checkPlan(p);
    };
    expect(checkPlan(null)).not.toEqual([]);
    expect(checkPlan({})).not.toEqual([]);
    expect(bad((p) => (p.title = 'A title that runs on for far too many words'))).not.toEqual([]);
    expect(bad((p) => ((p.scenes[0] as { set: string }).set = 'moon'))).not.toEqual([]);
    expect(bad((p) => ((p.scenes[0].cast[0] as { char: string }).char = 'dragon'))).not.toEqual([]);
    expect(bad((p) => p.scenes[0].pieces.push({ piece: 'knock', who: 'knight', opener: 'bones' }))).not.toEqual([]); // no door in a graveyard
    expect(bad((p) => (p.scenes[0].pieces = [{ piece: 'card', line: 'Nothing happens.' }]))).not.toEqual([]); // nothing to play
    expect(bad((p) => p.scenes[0].pieces.push({ piece: 'duel', a: 'knight', b: 'nobody' }))).not.toEqual([]);
    expect(bad((p) => ((p.scenes[0].pieces[0] as { piece: string }).piece = 'explode'))).not.toEqual([]);
    expect(() => assemble({ ...good, scenes: [] }, 'x')).toThrow();
  });
});
