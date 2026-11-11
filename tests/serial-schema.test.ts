import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REEL_1 } from '../src/serial/chapter1';
import { type Beat, type CastEntry, type Reel, type SetInfo, validateReel } from '../src/serial/schema';

const SET_IDS = ['camp', 'gate', 'graveyard', 'hall', 'inn', 'vault'];
const ROAD_MARKS = ['centre', 'left', 'right', 'wings_left', 'wings_right'];

const info = (id: string, marks: string[]): SetInfo => ({ id, marks: Object.fromEntries(marks.map((m) => [m, [0, 0] as [number, number]])) });

/** The catalogue as Serial builds it: marks from each set file plus the derived `door_side`, and the three road sets. */
function catalogue(): Record<string, SetInfo> {
  const cat: Record<string, SetInfo> = {};
  for (const id of SET_IDS) {
    const json = JSON.parse(readFileSync(`public/serial/sets/${id}.json`, 'utf8')) as { marks: Record<string, [number, number]> };
    cat[id] = info(id, [...Object.keys(json.marks), 'door_side']);
  }
  for (const id of ['road', 'road-forest', 'road-village']) cat[id] = info(id, ROAD_MARKS);
  return cat;
}

const cat = catalogue();

const hero: CastEntry = { id: 'hero', char: 'knight' };
const ding = (label = 'Ring the bell'): Beat => ({ k: 'cue', prop: 'bell', label, hit: [] });

function reel(beats: Beat[], over: Partial<Reel> = {}): Reel {
  return { id: 't', title: 'T', set: 'gate', tint: 'blue', cast: [hero], beats, cliffhanger: 'To be continued', ...over };
}

/** A valid base: two cues. Extra beats go in front. */
const good = (...beats: Beat[]): Reel => reel([...beats, ding(), ding()]);

describe('validateReel', () => {
  it('accepts the hand-written REEL_1 against the real catalogue', () => {
    expect(validateReel(REEL_1, cat)).toEqual([]);
  });

  it('accepts the small base reel', () => {
    expect(validateReel(good(), cat)).toEqual([]);
  });

  it('rejects an unknown set', () => {
    expect(validateReel(good(), { ...cat, gate: undefined as unknown as SetInfo })).toContainEqual(expect.stringContaining('set gate is not in the catalogue'));
    expect(validateReel(good({ k: 'scene', set: 'nowhere' }), cat)).toContainEqual(expect.stringContaining('set nowhere is not in the catalogue'));
  });

  it('rejects an unknown mark', () => {
    const errs = validateReel(good({ k: 'move', who: 'hero', to: 'nowhere' }), cat);
    expect(errs).toContainEqual(expect.stringContaining('mark nowhere is not in set gate'));
  });

  it('rejects an actor that is not in the cast', () => {
    const errs = validateReel(good({ k: 'move', who: 'ghost', to: 'centre' }), cat);
    expect(errs).toContainEqual(expect.stringContaining('ghost is not in the cast'));
  });

  it('rejects an unknown verb', () => {
    const errs = validateReel(good({ k: 'do', who: 'hero', verb: 'moonwalk' as never }), cat);
    expect(errs).toContainEqual(expect.stringContaining('verb moonwalk unknown'));
  });

  it('rejects an intertitle over eight words', () => {
    const errs = validateReel(good({ k: 'title', text: 'one two three four five six seven eight nine' }), cat);
    expect(errs).toContainEqual(expect.stringContaining('an intertitle has one to eight words'));
    expect(validateReel(good({ k: 'title', text: 'one two three four five six seven eight' }), cat)).toEqual([]);
  });

  it('rejects a cue label over five words', () => {
    const errs = validateReel(reel([ding('one two three four five six'), ding()]), cat);
    expect(errs).toContainEqual(expect.stringContaining('a cue label has one to five words'));
  });

  it('rejects fewer than two moments that wait for a sound', () => {
    expect(validateReel(reel([ding()]), cat)).toContainEqual(expect.stringContaining('at least two moments'));
    expect(validateReel(reel([]), cat)).toContainEqual(expect.stringContaining('at least two moments'));
  });

  it('rejects more than five actors', () => {
    const cast = ['a', 'b', 'c', 'd', 'e', 'f'].map((id): CastEntry => ({ id, char: 'knight' }));
    expect(validateReel(reel([ding(), ding()], { cast }), cat)).toContainEqual(expect.stringContaining('more than five actors'));
  });

  it('rejects an unknown item, in a beat and in the cast', () => {
    expect(validateReel(good({ k: 'item', who: 'hero', item: 'banjo', hold: true }), cat)).toContainEqual(expect.stringContaining('item banjo unknown'));
    const withItem = reel([ding(), ding()], { cast: [{ ...hero, item: 'banjo' }] });
    expect(validateReel(withItem, cat)).toContainEqual(expect.stringContaining('item banjo unknown'));
  });

  it('rejects cue `times` out of range', () => {
    for (const times of [0, 7]) {
      const r = reel([{ k: 'cue', prop: 'door', label: 'Knock', times, hit: [] }, ding()]);
      expect(validateReel(r, cat), `times ${times}`).toContainEqual(expect.stringContaining('one to six times'));
    }
    const ok = reel([{ k: 'cue', prop: 'door', label: 'Knock', times: 6, hit: [] }, ding()]);
    expect(validateReel(ok, cat)).toEqual([]);
  });
});
