// The serial: the theatre, its troupe and the reels in order. The foley system (or the dev page) feeds it sounds
// and time; it reports what the stage is waiting for and how each reel went.
import type { PropId } from '../foley/types';
import { Mount, Troupe } from './cast';
import { CHAPTER_1 } from './chapter1';
import { ReelPlayer, type PlayerHooks, type ReelStats, type Sound, type Waiting } from './player';
import { type Reel, type SetInfo, type StageCue, validateReel } from './schema';
import { Theatre } from './theatre';

export type SerialState = 'boot' | 'loading' | 'ready' | 'playing' | 'between';

const ROAD_MARK_NAMES = ['centre', 'left', 'right', 'wings_left', 'wings_right'];
const setInfo = (id: string, marks: string[]): SetInfo => ({ id, marks: Object.fromEntries(marks.map((m) => [m, [0, 0] as [number, number]])) });

export interface SerialHooks extends PlayerHooks {
  onState?: (s: SerialState) => void;
  /** The stage's own sounds, for whoever owns the audio. */
  onStage?: (cue: StageCue) => void;
}

export class Serial {
  readonly theatre: Theatre;
  readonly troupe: Troupe;
  readonly mount: Mount;
  readonly player: ReelPlayer;
  private reels: Reel[] = CHAPTER_1;
  private index = 0;
  state: SerialState = 'boot';
  last: ReelStats | null = null;
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
        this.setState('between');
        this.hooks.onReelEnd?.(stats);
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
      soft('chapter', this.loadChapter('chapter1')),
    ]);
    await this.prepare(0);
  }

  /** The authored chapter replaces the draft when it is there and valid. */
  private async loadChapter(name: string): Promise<void> {
    try {
      const res = await fetch(`${this.base}reels/${name}.json`);
      if (!res.ok) return;
      const list = (await res.json()) as Reel[];
      if (Array.isArray(list) && list.length) this.reels = list;
    } catch {
      // the draft stays
    }
  }

  get reel(): Reel {
    return this.reels[this.index];
  }

  get reelNumber(): number {
    return this.index + 1;
  }

  async prepare(i: number): Promise<void> {
    this.index = ((i % this.reels.length) + this.reels.length) % this.reels.length;
    this.setState('loading');
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

  /** The clapper: roll the reel that is ready, or move on to the next one. */
  async roll(): Promise<void> {
    if (this.state === 'between') await this.prepare(this.index + 1);
    if (this.state !== 'ready') return;
    this.player.start();
    this.setState('playing');
  }

  togglePause(): boolean {
    this.player.paused = !this.player.paused;
    return this.player.paused;
  }

  sound(prop: PropId, kind: string, v: number): void {
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
