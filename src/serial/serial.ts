// The serial: the theatre, its troupe and the reels in order. The foley system (or the dev page) feeds it sounds
// and time; it reports what the stage is waiting for and how each reel went. Reel one is written by hand; after
// every reel the player picks what happens next and the Director writes the next reel (a written one stands in
// whenever the Director is slow, wrong or away).
import type { PropId } from '../foley/types';
import { type Actor, Mount, Troupe } from './cast';
import { CHAPTER_1 } from './chapter1';
import { type ReelAnswer, type ReelRequest, requestReel, type StoryLine, warmDirector } from './director';
import { assemble, checkPlan, type Pitch, PITCHES_2, type ReelPlan, WRITTEN, WRITTEN_MORE } from './pieces';
import { ReelPlayer, type PlayerHooks, type ReelStats, type Sound, type Waiting } from './player';
import { DERIVED_MARKS, type Reel, type SetInfo, type StageCue, validateReel } from './schema';
import { Theatre } from './theatre';

/** ready: a reel waits for the clapper. pitch: the player chooses what happens next. writing: the next reel is being written. */
export type SerialState = 'boot' | 'loading' | 'ready' | 'playing' | 'pitch' | 'writing';

const ROAD_MARK_NAMES = ['centre', 'left', 'right', 'wings_left', 'wings_right', ...DERIVED_MARKS];
const setInfo = (id: string, marks: string[]): SetInfo => ({ id, marks: Object.fromEntries(marks.map((m) => [m, [0, 0] as [number, number]])) });

/** Where the serial keeps its place between visits: how many reels this player has seen and what happened in them. */
const SAVE_KEY = 'coconuts.serial';
interface Saved {
  v: 1;
  done: number;
  story: StoryLine[];
  used: PropId[];
  pitches: Pitch[] | null;
}

function readSave(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Saved | null;
    return s && s.v === 1 && s.done >= 1 && Array.isArray(s.story) && s.story.length ? s : null;
  } catch {
    return null;
  }
}

/** A way on for every prop, for the reels the Director did not pitch. */
const STOCK_PITCH: Record<PropId, string> = {
  coconuts: 'Ride after the thief',
  thunder: 'A storm in the graveyard',
  bell: 'Ask at the market',
  door: 'Knock at the Duke’s hall',
  whistle: 'Whistle for a friend',
  glass: 'Break into the vault',
};

export interface SerialHooks extends PlayerHooks {
  onState?: (s: SerialState) => void;
  /** The stage's own sounds, for whoever owns the audio. */
  onStage?: (cue: StageCue) => void;
  /** The Director's remark on the reel just written. */
  onNote?: (note: string, source: string) => void;
  /** The theatre bursts to wall size (or comes back to the desk). */
  onScale?: (big: boolean) => void;
}

export class Serial {
  readonly theatre: Theatre;
  readonly troupe: Troupe;
  /** An actor who left the picture last reel and is about to climb back into it. */
  private returning: Actor | null = null;
  readonly mount: Mount;
  readonly player: ReelPlayer;
  private reels: Reel[] = [...CHAPTER_1];
  private index = 0;
  state: SerialState = 'boot';
  last: ReelStats | null = null;
  /** What the finished reels were, for the Director. */
  private story: StoryLine[] = [];
  private pitches: Pitch[] = [];
  /** The line under the pitches (whoever owns a microphone adds how to speak a pitch instead). */
  pitchFooter = 'Make its sound to choose';
  private nextPitches: Pitch[] | null = null;
  private usedProps: PropId[] = [];
  /** Reels this player has finished, over every visit; the next reel's number is one more. */
  private done = 0;
  /** A returning player: the clapper goes on with the story instead of playing reel one again. */
  resuming = false;
  /** How the Director is asked; replaced in tests and on the dev page. */
  ask: (req: ReelRequest) => Promise<ReelAnswer | null> = (req) => requestReel(req);
  /** Every set a reel may ask for, with the names of its marks (for checking reels before they play). */
  readonly catalogue: Record<string, SetInfo> = {
    road: setInfo('road', ROAD_MARK_NAMES),
    'road-forest': setInfo('road-forest', ROAD_MARK_NAMES),
    'road-village': setInfo('road-village', ROAD_MARK_NAMES),
  };

  /** `base` is the folder that holds chars/, sets/, anims.glb, horse.glb and reels/. */
  constructor(
    private base: string,
    private frameUrl: string,
    private hooks: SerialHooks = {},
  ) {
    this.theatre = new Theatre(base);
    this.theatre.onSound = (cue) => this.hooks.onStage?.(cue);
    this.theatre.onScale = (big) => this.hooks.onScale?.(big);
    this.troupe = new Troupe(base);
    this.mount = new Mount(base);
    this.player = new ReelPlayer(this.theatre, this.troupe, this.mount, {
      onWaiting: (w) => this.hooks.onWaiting?.(w),
      onResult: (r, w, s) => this.hooks.onResult?.(r, w, s),
      onReelEnd: (stats) => {
        this.last = stats;
        this.story.push({ title: this.reel.title, wrote: stats.wrote.slice(0, 12), did: stats.did.slice(0, 12), flags: stats.flags.slice(0, 12), cliffhanger: this.reel.cliffhanger });
        if (this.story.length > 4) this.story.shift();
        this.done++;
        this.hooks.onReelEnd?.(stats);
        this.offerPitches();
      },
    });
  }

  private setState(s: SerialState): void {
    this.state = s;
    console.log('SERIAL', s, this.reels[this.index]?.id ?? '');
    this.hooks.onState?.(s);
  }

  async init(): Promise<void> {
    this.setState('loading');
    let seat: [number, number, number] | undefined;
    try {
      const res = await fetch(`${this.base}catalog.json`);
      if (res.ok) {
        const cat = (await res.json()) as { horse?: { riderSeat?: { position?: [number, number, number] } }; sets?: Record<string, { marks?: string[] }> };
        seat = cat.horse?.riderSeat?.position;
        for (const [id, s] of Object.entries(cat.sets ?? {})) this.catalogue[id] = setInfo(id, [...(s.marks ?? []), ...DERIVED_MARKS]);
      }
    } catch {
      // the mount's own default
    }
    const soft = (what: string, p: Promise<unknown>) => p.catch((e) => console.warn('SERIAL', what, 'failed', e instanceof Error ? e.message : e));
    await Promise.all([
      // the intertitles' face; a card drawn before it arrives would keep the fallback serif
      soft('font', typeof document !== 'undefined' && document.fonts ? Promise.race([document.fonts.load('64px Limelight'), new Promise((r) => setTimeout(r, 2500))]) : Promise.resolve()),
      soft('frame', this.theatre.init(this.frameUrl)),
      soft('clips', this.troupe.load()),
      soft('horse', this.mount.load(seat)),
    ]);
    const saved = readSave();
    if (saved) {
      this.story = saved.story.slice(-4);
      this.usedProps = saved.used ?? [];
      this.nextPitches = saved.pitches?.length === 3 ? saved.pitches : null;
      this.done = saved.done;
      this.resuming = true;
      console.log('SERIAL resuming after reel', saved.done);
    }
    await this.prepare(0);
  }

  /** The cliffhanger the last visit ended on, for the marquee. */
  get previously(): string {
    return this.story[this.story.length - 1]?.cliffhanger ?? '';
  }

  private save(): void {
    try {
      const s: Saved = { v: 1, done: this.done, story: this.story, used: this.usedProps.slice(-6), pitches: this.pitches.length === 3 ? this.pitches : null };
      localStorage.setItem(SAVE_KEY, JSON.stringify(s));
    } catch {
      // no storage: the serial simply starts from reel one next time
    }
  }

  /** Forget the story so far and play reel one. */
  async startOver(): Promise<void> {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      // nothing was saved
    }
    this.resuming = false;
    this.story = [];
    this.usedProps = [];
    this.nextPitches = null;
    this.done = 0;
    this.reels = [...CHAPTER_1];
    await this.prepare(0);
    await this.roll();
  }

  get reel(): Reel {
    return this.reels[this.index];
  }

  /** The number of the reel on the stage, counted over every visit. */
  get reelNumber(): number {
    return this.state === 'pitch' || this.state === 'writing' ? this.done : this.done + 1;
  }

  async prepare(i: number): Promise<void> {
    this.index = Math.max(0, Math.min(this.reels.length - 1, i));
    this.setState('loading');
    this.theatre.hideCard();
    this.theatre.grow(false); // every reel starts as the toy on the desk, so its thunder can burst it open again
    try {
      await this.player.load(this.reel);
      const errs = validateReel(this.reel, { ...this.catalogue, [this.theatre.set.id]: this.theatre.set });
      if (errs.length) console.warn('REEL check', this.reel.id, errs.slice(0, 4).join(' | '));
    } catch (e) {
      // a reel that will not load still rolls: its titles and whatever did load play, and the story goes on
      console.warn('SERIAL prepare failed', this.reel.id, e instanceof Error ? e.message : e);
    }
    this.setState('ready');
  }

  /** Start the current reel again from its title. */
  async restart(): Promise<void> {
    if (this.state === 'pitch') {
      // the reel had ended: it is played again, not counted twice
      this.done = Math.max(0, this.done - 1);
      this.story.pop();
    }
    await this.prepare(this.index);
    await this.roll();
  }

  /** The clapper: roll the reel that is ready (a returning player goes straight to what happens next). */
  async roll(): Promise<void> {
    if (this.state !== 'ready') return;
    if (this.resuming) {
      this.resuming = false;
      this.offerPitches();
      return;
    }
    this.theatre.hideCard();
    this.warm();
    const back = this.returning;
    this.returning = null;
    if (back) this.player.adopt('(returning)', back); // not a name a plan can use: it is animated and cleared with the cast
    this.player.start(back ? () => this.theatre.climbBack(back) : undefined);
    this.setState('playing');
  }

  /** Overridable in tests and on the dev page: by default the Director is told a reel has started. */
  warm: () => void = warmDirector;

  togglePause(): boolean {
    this.player.paused = !this.player.paused;
    return this.player.paused;
  }

  // ---- between reels

  /** The reel is over: ask what happens next. Three ways on, each chosen by sounding its prop. */
  private offerPitches(): void {
    const fresh = (Object.keys(STOCK_PITCH) as PropId[]).filter((p) => !this.usedProps.slice(-3).includes(p));
    this.pitches = this.nextPitches ?? (this.story.length <= 1 ? PITCHES_2 : fresh.slice(0, 3).map((prop) => ({ prop, text: STOCK_PITCH[prop] })));
    this.nextPitches = null;
    this.theatre.showChoice('What happens next?', this.pitches, this.pitchFooter);
    this.save();
    this.setState('pitch');
    console.log('PITCH', this.pitches.map((p) => `${p.prop}: ${p.text}`).join(' | '));
    this.hooks.onWaiting?.({ kind: 'open', prop: null, label: 'What happens next?', options: this.pitches.map((p) => p.prop) });
  }

  /** The pitches on offer right now. */
  get offer(): Pitch[] {
    return this.pitches;
  }

  /** Change the line under the pitches while they are up (listening, not heard). */
  pitchNote(footer: string): void {
    if (this.state === 'pitch') this.theatre.showChoice('What happens next?', this.pitches, footer);
  }

  /** The player chose (by a prop, or in their own words): have the next reel written, then roll it. */
  async choose(pitch: { prop?: PropId; text: string; spoken?: boolean }): Promise<void> {
    if (this.state !== 'pitch') return;
    this.setState('writing');
    this.hooks.onWaiting?.(null);
    this.theatre.showCard(`“${pitch.text}”`, 'The Director is writing the next reel…');
    const number = this.done + 1;
    console.log('PITCH chosen', pitch.prop ?? 'spoken', pitch.text);
    let answer: ReelAnswer | null = null;
    try {
      answer = await this.realTime(this.ask({ reel: number, pitch, story: this.story }));
    } catch {
      answer = null;
    }
    const prop = pitch.prop ?? this.pitches[0]?.prop ?? 'coconuts';
    // the Director's plan if it checks, else the written reel for this prop (which always assembles)
    // (a prop pitched a second time gets its second written reel, where there is one)
    const again = this.usedProps.filter((p) => p === prop).length % 2 === 1;
    const written = (again && WRITTEN_MORE[prop]) || WRITTEN[prop];
    const reel = this.stage(answer?.plan, `reel-${number}`) ?? this.stage(written, `reel-${number}`) ?? assemble(written, `reel-${number}`);
    console.log('REEL written', reel.id, answer && reel.title === answer.plan.title ? answer.source : 'written', '|', reel.title);
    if (answer && reel.title === answer.plan.title) {
      this.nextPitches = answer.pitches.length === 3 ? answer.pitches : null;
      if (answer.note) this.hooks.onNote?.(answer.note, answer.source);
    }
    this.usedProps.push(prop);
    this.reels.push(reel);
    await this.prepare(this.reels.length - 1);
    // whoever went over the edge of the desk last reel climbs back into the picture before this one
    if (this.story[this.story.length - 1]?.flags.includes('thief_out') && this.theatre.hasDesk) {
      this.returning = await this.troupe.spawn('returning', 'rogue_hooded').catch(() => null);
    }
    const note = answer && reel.title === answer.plan.title ? answer.note : '';
    if (note && (this.state as SerialState) === 'ready') {
      // the Director's line to the player, on the stage's own card (where it can be read), before the reel rolls;
      // the clapper rolls it at once for anyone who will not wait
      this.theatre.showCard('From the Director', note);
      await this.pause(4);
    }
    await this.roll();
  }

  /** The show's own clock: seconds of `update` time. */
  private clock = 0;
  /**
   * A filmed run draws the show slower than the wall clock, so an answer that took four real seconds would flash by
   * in the film. When this is set, a wait on the network lasts as long in the show as it really took.
   */
  filmed = false;

  /** Await `work`; in a filmed run, then wait out in the show's time whatever it took in real time. */
  async realTime<T>(work: Promise<T>): Promise<T> {
    if (!this.filmed) return work;
    const wall = performance.now();
    const show = this.clock;
    try {
      return await work;
    } finally {
      const owed = (performance.now() - wall) / 1000 - (this.clock - show);
      if (owed > 0.05) await this.pause(owed);
    }
  }

  private pauses: { left: number; done: () => void }[] = [];
  /** A wait in the show's own time (no timers: a stepped or captured show waits just as long). */
  private pause(secs: number): Promise<void> {
    return new Promise((done) => this.pauses.push({ left: secs, done }));
  }

  /** Put a plan's reel on the stage, ready for the clapper (the dev page and tests look at single reels this way). */
  async preview(plan: ReelPlan): Promise<boolean> {
    const reel = this.stage(plan, `reel-${this.reels.length + 1}`);
    if (!reel) return false;
    this.reels.push(reel);
    await this.prepare(this.reels.length - 1);
    return true;
  }

  /** A plan made into a reel, or null when it does not check against the pieces or the sets. */
  private stage(plan: ReelPlan | undefined, id: string): Reel | null {
    if (!plan || checkPlan(plan).length) return null;
    try {
      const reel = assemble(plan, id);
      // (without the catalogue of sets there is nothing to check marks against: the pieces only use marks every set has)
      const errs = Object.keys(this.catalogue).length > 3 ? validateReel(reel, this.catalogue) : [];
      if (errs.length) {
        console.warn('REEL rejected', id, errs.slice(0, 3).join(' | '));
        return null;
      }
      return reel;
    } catch (e) {
      console.warn('REEL rejected', id, e instanceof Error ? e.message : e);
      return null;
    }
  }

  sound(prop: PropId, kind: string, v: number): void {
    if (this.state === 'pitch') {
      this.theatre.pulse();
      const pitch = this.pitches.find((p) => p.prop === prop);
      if (pitch) void this.choose(pitch);
      return;
    }
    const s: Sound = { prop, kind, v };
    this.player.sound(s);
  }

  get waiting(): Waiting | null {
    return this.player.waiting;
  }

  update(dt: number): void {
    this.clock += dt;
    this.player.update(dt);
    this.theatre.update(dt);
    for (let i = this.pauses.length - 1; i >= 0; i--) {
      const p = this.pauses[i];
      if ((p.left -= dt) <= 0) {
        this.pauses.splice(i, 1);
        p.done();
      }
    }
  }
}
