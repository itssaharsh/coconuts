// The serial: the theatre, its troupe and the reels in order. The foley system (or the dev page) feeds it sounds
// and time; it reports what the stage is waiting for and how each reel went. Reel one is written by hand; after
// every reel the player picks what happens next and the Director writes the next reel (a written one stands in
// whenever the Director is slow, wrong or away).
import type { PropId } from '../foley/types';
import { Mount, Troupe } from './cast';
import { CHAPTER_1 } from './chapter1';
import { type ReelAnswer, type ReelRequest, requestReel, type StoryLine } from './director';
import { assemble, checkPlan, type Pitch, PITCHES_2, type ReelPlan, WRITTEN } from './pieces';
import { ReelPlayer, type PlayerHooks, type ReelStats, type Sound, type Waiting } from './player';
import { type Reel, type SetInfo, type StageCue, validateReel } from './schema';
import { Theatre } from './theatre';

/** ready: a reel waits for the clapper. pitch: the player chooses what happens next. writing: the next reel is being written. */
export type SerialState = 'boot' | 'loading' | 'ready' | 'playing' | 'pitch' | 'writing';

const ROAD_MARK_NAMES = ['centre', 'left', 'right', 'wings_left', 'wings_right'];
const setInfo = (id: string, marks: string[]): SetInfo => ({ id, marks: Object.fromEntries(marks.map((m) => [m, [0, 0] as [number, number]])) });

/** A way on for every prop, for the reels the Director did not pitch. */
const STOCK_PITCH: Record<PropId, string> = {
  coconuts: 'Ride after the thief',
  thunder: 'A storm in the graveyard',
  bell: 'Ask at the inn',
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
}

export class Serial {
  readonly theatre: Theatre;
  readonly troupe: Troupe;
  readonly mount: Mount;
  readonly player: ReelPlayer;
  private reels: Reel[] = [...CHAPTER_1];
  private index = 0;
  state: SerialState = 'boot';
  last: ReelStats | null = null;
  /** What the finished reels were, for the Director. */
  private story: StoryLine[] = [];
  private pitches: Pitch[] = [];
  private nextPitches: Pitch[] | null = null;
  private usedProps: PropId[] = [];
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
    this.troupe = new Troupe(base);
    this.mount = new Mount(base);
    this.player = new ReelPlayer(this.theatre, this.troupe, this.mount, {
      onWaiting: (w) => this.hooks.onWaiting?.(w),
      onResult: (r, w, s) => this.hooks.onResult?.(r, w, s),
      onReelEnd: (stats) => {
        this.last = stats;
        this.story.push({ title: this.reel.title, wrote: stats.wrote.slice(0, 12), flags: stats.flags.slice(0, 12), cliffhanger: this.reel.cliffhanger });
        if (this.story.length > 4) this.story.shift();
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
        for (const [id, s] of Object.entries(cat.sets ?? {})) this.catalogue[id] = setInfo(id, [...(s.marks ?? []), 'door_side']);
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
    await this.prepare(0);
  }

  get reel(): Reel {
    return this.reels[this.index];
  }

  get reelNumber(): number {
    return this.index + 1;
  }

  async prepare(i: number): Promise<void> {
    this.index = Math.max(0, Math.min(this.reels.length - 1, i));
    this.setState('loading');
    this.theatre.hideCard();
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
    await this.prepare(this.index);
    await this.roll();
  }

  /** The clapper: roll the reel that is ready. */
  async roll(): Promise<void> {
    if (this.state !== 'ready') return;
    this.theatre.hideCard();
    this.player.start();
    this.setState('playing');
  }

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
    this.theatre.showChoice('What happens next?', this.pitches, 'Make its sound to choose');
    this.setState('pitch');
    console.log('PITCH', this.pitches.map((p) => `${p.prop}: ${p.text}`).join(' | '));
    this.hooks.onWaiting?.({ kind: 'open', prop: null, label: 'What happens next?', options: this.pitches.map((p) => p.prop) });
  }

  /** The player chose (by a prop, or in their own words): have the next reel written, then roll it. */
  async choose(pitch: { prop?: PropId; text: string; spoken?: boolean }): Promise<void> {
    if (this.state !== 'pitch') return;
    this.setState('writing');
    this.hooks.onWaiting?.(null);
    this.theatre.showCard(`“${pitch.text}”`, 'The Director is writing the next reel…');
    const number = this.reels.length + 1;
    console.log('PITCH chosen', pitch.prop ?? 'spoken', pitch.text);
    let answer: ReelAnswer | null = null;
    try {
      answer = await this.ask({ reel: number, pitch, story: this.story });
    } catch {
      answer = null;
    }
    const prop = pitch.prop ?? this.pitches[0]?.prop ?? 'coconuts';
    // the Director's plan if it checks, else the written reel for this prop (which always assembles)
    const reel = this.stage(answer?.plan, `reel-${number}`) ?? this.stage(WRITTEN[prop], `reel-${number}`) ?? assemble(WRITTEN[prop], `reel-${number}`);
    console.log('REEL written', reel.id, answer && reel.title === answer.plan.title ? answer.source : 'written', '|', reel.title);
    if (answer && reel.title === answer.plan.title) {
      this.nextPitches = answer.pitches.length === 3 ? answer.pitches : null;
      if (answer.note) this.hooks.onNote?.(answer.note, answer.source);
    }
    this.usedProps.push(prop);
    this.reels.push(reel);
    await this.prepare(this.reels.length - 1);
    await this.roll();
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
    this.player.update(dt);
    this.theatre.update(dt);
  }
}
