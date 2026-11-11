// The reel player: turns a reel's beats into tasks on the stage and listens for the foley table.
// Every moment that needs a sound WAITS for it, so the player's sound visibly causes the action.
import type { PropId } from '../foley/types';
import { type Actor, type Mount, type Troupe } from './cast';
import type { Beat, CastEntry, Reel, Verb } from './schema';
import { call, done, parallel, sequence, type Task, wait } from './tasks';
import type { Theatre } from './theatre';

export interface Sound {
  prop: PropId;
  kind: string;
  v: number;
}

export interface Waiting {
  kind: 'cue' | 'ride' | 'open';
  /** The prop the scene wants; null when any prop will do. */
  prop: PropId | null;
  label: string;
  /** For open moments: the props that have a branch. */
  options?: PropId[];
  /** Ride progress 0..1. */
  progress?: number;
  /** A cue that wants its sound several times: how many, and how many have come. */
  need?: number;
  got?: number;
  /** How long the stage has been kept waiting: 0, then 1 and 2 as it asks again. */
  nudge?: number;
}

export interface ReelStats {
  reel: string;
  asked: number;
  hits: number;
  wrong: number;
  missed: number;
  /** What the player's sounds did, in order: the "your sounds wrote this" strip. */
  wrote: string[];
  flags: string[];
}

export interface PlayerHooks {
  /** A moment that waits for a sound began or ended. */
  onWaiting?: (w: Waiting | null) => void;
  onResult?: (result: 'hit' | 'wrong' | 'miss', w: Waiting, sound?: Sound) => void;
  onReelEnd?: (stats: ReelStats) => void;
}

// Nothing on the stage happens until the sound is made, so the stage waits a long time: it asks again twice,
// and only then goes on without the player (an authored `miss`).
const CUE_HOLD = 18; // seconds of silence a cue waits by default
const OPEN_HOLD = 22;
const NUDGE_AT = [6, 12];
/** Verbs the stage gives a sound of its own: steel on steel, a body on the boards. */
const CLANGS = new Set<Verb>(['chop', 'slash', 'stab']);
const THUDS = new Set<Verb>(['fall', 'faint', 'collapse']);

export class ReelPlayer {
  private actors = new Map<string, Actor>();
  private mounted: Actor | null = null;
  private root: Task | null = null;
  private pending: Sound[] = [];
  private waitingNow: Waiting | null = null;
  private side: Task[] = []; // stock reactions that play alongside the story
  private snorers = new Set<Actor>();
  private snore = 0;
  private reel: Reel | null = null;
  readonly flags = new Set<string>();
  stats: ReelStats = { reel: '', asked: 0, hits: 0, wrong: 0, missed: 0, wrote: [], flags: [] };
  playing = false;
  paused = false;

  constructor(
    private theatre: Theatre,
    private troupe: Troupe,
    private mount: Mount | null,
    private hooks: PlayerHooks = {},
  ) {}

  get waiting(): Waiting | null {
    return this.waitingNow;
  }

  actor(id: string): Actor | undefined {
    return this.actors.get(id);
  }

  /** Build the set and the cast behind the closed curtain. */
  async load(reel: Reel): Promise<void> {
    this.reel = reel;
    this.playing = false;
    this.root = null;
    this.pending.length = 0;
    this.setWaiting(null);
    this.stats = { reel: reel.id, asked: 0, hits: 0, wrong: 0, missed: 0, wrote: [], flags: [] };
    await this.troupe.preload(reel.cast.map((c) => c.char));
    await this.changeScene(reel.set, reel.cast);
    // the reel's later scenes are fetched while the first one plays, so a scene change is a curtain, not a wait
    const later = (beats: Beat[]): void => {
      for (const b of beats) {
        if (b.k === 'scene') {
          this.theatre.preloadSet(b.set);
          void this.troupe.preload((b.cast ?? []).map((c) => c.char));
        } else if (b.k === 'par') later(b.beats);
        else if (b.k === 'cue') {
          later(b.hit);
          later(b.miss ?? []);
          for (const list of Object.values(b.wrong ?? {})) later(list ?? []);
        } else if (b.k === 'ride') {
          later(b.hit);
          later(b.miss);
        } else if (b.k === 'open') {
          for (const br of Object.values(b.branches)) later(br?.beats ?? []);
          later(b.miss);
        }
      }
    };
    later(reel.beats);
    this.theatre.setTint(reel.tint);
    this.theatre.setColour(0);
    console.log('REEL loaded', reel.id, reel.cast.length, 'actors');
  }

  private async changeScene(set: string, cast: CastEntry[]): Promise<void> {
    for (const a of this.actors.values()) this.theatre.removeActor(a);
    this.actors.clear();
    this.snorers.clear();
    if (this.mount && this.mounted) this.mount.seat.remove(this.mounted.root);
    this.mounted = null;
    if (this.mount) this.theatre.stage.remove(this.mount.root);
    await this.theatre.loadSet(set);
    for (const c of cast) {
      let a: Actor;
      try {
        a = await this.troupe.spawn(c.id, c.char);
      } catch (e) {
        // the scene plays without this actor; beats that name them do nothing
        console.warn('CAST failed', c.id, c.char, e instanceof Error ? e.message : e);
        continue;
      }
      this.actors.set(c.id, a);
      for (const item of c.items ?? (c.item ? [c.item] : [])) await a.hold(this.troupe.base, item);
      if (c.mounted && this.mount) {
        const [x, z] = this.theatre.mark(c.at ?? 'centre');
        this.mount.root.position.set(x, 0, z);
        this.mount.root.rotation.y = Math.PI / 2; // in profile, heading to the audience's right
        this.mount.setPace(0);
        this.theatre.stage.add(this.mount.root);
        this.mount.seat.add(a.root);
        a.place(0, 0, 0);
        a.pose('Sit_Chair_Idle');
        this.mounted = a;
        a.onStage = true;
      } else if (c.at) {
        const [x, z] = this.theatre.mark(c.at);
        a.place(x, z, 0);
        if (c.pose) a.poseVerb(c.pose);
        if (c.zzz) this.snorers.add(a);
        this.theatre.addActor(a);
      }
    }
  }

  start(): void {
    if (!this.reel) return;
    const reel = this.reel;
    this.playing = true;
    this.paused = false;
    this.root = sequence([
      () => this.theatre.title(reel.title, '', 2.4),
      () => this.theatre.curtain(true),
      () => this.run(reel.beats),
      () => call(() => this.theatre.onSound?.('applause')),
      () => wait(0.6),
      () => this.theatre.title('To be continued', reel.cliffhanger, 3.4),
      () => this.theatre.curtain(false),
      () =>
        call(() => {
          this.playing = false;
          this.stats.flags = [...this.flags];
          console.log('REEL end', reel.id, `${this.stats.hits}/${this.stats.asked}`, 'wrong', this.stats.wrong, 'missed', this.stats.missed, '|', this.stats.wrote.join(' > '));
          this.hooks.onReelEnd?.(this.stats);
        }),
    ]);
    console.log('REEL start', reel.id);
  }

  /** A sound from the foley table. */
  sound(s: Sound): void {
    this.theatre.soundWord(s.prop, s.kind);
    this.theatre.pulse();
    if (this.playing && !this.paused) this.pending.push(s);
  }

  private setWaiting(w: Waiting | null): void {
    this.waitingNow = w;
    if (w) {
      const pips = w.need && w.need > 1 ? '●'.repeat(w.got ?? 0) + '○'.repeat(w.need - (w.got ?? 0)) : '';
      this.theatre.showCue(w.prop, w.label, pips);
      console.log('WAIT', w.kind, w.prop ?? 'any', `${w.got ?? 0}/${w.need ?? 1}`, w.label);
    } else this.theatre.hideCue();
    this.hooks.onWaiting?.(w);
  }

  /** The stage asks again: whoever is waiting looks out at the audience. */
  private nudge(w: Waiting, who?: string): void {
    w.nudge = (w.nudge ?? 0) + 1;
    const a = (who && this.actors.get(who)) || [...this.actors.values()].find((x) => x.onStage && !x.isDown && x !== this.mounted);
    if (a) {
      a.faceAudience();
      this.theatre.emote(a, '?');
    }
    console.log('NUDGE', w.nudge, w.label);
    this.hooks.onWaiting?.(w);
  }

  private resolve(result: 'hit' | 'wrong' | 'miss', w: Waiting, sound?: Sound): void {
    if (result === 'hit') this.stats.hits++;
    else if (result === 'wrong') this.stats.wrong++;
    else this.stats.missed++;
    const total = Math.max(1, this.stats.asked);
    // five landed cues restore the print; a reel that goes badly fades a little
    this.theatre.setColour(Math.max(0, Math.min(1, (this.stats.hits - 0.5 * this.stats.missed) / Math.min(5, Math.max(3, total)))));
    console.log('CUE', result, w.kind, w.prop ?? 'any', w.label, sound ? `<- ${sound.prop}` : '');
    this.hooks.onResult?.(result, w, sound);
  }

  // ---- beats

  private pos(markOrActor: string): [number, number] {
    const a = this.actors.get(markOrActor);
    if (a) return [a.root.position.x, a.root.position.z];
    return this.theatre.mark(markOrActor);
  }

  private wing(side: string): [number, number] {
    return this.theatre.mark(side === 'left' ? 'wings_left' : side === 'right' ? 'wings_right' : side);
  }

  /** Turn an actor toward a mark, another actor, or a side of the house. */
  private turn(a: Actor, toward: string | undefined): void {
    const p = a.root.position;
    if (!toward || toward === 'audience') a.faceAudience();
    else if (toward === 'upstage') a.face(p.x, p.z - 10);
    else if (toward === 'left') a.face(p.x - 10, p.z);
    else if (toward === 'right') a.face(p.x + 10, p.z);
    else if (this.actors.has(toward)) a.face(...this.pos(toward));
    else a.face(...this.theatre.lookAt(toward));
  }

  run(beats: Beat[]): Task {
    return sequence(beats.map((b) => () => this.beat(b)));
  }

  private beat(b: Beat): Task {
    switch (b.k) {
      case 'title':
        return this.theatre.title(b.text, b.sub ?? '', b.secs ?? 2.6);
      case 'wait':
        return wait(b.secs);
      case 'enter': {
        const a = this.actors.get(b.who);
        if (!a) return done;
        return sequence([
          () =>
            call(() => {
              const [x, z] = this.wing(b.from);
              a.place(x, b.from === 'door' ? z - 1.5 : z, 0);
              if (b.from === 'door') this.theatre.setDoor(true);
              this.theatre.addActor(a);
            }),
          () => a.goTo(...this.pos(b.to), b.gait ?? 'walk'),
          () => call(() => this.turn(a, b.face)),
        ]);
      }
      case 'move': {
        const a = this.actors.get(b.who);
        if (!a) return done;
        const target = this.pos(b.to);
        // stop a step short of another actor
        const other = this.actors.get(b.to);
        if (other) target[0] += target[0] > a.root.position.x ? -1.5 : 1.5;
        return sequence([() => a.goTo(target[0], target[1], b.gait ?? 'walk'), () => call(() => this.turn(a, b.face ?? (other ? b.to : undefined)))]);
      }
      case 'exit': {
        const a = this.actors.get(b.who);
        if (!a) return done;
        const [x, z] = this.wing(b.to);
        const through = b.to === 'door' || b.to === 'window';
        return sequence([
          () => a.goTo(x, through ? z - 1.4 : z, b.gait ?? 'walk'),
          () => call(() => this.theatre.removeActor(a)),
        ]);
      }
      case 'do': {
        const a = this.actors.get(b.who);
        if (!a) return done;
        if (b.face) this.turn(a, b.face);
        if (CLANGS.has(b.verb)) this.side.push(sequence([() => wait(0.3), () => call(() => this.theatre.onSound?.('clang'))]));
        else if (THUDS.has(b.verb)) this.side.push(sequence([() => wait(0.45), () => call(() => this.theatre.onSound?.('thud'))]));
        return a.perform(b.verb, b.secs);
      }
      case 'emote': {
        const a = this.actors.get(b.who);
        return a ? call(() => this.theatre.emote(a, b.emote)) : done;
      }
      case 'door':
        return sequence([() => call(() => this.theatre.setDynamic(b.part ?? 'door', b.open, b.toward)), () => wait(0.35)]);
      case 'item': {
        const a = this.actors.get(b.who);
        if (!a) return done;
        return call(() => (b.hold ? void a.hold(this.troupe.base, b.item) : a.drop(b.item)));
      }
      case 'fx':
        return call(() => {
          if (b.fx === 'lightning') this.theatre.lightning();
          else if (b.fx === 'shake') this.theatre.quake();
          else if (b.fx === 'dark') this.theatre.setSky('storm');
          else if (b.fx === 'light') this.theatre.setSky('day');
          else if (b.fx === 'grow') this.theatre.grow(true);
          else if (b.fx === 'shrink') this.theatre.grow(false);
        });
      case 'tint':
        return call(() => this.theatre.setTint(b.tint));
      case 'par':
        return parallel(b.beats.map((x) => this.beat(x)));
      case 'flag':
        return call(() => this.flags.add(b.set));
      case 'scene':
        return this.sceneTask(b.set, b.tint, b.cast);
      case 'cue':
        return this.cueTask(b);
      case 'ride':
        return this.rideTask(b);
      case 'open':
        return this.openTask(b);
    }
  }

  private sceneTask(set: string, tint: Reel['tint'] | undefined, cast: CastEntry[] | undefined): Task {
    let loaded = false;
    return sequence([
      () => this.theatre.iris(false),
      () => {
        this.changeScene(set, cast ?? this.reel?.cast ?? [])
          .catch((e) => console.warn('SCENE failed', set, e instanceof Error ? e.message : e))
          .then(() => {
            if (tint) this.theatre.setTint(tint);
            loaded = true;
          });
        return { update: () => loaded };
      },
      () => wait(0.25),
      () => this.theatre.iris(true),
    ]);
  }

  /** What the stage does when a sound arrives that the story did not ask for. */
  private stock(s: Sound): Task {
    const list = [...this.actors.values()].filter((a) => a.onStage && !a.isDown && a !== this.mounted);
    const any = list[Math.floor(Math.random() * Math.max(1, list.length))];
    switch (s.prop) {
      case 'thunder':
        this.theatre.lightning();
        return parallel(list.map((a) => a.perform('flinch')));
      case 'bell':
        for (const a of list) this.theatre.emote(a, '!');
        return wait(0.5);
      case 'glass':
        if (any) this.theatre.emote(any, '!');
        return any ? any.perform('jump') : done;
      case 'whistle':
        if (any) this.theatre.emote(any, 'note');
        return wait(0.4);
      case 'door':
        for (const a of list) a.face(...this.theatre.mark('door'));
        if (any) this.theatre.emote(any, '?');
        return sequence([() => wait(0.8), () => call(() => list.forEach((a) => a.faceAudience()))]);
      case 'coconuts':
      default:
        if (any) this.theatre.emote(any, '?');
        return wait(0.3);
    }
  }

  private cueTask(b: Extract<Beat, { k: 'cue' }>): Task {
    const times = Math.max(1, b.times ?? 1);
    const w: Waiting = { kind: 'cue', prop: b.prop, label: b.label, need: times, got: 0, nudge: 0 };
    let phase: 'start' | 'waiting' | 'reacting' | 'resolved' = 'start';
    const hold = b.hold ?? CUE_HOLD;
    let quiet = 0;
    let inner: Task | null = null;
    let wrongs = 0;
    return {
      update: (dt) => {
        if (phase === 'start') {
          this.stats.asked++;
          this.pending.length = 0;
          this.setWaiting(w);
          phase = 'waiting';
        }
        if (phase === 'reacting') {
          if (inner!.update(dt)) phase = 'waiting';
          return false;
        }
        if (phase === 'resolved') return inner!.update(dt);
        // waiting
        const s = this.pending.shift();
        if (s) {
          quiet = 0;
          // a stage that has asked twice (or once, on a short cue) takes any sound as the one it wanted
          const lenient = (w.nudge ?? 0) >= (hold <= 10 ? 1 : 2);
          if (s.prop === b.prop || (lenient && !b.wrong?.[s.prop])) {
            if (s.prop !== b.prop) console.log('CUE lenient', b.prop, '<-', s.prop);
            w.got = (w.got ?? 0) + 1;
            if (w.got >= times) {
              this.setWaiting(null);
              this.resolve('hit', w, s);
              this.stats.wrote.push(b.label);
              inner = b.each ? sequence([() => this.run(b.each!), () => this.run(b.hit)]) : this.run(b.hit);
              phase = 'resolved';
              return inner.update(0);
            }
            // one of several: the stage answers this one and waits for the next
            this.setWaiting(w);
            inner = b.each ? this.run(b.each) : wait(0.12);
            phase = 'reacting';
            return false;
          }
          wrongs++;
          this.resolve('wrong', w, s);
          const own = b.wrong?.[s.prop];
          if (own) {
            // the wrong sound has its own turn in the story: it replaces the cue
            this.setWaiting(null);
            this.stats.wrote.push(`${s.prop} instead of ${b.prop}`);
            inner = this.run(own);
            phase = 'resolved';
            return inner.update(0);
          }
          inner = this.stock(s);
          phase = 'reacting';
          return false;
        }
        quiet += dt;
        if ((w.nudge ?? 0) < NUDGE_AT.length && quiet >= NUDGE_AT[w.nudge ?? 0]) this.nudge(w, b.who);
        if (quiet >= hold || wrongs >= 4) {
          this.setWaiting(null);
          this.resolve('miss', w);
          inner = this.run(b.miss ?? b.hit);
          phase = 'resolved';
          return inner.update(0);
        }
        return false;
      },
    };
  }

  /** The rider goes as fast as the hooves come: no clops, no horse. `secs` is how much silence the ride forgives. */
  private rideTask(b: Extract<Beat, { k: 'ride' }>): Task {
    const w: Waiting = { kind: 'ride', prop: 'coconuts', label: b.label, progress: 0, nudge: 0 };
    let started = false;
    let silence = 0;
    let quiet = 0;
    let clops = 0;
    const recent: number[] = []; // ages of the last clops, seconds
    let moving = false;
    let inner: Task | null = null;
    // the pack: beasts that run after the horse. They fall back at a gallop and gain when the hooves slow;
    // when they catch up one of them nips, the horse starts, and they drop back a little: a scare, never a fail.
    const pack = (b.pursuers ?? []).map((id) => this.actors.get(id)).filter((a): a is Actor => !!a);
    let gap = 5.2;
    let nipped = 9;
    const [hx, hz] = this.mount ? [this.mount.root.position.x, this.mount.root.position.z] : [0, 1.3];
    const run = (ended: boolean, dt: number): void => {
      nipped += dt;
      const pace = this.mount?.speed ?? 0;
      gap = ended ? gap + dt * 4.5 : Math.max(1.7, Math.min(8.2, gap + (pace - 0.5) * 2.4 * dt));
      pack.forEach((a, i) => a.root.position.set(hx - gap - i * 1.35, 0, hz + (i % 2 ? 0.95 : -0.75)));
      if (!ended && gap <= 1.72 && nipped > 2.4 && pack[0]) {
        nipped = 0;
        gap = 2.7;
        pack[0].play('chop');
        this.side.push(sequence([() => wait(0.5), () => call(() => pack[0].play('run'))]));
        this.mount?.lurch();
        this.theatre.onSound?.('boing');
        if (this.mounted) this.theatre.emote(this.mounted, '!');
      }
    };
    return {
      update: (dt) => {
        if (inner) {
          run(true, dt);
          const over = inner.update(dt);
          if (over) for (const a of pack) this.theatre.removeActor(a);
          return over;
        }
        if (!started) {
          started = true;
          this.stats.asked++;
          this.pending.length = 0;
          this.setWaiting(w);
          this.theatre.onSound?.('whinny');
          for (const a of pack) {
            a.place(hx - gap, hz, Math.PI / 2);
            a.play('run');
            this.theatre.addActor(a);
          }
        }
        run(false, dt);
        for (let i = recent.length - 1; i >= 0; i--) if ((recent[i] += dt) > 1.2) recent.splice(i, 1);
        let s: Sound | undefined;
        while ((s = this.pending.shift())) {
          if (s.prop === 'coconuts' || (w.nudge ?? 0) >= 2) {
            // (a rider kept waiting long enough goes on any sound)
            clops++;
            recent.push(0);
            quiet = 0;
          } else this.side.push(this.stock(s));
        }
        // tempo sets the gait: a slow pat is a walk, a quick rattle a gallop
        const last = recent.length ? Math.min(...recent) : 9;
        const pace = last < 1.0 ? Math.min(1, 0.22 + recent.length / 1.2 / 5.5) : 0;
        this.mount?.setPace(pace);
        if (pace > 0) moving = true;
        else if (moving) {
          // the hooves stopped: so does the horse, and the rider nearly goes over its neck
          moving = false;
          this.mount?.lurch();
          this.theatre.onSound?.('boing');
          if (this.mounted) this.theatre.emote(this.mounted, '!');
        }
        w.progress = Math.min(1, clops / b.need);
        if (clops >= b.need) {
          this.setWaiting(null);
          this.resolve('hit', w);
          this.stats.wrote.push(b.label);
          this.mount?.setPace(0);
          inner = this.run(b.hit);
          return false;
        }
        if (pace === 0) {
          silence += dt;
          quiet += dt;
          if ((w.nudge ?? 0) < NUDGE_AT.length && quiet >= NUDGE_AT[w.nudge ?? 0]) this.nudge(w, b.who);
        }
        if (silence >= b.secs) {
          this.setWaiting(null);
          this.resolve('miss', w);
          this.mount?.setPace(0);
          inner = this.run(b.miss);
        }
        return false;
      },
    };
  }

  private openTask(b: Extract<Beat, { k: 'open' }>): Task {
    const options = Object.keys(b.branches) as PropId[];
    const w: Waiting = { kind: 'open', prop: null, label: b.prompt, options, nudge: 0 };
    let started = false;
    let left = b.hold ?? OPEN_HOLD;
    let quiet = 0;
    let inner: Task | null = null;
    return {
      update: (dt) => {
        if (inner) return inner.update(dt);
        if (!started) {
          started = true;
          this.stats.asked++;
          this.pending.length = 0;
          this.setWaiting(w);
          for (const a of this.actors.values()) if (a.onStage && !a.isDown && a !== this.mounted) this.theatre.emote(a, '?');
        }
        quiet += dt;
        if ((w.nudge ?? 0) < NUDGE_AT.length && quiet >= NUDGE_AT[w.nudge ?? 0]) this.nudge(w);
        const s = this.pending.shift();
        if (s) {
          const br = b.branches[s.prop];
          if (br) {
            this.setWaiting(null);
            this.resolve('hit', w, s);
            if (br.flag) this.flags.add(br.flag);
            this.stats.wrote.push(br.title);
            inner = sequence([() => this.theatre.title(br.title, '', 2.2), () => this.run(br.beats)]);
            return false;
          }
          this.side.push(this.stock(s));
        }
        left -= dt;
        if (left <= 0) {
          this.setWaiting(null);
          this.resolve('miss', w);
          inner = this.run(b.miss);
        }
        return false;
      },
    };
  }

  update(dt: number): void {
    if (this.paused) return;
    for (const a of this.actors.values()) a.update(dt);
    this.mount?.update(dt);
    this.theatre.scroll = this.mounted && this.mount ? this.mount.speed : 0;
    if (this.snorers.size && (this.snore -= dt) <= 0) {
      this.snore = 2.6;
      for (const a of this.snorers) {
        if (a.onStage && a.isDown) this.theatre.emote(a, 'zzz');
        else this.snorers.delete(a);
      }
    }
    for (let i = this.side.length - 1; i >= 0; i--) if (this.side[i].update(dt)) this.side.splice(i, 1);
    if (this.playing && this.root) {
      if (!this.waitingNow && this.pending.length) {
        // nobody asked for this sound: the stage still answers it
        const s = this.pending.shift()!;
        this.side.push(this.stock(s));
        this.pending.length = 0;
      }
      if (this.root.update(dt)) this.root = null;
    }
  }
}
