// The troupe: rigged kit characters on one shared skeleton, each driven by named verbs. Positions are in kit units
// on the stage floor (x across, z toward the audience); the theatre scales the whole stage down.
import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  CircleGeometry,
  Group,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Vector3,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { glowTexture } from './cards';
import { filmify } from './film';
import type { CharacterId, Verb } from './schema';
import { type Task } from './tasks';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<GLTF>>();
export function loadGLB(url: string): Promise<GLTF> {
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(url);
    cache.set(url, p);
  }
  return p;
}

/** verb -> clip(s). `then` plays after a one-shot; `hold` stays on the last frame (a fallen actor stays down). */
const CLIPS: Record<Verb, { clip: string; loop?: boolean; hold?: boolean; then?: string; alt?: string }> = {
  idle: { clip: 'Idle', loop: true },
  walk: { clip: 'Walking_A', loop: true },
  run: { clip: 'Running_A', loop: true },
  jump: { clip: 'Jump_Full_Short' },
  flinch: { clip: 'Hit_A' },
  stagger: { clip: 'Hit_B' },
  fall: { clip: 'Death_A', hold: true },
  faint: { clip: 'Death_B', hold: true },
  getup: { clip: 'Lie_StandUp' },
  block: { clip: 'Block' },
  chop: { clip: '1H_Melee_Attack_Chop' },
  slash: { clip: '1H_Melee_Attack_Slice_Horizontal' },
  stab: { clip: '1H_Melee_Attack_Stab' },
  punch: { clip: 'Unarmed_Melee_Attack_Punch_A' },
  kick: { clip: 'Unarmed_Melee_Attack_Kick' },
  pickup: { clip: 'PickUp' },
  throw: { clip: 'Throw' },
  drink: { clip: 'Use_Item' },
  knock: { clip: 'Interact' },
  cheer: { clip: 'Cheer' },
  sit: { clip: 'Sit_Chair_Down', then: 'Sit_Chair_Idle', hold: true },
  stand: { clip: 'Sit_Chair_StandUp' },
  sitfloor: { clip: 'Sit_Floor_Down', then: 'Sit_Floor_Idle', hold: true },
  sleep: { clip: 'Lie_Down', then: 'Lie_Idle', hold: true },
  cast: { clip: 'Spellcast_Raise' },
  zap: { clip: 'Spellcast_Shoot' },
  dodge: { clip: 'Dodge_Backward' },
  guard: { clip: 'Idle_Combat', loop: true, alt: 'Idle' },
  awaken: { clip: 'Skeletons_Awaken_Floor', alt: 'Lie_StandUp' },
  collapse: { clip: 'Death_C_Skeletons', hold: true, alt: 'Death_A' },
  rise: { clip: 'Death_C_Skeletons_Resurrect', alt: 'Lie_StandUp' },
};

const LEFT_HAND_ITEMS = new Set(['shield_round', 'spellbook', 'skeleton_shield_small']);

// The stage has no shadow maps: every actor stands on a soft dark disc instead.
let blobGeo: CircleGeometry | null = null;
let blobMat: MeshBasicMaterial | null = null;
function blob(rx: number, rz: number): Mesh {
  blobGeo ??= new CircleGeometry(1, 20).rotateX(-Math.PI / 2);
  blobMat ??= new MeshBasicMaterial({ toneMapped: false, map: glowTexture(), color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false });
  const m = new Mesh(blobGeo, blobMat);
  m.scale.set(rx, 1, rz);
  m.position.y = 0.05;
  m.renderOrder = 1;
  m.name = 'blob';
  return m;
}

const WALK_SPEED = 3.4; // kit units per second
const RUN_SPEED = 7.5;
const TURN_RATE = 9; // radians per second toward the heading
const tmp = new Vector3();

export class Actor {
  readonly root = new Group();
  private mixer: AnimationMixer;
  private actions = new Map<string, AnimationAction>();
  private current: AnimationAction | null = null;
  private heading = 0;
  private wantHeading = 0;
  /** True while a held pose (fallen, seated, asleep) should not be replaced by idle. */
  private held = false;
  private items = new Map<string, Object3D>();
  private shadow: Mesh;
  onStage = false;

  constructor(
    readonly id: string,
    readonly char: CharacterId,
    body: Object3D,
    private clips: Map<string, AnimationClip>,
  ) {
    this.root.name = `actor-${id}`;
    this.root.add(body);
    filmify(body, { actor: true });
    this.shadow = blob(1.25, 1.25);
    this.root.add(this.shadow);
    this.mixer = new AnimationMixer(body);
    this.play('idle', 0);
  }

  private action(name: string): AnimationAction | null {
    let a = this.actions.get(name);
    if (a) return a;
    const clip = this.clips.get(name);
    if (!clip) return null;
    a = this.mixer.clipAction(clip);
    this.actions.set(name, a);
    return a;
  }

  /** Start a verb's clip; returns how long the one-shot lasts (0 for loops). */
  play(verb: Verb, fade = 0.16): number {
    const spec = CLIPS[verb];
    // getting up depends on how the actor is down: from a chair, from sitting on the floor, from lying
    const from = this.current?.getClip().name ?? '';
    const rise = verb === 'getup' || verb === 'stand' ? (from.startsWith('Sit_Chair') ? 'Sit_Chair_StandUp' : from.startsWith('Sit_Floor') ? 'Sit_Floor_StandUp' : null) : null;
    const a = (rise ? this.action(rise) : null) ?? this.action(spec.clip) ?? (spec.alt ? this.action(spec.alt) : null) ?? this.action('Idle');
    if (!a) return 0;
    const loop = !!spec.loop;
    a.reset();
    a.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
    a.clampWhenFinished = !loop;
    if (this.current && this.current !== a) {
      a.crossFadeFrom(this.current, fade, false);
    } else if (fade > 0) a.fadeIn(fade);
    a.play();
    this.current = a;
    this.held = !!spec.hold;
    return loop ? 0 : a.getClip().duration;
  }

  /** The follow-up clip of a verb that settles into a pose (sit down, then sit). */
  private settle(verb: Verb): void {
    const spec = CLIPS[verb];
    if (!spec.then) return;
    const a = this.action(spec.then);
    if (!a || !this.current) return;
    a.reset();
    a.setLoop(LoopRepeat, Infinity);
    a.crossFadeFrom(this.current, 0.2, false);
    a.play();
    this.current = a;
  }

  /** Hold a clip's looping pose at once (a rider already in the saddle when the curtain opens). */
  pose(clip: string): void {
    const a = this.action(clip);
    if (!a) return;
    this.current?.stop();
    a.reset();
    a.setLoop(LoopRepeat, Infinity);
    a.play();
    this.current = a;
    this.held = true;
  }

  /** A verb's settled pose at once: asleep, seated, on guard. */
  poseVerb(verb: Verb): void {
    const spec = CLIPS[verb];
    this.pose(spec.then ?? spec.clip);
    this.held = !!spec.hold;
  }

  place(x: number, z: number, facing = 0): void {
    this.root.position.set(x, 0, z);
    this.heading = this.wantHeading = facing;
    this.root.rotation.y = facing;
  }

  face(x: number, z: number): void {
    const dx = x - this.root.position.x;
    const dz = z - this.root.position.z;
    if (dx * dx + dz * dz > 1e-4) this.wantHeading = Math.atan2(dx, dz);
  }

  faceAudience(): void {
    this.wantHeading = 0;
  }

  /** Walk or run to a spot; the task ends on arrival. */
  goTo(x: number, z: number, gait: 'walk' | 'run' = 'walk'): Task {
    let started = false;
    const speed = gait === 'run' ? RUN_SPEED : WALK_SPEED;
    return {
      update: (dt) => {
        if (!started) {
          started = true;
          this.play(gait);
        }
        const p = this.root.position;
        tmp.set(x - p.x, 0, z - p.z);
        const d = tmp.length();
        const step = speed * dt;
        if (d <= step || d < 0.02) {
          p.set(x, 0, z);
          this.play('idle');
          return true;
        }
        this.wantHeading = Math.atan2(tmp.x, tmp.z);
        p.addScaledVector(tmp, step / d);
        return false;
      },
      cancel: () => this.play('idle'),
    };
  }

  /** Perform a verb once (or for `secs`), then go back to idle unless the verb leaves the actor in a pose. */
  perform(verb: Verb, secs?: number): Task {
    let left = -1;
    let settled = false;
    return {
      update: (dt) => {
        if (left < 0) {
          const d = this.play(verb);
          left = secs ?? (d > 0 ? d : 1.2);
        }
        left -= dt;
        if (left > 0) return false;
        const spec = CLIPS[verb];
        if (spec.then && !settled) {
          settled = true;
          this.settle(verb);
        } else if (!spec.hold && !spec.loop) this.play('idle');
        return true;
      },
    };
  }

  /** Put a kit item in a hand: the item files carry the grip offset, so the hand bone just adopts them. */
  async hold(base: string, item: string): Promise<void> {
    try {
      const gltf = await loadGLB(`${base}items/${item}.glb`);
      const o = gltf.scene.clone(true);
      filmify(o, { actor: true });
      const bone = this.root.getObjectByName(LEFT_HAND_ITEMS.has(item) ? 'handslotl' : 'handslotr');
      if (!bone) return;
      o.name = `item-${item}`;
      bone.add(o);
      this.items.set(item, o);
    } catch (e) {
      console.warn('ACTOR item failed', item, e instanceof Error ? e.message : e);
    }
  }

  drop(item: string): void {
    const o = this.items.get(item);
    if (o) o.removeFromParent();
    this.items.delete(item);
  }

  /** Where an emote should float: just above the head, in stage space (a rider sits higher than a walker). */
  head(out = new Vector3()): Vector3 {
    if (this.root.parent && this.root.parent.name === 'seat') {
      const stage = this.root.parent.parent?.parent;
      this.root.getWorldPosition(out);
      if (stage) stage.worldToLocal(out);
      return out.setY(out.y + 2.4);
    }
    return out.copy(this.root.position).setY(3.1);
  }

  get isDown(): boolean {
    return this.held;
  }

  update(dt: number): void {
    // turn toward the heading the short way round
    let d = this.wantHeading - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, TURN_RATE * dt);
    this.root.rotation.y = this.heading;
    this.mixer.update(dt);
    // no shadow in the saddle, and none past the wings where the stage's own materials are cut off
    this.shadow.visible = this.root.parent?.name !== 'seat' && Math.abs(this.root.position.x) < 6.4;
  }
}

/** Loads the shared clips once and makes actors from the character files. */
export class Troupe {
  private clips = new Map<string, AnimationClip>();
  private ready: Promise<void> | null = null;

  constructor(readonly base: string) {}

  /** Clips come from the shared animation files; a character file that still carries its own clips adds to them. */
  load(): Promise<void> {
    if (!this.ready) {
      this.ready = Promise.all([loadGLB(`${this.base}anims.glb`).catch(() => null)]).then((files) => {
        for (const f of files) for (const c of f?.animations ?? []) this.clips.set(c.name, c);
      });
    }
    return this.ready;
  }

  async spawn(id: string, char: CharacterId): Promise<Actor> {
    await this.load();
    const gltf = await loadGLB(`${this.base}chars/${char}.glb`);
    for (const c of gltf.animations) if (!this.clips.has(c.name)) this.clips.set(c.name, c);
    return new Actor(id, char, cloneSkinned(gltf.scene), this.clips);
  }

  /** Fetch character files ahead of the curtain so the first entrance does not hitch. */
  preload(chars: CharacterId[]): Promise<unknown> {
    return Promise.all([this.load(), ...chars.map((c) => loadGLB(`${this.base}chars/${c}.glb`).catch(() => null))]);
  }
}

/** The puppet horse: runs as fast as it is told, carries a rider on its back. It faces +z in its own space. */
export class Mount {
  readonly root = new Group();
  private mixer: AnimationMixer | null = null;
  private idle: AnimationAction | null = null;
  private gallop: AnimationAction | null = null;
  /** 0 = standing, 1 = full gallop; eased so the horse never stops dead. */
  private pace = 0;
  private wantPace = 0;
  private phase = 0;
  private seatAt = new Vector3(0, 2.25, -0.1);
  /** The rider's pitch over the horse's neck when it stops short: a damped spring. */
  private pitch = 0;
  private pitchV = 0;
  readonly seat = new Group();

  constructor(private base: string) {
    this.root.name = 'mount';
    this.seat.name = 'seat';
    this.root.add(this.seat);
  }

  /** The horse file carries its own scale; `seat` is where a rider's root goes, in the horse's space. */
  async load(seat?: [number, number, number]): Promise<void> {
    const gltf = await loadGLB(`${this.base}horse.glb`);
    const body = cloneSkinned(gltf.scene);
    filmify(body, { actor: true });
    this.root.add(body, blob(1.5, 2.7));
    if (seat) this.seatAt.set(...seat);
    this.seat.position.copy(this.seatAt);
    this.mixer = new AnimationMixer(body);
    const find = (n: string) => gltf.animations.find((a) => a.name.toLowerCase() === n) ?? gltf.animations.find((a) => a.name.toLowerCase().includes(n));
    const idle = find('idle');
    const gallop = find('gallop') ?? find('walk');
    if (idle) {
      this.idle = this.mixer.clipAction(idle);
      this.idle.play();
    }
    if (gallop) {
      this.gallop = this.mixer.clipAction(gallop);
      this.gallop.play();
      this.gallop.setEffectiveWeight(0);
    }
  }

  setPace(p: number): void {
    this.wantPace = Math.max(0, Math.min(1, p));
  }

  get speed(): number {
    return this.pace;
  }

  /** The horse stops short and the rider goes over its neck (and comes back). */
  lurch(): void {
    this.pitchV = 7.5;
  }

  update(dt: number): void {
    // quick to pick up, quick to pull up: the horse answers the hooves it hears
    const k = this.wantPace > this.pace ? 5 : 2.6;
    this.pace += (this.wantPace - this.pace) * Math.min(1, k * dt);
    if (this.gallop && this.idle) {
      const w = Math.min(1, this.pace * 1.6);
      this.gallop.setEffectiveWeight(w);
      this.idle.setEffectiveWeight(1 - w);
      this.gallop.setEffectiveTimeScale(0.5 + this.pace * 0.8);
    }
    this.mixer?.update(dt);
    // the rider bobs with the gait and pitches when the horse stops short
    this.phase += dt * (5 + 9 * this.pace);
    this.pitchV += (-90 * this.pitch - 9 * this.pitchV) * dt;
    this.pitch += this.pitchV * dt;
    this.seat.position.set(this.seatAt.x, this.seatAt.y + Math.sin(this.phase) * 0.09 * this.pace, this.seatAt.z + Math.max(0, this.pitch) * 0.5);
    this.seat.rotation.x = this.pitch;
  }
}
