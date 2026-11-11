import { Group } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropId } from '../src/foley/types';
import type { Actor, Mount, Troupe } from '../src/serial/cast';
import { REEL_1 } from '../src/serial/chapter1';
import { ReelPlayer, type ReelStats, type Sound, type Waiting } from '../src/serial/player';
import type { Beat, CastEntry, Reel } from '../src/serial/schema';
import { type Task, wait } from '../src/serial/tasks';
import type { Theatre } from '../src/serial/theatre';

// ---- structural fakes: only what player.ts calls

class FakeActor {
  readonly root = new Group();
  onStage = false;
  isDown = false;
  readonly calls: string[] = [];
  constructor(
    readonly id: string,
    private secs: number,
  ) {}
  place(x: number, z: number): void {
    this.root.position.set(x, 0, z);
  }
  face(): void {}
  faceAudience(): void {
    this.calls.push('faceAudience');
  }
  goTo(x: number, z: number): Task {
    this.calls.push('goTo');
    const t = wait(this.secs);
    return {
      update: (dt) => {
        const d = t.update(dt);
        if (d) this.root.position.set(x, 0, z);
        return d;
      },
    };
  }
  perform(verb: string): Task {
    this.calls.push(`perform:${verb}`);
    return wait(this.secs);
  }
  async hold(): Promise<void> {}
  drop(): void {}
  pose(): void {}
  poseVerb(): void {}
  update(): void {}
}

class FakeTheatre {
  readonly stage = new Group();
  scroll = 0;
  onSound: ((cue: string) => void) | null = null;
  readonly sounds: string[] = [];
  readonly titles: string[] = [];
  readonly cues: { prop: PropId | null; label: string; pips: string }[] = [];
  readonly doors: [string, boolean][] = [];
  readonly emotes: [string, string][] = [];
  readonly curtains: boolean[] = [];
  lightnings = 0;
  constructor() {
    this.onSound = (cue) => this.sounds.push(cue);
  }
  soundWord(): void {}
  pulse(): void {}
  setTint(): void {}
  setColour(): void {}
  setSky(): void {}
  quake(): void {}
  preloadSet(): void {}
  grows: boolean[] = [];
  grow(big = true): void {
    this.grows.push(big);
  }
  lightning(): void {
    this.lightnings++;
  }
  async loadSet(): Promise<void> {}
  mark(): [number, number] {
    return [0, 0];
  }
  lookAt(): [number, number] {
    return [0, 0];
  }
  addActor(a: FakeActor): void {
    a.onStage = true;
  }
  removeActor(a: FakeActor): void {
    a.onStage = false;
  }
  curtain(open: boolean): Task {
    this.curtains.push(open);
    return wait(0.5);
  }
  title(text: string, sub = '', secs = 2.8): Task {
    this.titles.push(text);
    void sub;
    return wait(secs);
  }
  showCue(prop: PropId | null, label: string, pips = ''): void {
    this.cues.push({ prop, label, pips });
  }
  hideCue(): void {}
  setDoor(open: boolean): void {
    this.doors.push(['door', open]);
  }
  setDynamic(part: string, open: boolean): void {
    this.doors.push([part, open]);
  }
  emote(a: FakeActor, emote: string): void {
    this.emotes.push([a.id, emote]);
  }
}

class FakeMount {
  readonly root = new Group();
  readonly seat = new Group();
  readonly paces: number[] = [];
  lurches = 0;
  speed = 0;
  setPace(p: number): void {
    this.paces.push(p);
  }
  lurch(): void {
    this.lurches++;
  }
  update(): void {}
}

class FakeTroupe {
  readonly base = '';
  readonly failing = new Set<string>();
  readonly spawned: FakeActor[] = [];
  constructor(private secs: number) {}
  async preload(): Promise<void> {}
  async spawn(id: string): Promise<FakeActor> {
    if (this.failing.has(id)) throw new Error(`no model for ${id}`);
    const a = new FakeActor(id, this.secs);
    this.spawned.push(a);
    return a;
  }
}

interface Rig {
  player: ReelPlayer;
  theatre: FakeTheatre;
  mount: FakeMount;
  troupe: FakeTroupe;
  results: { result: string; prop: PropId | null; sound?: Sound }[];
  waits: (Waiting | null)[];
  ends: ReelStats[];
  time: number;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

function makeRig(opts: { actSecs?: number; failing?: string[] } = {}): Rig {
  const theatre = new FakeTheatre();
  const mount = new FakeMount();
  const troupe = new FakeTroupe(opts.actSecs ?? 0);
  for (const f of opts.failing ?? []) troupe.failing.add(f);
  const rig: Rig = { player: null as unknown as ReelPlayer, theatre, mount, troupe, results: [], waits: [], ends: [], time: 0 };
  rig.player = new ReelPlayer(theatre as unknown as Theatre, troupe as unknown as Troupe, mount as unknown as Mount, {
    onWaiting: (w) => rig.waits.push(w && { ...w }),
    onResult: (result, w, sound) => rig.results.push({ result, prop: w.prop, sound }),
    onReelEnd: (stats) => rig.ends.push(stats),
  });
  return rig;
}

const actor = (rig: Rig, id: string): FakeActor => {
  const a = rig.troupe.spawned.filter((x) => x.id === id).pop();
  if (!a) throw new Error(`no actor ${id}`);
  return a;
};

async function tick(rig: Rig, dt = 0.5): Promise<void> {
  rig.player.update(dt);
  rig.time += dt;
  await flush();
}

async function advance(rig: Rig, secs: number, dt = 0.5): Promise<void> {
  for (let t = 0; t < secs - 1e-9; t += dt) await tick(rig, dt);
}

async function until(rig: Rig, pred: () => boolean, max = 60, dt = 0.25): Promise<void> {
  for (let t = 0; t < max; t += dt) {
    if (pred()) return;
    await tick(rig, dt);
  }
  throw new Error(`condition not reached in ${max} simulated seconds`);
}

const play = (rig: Rig, prop: PropId): void => rig.player.sound({ prop, kind: 'test', v: 1 });

const HERO: CastEntry = { id: 'hero', char: 'knight', at: 'centre' };
const reelOf = (beats: Beat[], cast: CastEntry[] = [HERO]): Reel => ({ id: 'mini', title: 'Mini', set: 'gate', tint: 'blue', cast, beats, cliffhanger: 'Next time', });

/** Load and start a reel, then run to the first moment that waits (if `toWait`). */
async function boot(beats: Beat[], opts: { cast?: CastEntry[]; toWait?: boolean; rig?: Rig } = {}): Promise<Rig> {
  const rig = opts.rig ?? makeRig();
  await rig.player.load(reelOf(beats, opts.cast));
  rig.player.start();
  if (opts.toWait !== false) await until(rig, () => rig.player.waiting !== null);
  return rig;
}

const flag = (set: string): Beat => ({ k: 'flag', set });
const door = (over: Partial<Extract<Beat, { k: 'cue' }>> = {}): Beat => ({ k: 'cue', prop: 'door', label: 'Knock', who: 'hero', hit: [flag('hit')], miss: [flag('missed')], ...over });

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('cue', () => {
  it('is hit by its prop: the hit beats run and the stats count it', async () => {
    const rig = await boot([door()]);
    expect(rig.player.waiting).toMatchObject({ kind: 'cue', prop: 'door', label: 'Knock' });
    expect(rig.theatre.cues.at(-1)).toMatchObject({ prop: 'door', label: 'Knock' });
    play(rig, 'door');
    await tick(rig);
    expect(rig.player.flags.has('hit')).toBe(true);
    expect(rig.player.waiting).toBeNull();
    expect(rig.results.map((r) => r.result)).toEqual(['hit']);
    expect(rig.player.stats).toMatchObject({ asked: 1, hits: 1, wrong: 0, missed: 0, wrote: ['Knock'] });
  });

  it('with times: 3 needs three sounds, plays `each` every time and `hit` after the last', async () => {
    const rig = await boot([
      door({ times: 3, each: [{ k: 'emote', who: 'hero', emote: 'note' }], hit: [flag('opened')] }),
    ]);
    expect(rig.player.waiting).toMatchObject({ need: 3, got: 0 });
    play(rig, 'door');
    await advance(rig, 1.5);
    expect(rig.player.waiting).toMatchObject({ got: 1, need: 3 });
    expect(rig.theatre.cues.at(-1)?.pips).toBe('●○○');
    expect(rig.theatre.emotes.filter(([, e]) => e === 'note')).toHaveLength(1);
    expect(rig.player.flags.has('opened')).toBe(false);
    play(rig, 'door');
    play(rig, 'door');
    await advance(rig, 3);
    expect(rig.theatre.emotes.filter(([, e]) => e === 'note')).toHaveLength(3);
    expect(rig.player.flags.has('opened')).toBe(true);
    expect(rig.player.stats).toMatchObject({ asked: 1, hits: 1 });
    expect(rig.results).toHaveLength(1);
  });

  it('answers a wrong prop with a stock reaction and keeps waiting', async () => {
    const rig = await boot([door()]);
    play(rig, 'bell');
    await tick(rig);
    expect(rig.results.map((r) => r.result)).toEqual(['wrong']);
    expect(rig.theatre.emotes).toContainEqual(['hero', '!']);
    expect(rig.player.waiting).not.toBeNull();
    expect(rig.player.stats).toMatchObject({ wrong: 1, hits: 0 });
    await advance(rig, 1);
    play(rig, 'door');
    await tick(rig);
    expect(rig.player.stats).toMatchObject({ wrong: 1, hits: 1 });
    expect(rig.player.flags.has('hit')).toBe(true);
  });

  it('thunder as a wrong prop flashes lightning and the actors flinch', async () => {
    const rig = await boot([door()]);
    play(rig, 'thunder');
    await tick(rig);
    expect(rig.theatre.lightnings).toBe(1);
    expect(actor(rig, 'hero').calls).toContain('perform:flinch');
  });

  it('an authored wrong[prop] branch replaces the cue', async () => {
    const rig = await boot([
      door({ wrong: { thunder: [{ k: 'title', text: 'Thunder answers' }, flag('stormy')] } }),
      flag('after'),
    ]);
    play(rig, 'thunder');
    await advance(rig, 4);
    expect(rig.theatre.titles).toContain('Thunder answers');
    expect(rig.player.flags.has('stormy')).toBe(true);
    expect(rig.player.flags.has('after')).toBe(true);
    expect(rig.player.flags.has('hit')).toBe(false);
    expect(rig.player.waiting).toBeNull();
    expect(rig.player.stats).toMatchObject({ asked: 1, hits: 0, wrong: 1, wrote: ['thunder instead of door'] });
  });

  it('four wrong sounds end the cue as a miss', async () => {
    const rig = await boot([door({ miss: undefined })]);
    for (let i = 0; i < 4; i++) play(rig, 'coconuts');
    await advance(rig, 6);
    expect(rig.results.map((r) => r.result)).toEqual(['wrong', 'wrong', 'wrong', 'wrong', 'miss']);
    expect(rig.player.stats).toMatchObject({ wrong: 4, missed: 1, hits: 0 });
  });
});

describe('nudges and leniency', () => {
  it('nudges at 6 s and 12 s of silence, then runs the miss at the hold', async () => {
    const rig = await boot([door()]);
    await advance(rig, 5.5);
    expect(rig.player.waiting?.nudge).toBe(0);
    expect(rig.theatre.emotes.filter(([, e]) => e === '?')).toHaveLength(0);
    await advance(rig, 0.5);
    expect(rig.player.waiting?.nudge).toBe(1);
    expect(rig.theatre.emotes.filter(([, e]) => e === '?')).toHaveLength(1);
    expect(actor(rig, 'hero').calls).toContain('faceAudience');
    await advance(rig, 5.5);
    expect(rig.player.waiting?.nudge).toBe(1);
    await advance(rig, 0.5);
    expect(rig.player.waiting?.nudge).toBe(2);
    expect(rig.waits.filter((w) => w && w.nudge === 2)).not.toHaveLength(0);
    await advance(rig, 5.5);
    expect(rig.player.waiting?.nudge).toBe(2); // 17.5 s: still held
    await advance(rig, 0.5);
    expect(rig.player.waiting).toBeNull();
    expect(rig.results.map((r) => r.result)).toEqual(['miss']);
  });

  it('default hold: a wrong prop is only taken as the wanted one after two nudges', async () => {
    const rig = await boot([door()]);
    await advance(rig, 6); // one nudge
    play(rig, 'bell');
    await tick(rig);
    expect(rig.results.map((r) => r.result)).toEqual(['wrong']);
    await advance(rig, 13); // quiet restarts after every sound (and its reaction), so the second nudge is 12 s on
    expect(rig.player.waiting?.nudge).toBe(2);
    play(rig, 'bell');
    await tick(rig);
    expect(rig.results.map((r) => r.result)).toEqual(['wrong', 'hit']);
    expect(rig.results[1].sound?.prop).toBe('bell');
    expect(rig.player.flags.has('hit')).toBe(true);
  });

  it('short hold (<= 10): one nudge is enough', async () => {
    const rig = await boot([door({ hold: 9 })]);
    await advance(rig, 3);
    play(rig, 'bell');
    await tick(rig);
    expect(rig.results.map((r) => r.result)).toEqual(['wrong']);
    await advance(rig, 7); // quiet restarts after the wrong sound's reaction
    expect(rig.player.waiting?.nudge).toBe(1);
    play(rig, 'whistle');
    await tick(rig);
    expect(rig.results.map((r) => r.result)).toEqual(['wrong', 'hit']);
    expect(rig.player.stats.hits).toBe(1);
  });

  it('leniency never swallows a prop that has an authored wrong branch', async () => {
    const rig = await boot([door({ hold: 9, wrong: { bell: [flag('belled')] } })]);
    await advance(rig, 6);
    play(rig, 'bell');
    await tick(rig);
    expect(rig.player.flags.has('belled')).toBe(true);
    expect(rig.player.flags.has('hit')).toBe(false);
    expect(rig.player.stats).toMatchObject({ hits: 0, wrong: 1 });
  });
});

describe('a cue nobody plays', () => {
  it('runs the miss beats after `hold` seconds', async () => {
    const rig = await boot([door({ hold: 4 })]);
    await advance(rig, 3.5);
    expect(rig.player.waiting).not.toBeNull();
    await advance(rig, 0.5);
    expect(rig.player.flags.has('missed')).toBe(true);
    expect(rig.player.flags.has('hit')).toBe(false);
    expect(rig.player.stats).toMatchObject({ asked: 1, hits: 0, missed: 1, wrote: [] });
    expect(rig.results.map((r) => r.result)).toEqual(['miss']);
  });

  it('with no miss authored runs the hit beats but still counts a miss', async () => {
    const rig = await boot([door({ hold: 4, miss: undefined })]);
    await advance(rig, 4.5);
    expect(rig.player.flags.has('hit')).toBe(true);
    expect(rig.player.stats).toMatchObject({ asked: 1, hits: 0, missed: 1 });
    expect(rig.results.map((r) => r.result)).toEqual(['miss']);
  });
});

describe('ride', () => {
  const ride = (over: Partial<Extract<Beat, { k: 'ride' }>> = {}): Beat => ({
    k: 'ride', who: 'hero', label: 'Clop', need: 3, secs: 4, hit: [flag('rode')], miss: [flag('walked')], ...over,
  });
  const MOUNTED: CastEntry[] = [{ id: 'hero', char: 'knight', at: 'centre', mounted: true }];

  it('is a hit when the clops reach `need`', async () => {
    const rig = await boot([ride()], { cast: MOUNTED });
    expect(rig.player.waiting).toMatchObject({ kind: 'ride', prop: 'coconuts' });
    expect(rig.theatre.sounds).toContain('whinny');
    play(rig, 'coconuts');
    play(rig, 'coconuts');
    await tick(rig, 0.1);
    expect(rig.player.waiting?.progress).toBeCloseTo(2 / 3);
    play(rig, 'coconuts');
    await advance(rig, 1);
    expect(rig.player.flags.has('rode')).toBe(true);
    expect(rig.results.map((r) => r.result)).toEqual(['hit']);
    expect(rig.mount.paces.at(-1)).toBe(0);
    expect(rig.player.stats).toMatchObject({ asked: 1, hits: 1, wrote: ['Clop'] });
  });

  it('pace follows tempo: faster clops give a higher pace', async () => {
    const rig = await boot([ride({ need: 40, secs: 30 })], { cast: MOUNTED });
    play(rig, 'coconuts');
    await tick(rig, 0.1);
    const slow = rig.mount.paces.at(-1)!;
    expect(slow).toBeGreaterThan(0);
    for (let i = 0; i < 6; i++) play(rig, 'coconuts');
    await tick(rig, 0.1);
    const fast = rig.mount.paces.at(-1)!;
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBeLessThanOrEqual(1);
  });

  it('lurches (and boings) when the clops stop after moving, not before', async () => {
    const rig = await boot([ride({ need: 40, secs: 30 })], { cast: MOUNTED });
    await advance(rig, 2);
    expect(rig.mount.lurches).toBe(0);
    play(rig, 'coconuts');
    await tick(rig, 0.1);
    expect(rig.mount.lurches).toBe(0);
    await advance(rig, 1.5);
    expect(rig.mount.lurches).toBe(1);
    expect(rig.theatre.sounds).toContain('boing');
    expect(rig.theatre.emotes).toContainEqual(['hero', '!']);
    await advance(rig, 2);
    expect(rig.mount.lurches).toBe(1);
  });

  it('`secs` of silence is a miss', async () => {
    const rig = await boot([ride()], { cast: MOUNTED });
    await advance(rig, 3.5);
    expect(rig.player.waiting).not.toBeNull();
    await advance(rig, 1);
    expect(rig.player.flags.has('walked')).toBe(true);
    expect(rig.player.flags.has('rode')).toBe(false);
    expect(rig.results.map((r) => r.result)).toEqual(['miss']);
    expect(rig.player.stats.missed).toBe(1);
  });
});

describe('open moment', () => {
  const open = (over: Partial<Extract<Beat, { k: 'open' }>> = {}): Beat => ({
    k: 'open',
    prompt: 'What wakes him',
    hold: 5,
    branches: {
      bell: { title: 'A bell rings', flag: 'hungry', beats: [flag('bell_beat')] },
      thunder: { title: 'Thunder rolls', flag: 'scared', beats: [flag('thunder_beat')] },
    },
    miss: [flag('slept')],
    ...over,
  });

  it('the prop played picks its branch, sets its flag and shows its title', async () => {
    const rig = await boot([open()]);
    expect(rig.player.waiting).toMatchObject({ kind: 'open', prop: null, options: ['bell', 'thunder'] });
    play(rig, 'thunder');
    await advance(rig, 4);
    expect(rig.theatre.titles).toContain('Thunder rolls');
    expect(rig.player.flags.has('scared')).toBe(true);
    expect(rig.player.flags.has('thunder_beat')).toBe(true);
    expect(rig.player.flags.has('bell_beat')).toBe(false);
    expect(rig.player.flags.has('slept')).toBe(false);
    expect(rig.results.map((r) => r.result)).toEqual(['hit']);
    expect(rig.player.stats).toMatchObject({ asked: 1, hits: 1, wrote: ['Thunder rolls'] });
  });

  it('a prop with no branch gets a stock reaction and the stage keeps waiting', async () => {
    const rig = await boot([open()]);
    play(rig, 'door');
    await tick(rig);
    expect(rig.player.waiting).not.toBeNull();
    expect(rig.results).toEqual([]);
  });

  it('no sound runs the miss beats', async () => {
    const rig = await boot([open()]);
    await advance(rig, 5.5);
    expect(rig.player.flags.has('slept')).toBe(true);
    expect(rig.results.map((r) => r.result)).toEqual(['miss']);
    expect(rig.player.stats).toMatchObject({ asked: 1, hits: 0, missed: 1 });
  });
});

describe('sounds nobody waits for', () => {
  it('before the reel plays they are only heard', async () => {
    const rig = makeRig();
    await rig.player.load(reelOf([door(), door()]));
    play(rig, 'bell');
    rig.player.update(0.1);
    expect(rig.results).toEqual([]);
    expect(rig.player.stats).toMatchObject({ asked: 0, hits: 0, wrong: 0, missed: 0 });
  });

  it('while the story is not waiting they get a stock reaction but are not counted', async () => {
    const rig = await boot([door()], { toWait: false });
    play(rig, 'thunder');
    play(rig, 'coconuts');
    await tick(rig, 0.1);
    await tick(rig, 0.1);
    expect(rig.theatre.lightnings).toBe(1); // the first sound was answered, the rest dropped
    expect(rig.player.stats).toMatchObject({ asked: 0, hits: 0, wrong: 0, missed: 0 });
    expect(rig.results).toEqual([]);
    // and they do not leak into the cue that comes next
    await until(rig, () => rig.player.waiting !== null);
    await advance(rig, 1);
    expect(rig.results).toEqual([]);
  });

  it('a paused player ignores them', async () => {
    const rig = await boot([door()]);
    rig.player.paused = true;
    play(rig, 'door');
    rig.player.paused = false;
    await tick(rig);
    expect(rig.results).toEqual([]);
  });
});

describe('whole reels', () => {
  /** Answer every WAIT with the wanted prop (bell for open moments). */
  async function run(rig: Rig, answer: boolean, max = 400, dt = 0.25): Promise<void> {
    while (rig.player.playing) {
      if (rig.time > max) throw new Error(`reel did not end in ${max} simulated seconds`);
      const w = rig.player.waiting;
      if (answer && w) play(rig, w.prop ?? 'bell');
      await tick(rig, dt);
    }
  }

  async function start(rig: Rig, reel: Reel): Promise<void> {
    await rig.player.load(reel);
    rig.player.start();
  }

  it('REEL_1 with a scripted player reaches the end with every cue hit', async () => {
    const rig = makeRig({ actSecs: 0.3 });
    await start(rig, REEL_1);
    await run(rig, true);
    expect(rig.player.playing).toBe(false);
    expect(rig.ends).toHaveLength(1);
    expect(rig.ends[0]).toBe(rig.player.stats);
    const s = rig.player.stats;
    expect(s.asked).toBeGreaterThan(0);
    expect(s.hits).toBe(s.asked);
    expect(s.missed).toBe(0);
    expect(s.flags).toContain('thief_hungry'); // the open moment was answered with the bell
    expect(rig.theatre.sounds).toContain('applause');
    expect(rig.theatre.titles).toContain('To be continued');
    expect(rig.theatre.curtains.at(-1)).toBe(false);
  });

  it('REEL_1 with no input also ends, in bounded time, with no hits', async () => {
    const rig = makeRig({ actSecs: 0.3 });
    await start(rig, REEL_1);
    await run(rig, false);
    expect(rig.player.playing).toBe(false);
    expect(rig.time).toBeLessThan(400);
    expect(rig.ends).toHaveLength(1);
    const s = rig.player.stats;
    expect(s.hits).toBe(0);
    expect(s.missed).toBe(s.asked);
    expect(s.asked).toBeGreaterThan(0);
    expect(s.flags).toEqual([]);
  });

  it('a character that fails to load is skipped: the curtain still opens and the reel still ends', async () => {
    const rig = makeRig({ failing: ['ghost'] });
    const cast: CastEntry[] = [HERO, { id: 'ghost', char: 'mage', at: 'left' }];
    const reel = reelOf(
      [
        { k: 'enter', who: 'ghost', from: 'left', to: 'centre' },
        { k: 'do', who: 'ghost', verb: 'cheer' },
        door({ hold: 3 }),
        { k: 'scene', set: 'vault', cast },
        door({ hold: 3 }),
      ],
      cast,
    );
    await start(rig, reel);
    expect(rig.player.actor('ghost')).toBeUndefined();
    expect(rig.player.actor('hero')).toBeDefined();
    await run(rig, true);
    expect(rig.player.actor('ghost')).toBeUndefined();
    expect(rig.theatre.curtains.filter((o) => o).length).toBeGreaterThanOrEqual(2); // opening and after the scene change
    expect(rig.ends).toHaveLength(1);
    expect(rig.player.stats).toMatchObject({ asked: 2, hits: 2 });
  });
});
