// FoleySystem: places the stage, loads the clip, turns pinches, pokes and hand motion on props into hits,
// records the take, replays it against the film, and runs the tiles and the Director's bubbles.
import { Hovered, PokeInteractable, Pressed, RayInteractable, VisibilityState, createSystem, type Entity } from '@iwsdk/core';
import { BackSide, Mesh, MeshBasicMaterial, Object3D, Quaternion, SphereGeometry, Vector3 } from 'three';
import { Bubble } from './bubble';
import { CueTracker, type Cue } from './cues';
import { serialMode } from './env';
import { frameSerial } from '../landing/framing';
import { Lane } from './lane';
import { modelStats } from './models';
import { Recorder, encodeTake } from './recorder';
import { Replayer, schedule } from './replay';
import * as sound from './sound';
import { Stage } from './stage';
import { SCREEN_H } from './screen';
import { TABLE_H } from './toys';
import { ShakeMeter, SlideTracker, StrikeDetector, isDrop } from './triggers';
import type { HitEvent, PropId, Take } from './types';
import { PROP_IDS } from './types';
import { Serial, type SerialState } from '../serial/serial';
import type { Waiting } from '../serial/player';

const tmpP = new Vector3();
const tmpQ = new Quaternion();
const tmpF = new Vector3();
const tmpU = new Vector3();

export type Mode = 'idle' | 'take' | 'ended' | 'replay';

export interface FoleyApi {
  stage: Stage;
  loadClip: (id: string, url: string, cues?: Cue[], posterUrl?: string) => Promise<void>;
  cues: () => CueTracker | null;
  startTake: () => Promise<void>;
  replay: () => Promise<void>;
  replayTake: (take: Take) => Promise<void>;
  lastTake: () => Take | null;
  mode: () => Mode;
  /** True once the stage has been placed for the current viewpoint. */
  placed: () => boolean;
  /** The Director speaks: a bubble over the theatre, optionally for a set time. */
  say: (text: string, caption?: string, seconds?: number) => void;
  log: (...a: unknown[]) => void;
  /** The Serial, when that is the show: the clapper rolls its reels. */
  serial: () => Serial | null;
  roll: () => Promise<void>;
}

export interface FoleyHooks {
  onReady: (api: FoleyApi) => void;
  onHit: (hit: HitEvent, api: FoleyApi) => void;
  onTakeStart: (api: FoleyApi) => void;
  onTakeEnd: (take: Take, api: FoleyApi) => void;
}

let hooks: FoleyHooks = { onReady: () => {}, onHit: () => {}, onTakeStart: () => {}, onTakeEnd: () => {} };
export function setFoleyHooks(h: FoleyHooks): void {
  hooks = h;
}

/** The one-shot a ray or gaze pinch fires on each prop. */
const ONE_SHOT: Record<PropId, HitEvent['kind']> = {
  coconuts: 'clop',
  door: 'knock',
  bell: 'ding',
  thunder: 'rumble',
  whistle: 'whistle',
  glass: 'crash',
};

const GRABBABLE: PropId[] = ['coconuts', 'thunder', 'whistle', 'glass'];
const POKEABLE: PropId[] = ['door', 'bell'];
const SLAM_HOLD_MS = 350;
/** A pinch that starts this close to a prop picks it up; a pinch from further away fires its one-shot. */
const NEAR_GRAB_M = 0.18;

type Hand = 'left' | 'right';
const HANDS: Hand[] = ['right', 'left'];
const VOLUME_STEPS = [1, 0.6, 0.25, 0];
/** The toy theatre is a little larger than its model: the characters read at this size from a seat. */
const THEATRE_SIZE = 1.1;

export class FoleySystem extends createSystem({
  pressed: { required: [RayInteractable, Pressed] },
  hovered: { required: [RayInteractable, Hovered] },
}) {
  private serialOn = serialMode();
  private stage = new Stage(this.serialOn);
  private serial: Serial | null = null;
  /** What the stage is waiting for, so its prop can glow on the table. */
  private wanted: Waiting | null = null;
  private wantedPulse = 0;
  private lastWhistleToStage = -1;
  /** The house lights: a dark dome round the seat that dims the room (the passthrough) while the curtain is up. */
  private house: Mesh | null = null;
  private lastPerfLog = -100;
  private rootEntity!: Entity;
  private entityPiece = new Map<Entity, string>();
  private pieceEntity = new Map<string, Entity>();
  private placed = false;
  /** Seconds the head has had a real pose since entering XR; the stage waits for tracking to settle. */
  private placeTimer = 0;
  private lastHovered = new Set<string>();
  private lastPressed = new Set<string>();
  private pressStarted = new Map<string, number>();
  /** Props currently held: which hand holds them and where the hand was when it closed. */
  private held = new Map<string, { hand: Hand; offset: Vector3; startedAt: number }>();
  /** What each hand's pinch is holding; the pinch opening lets it go, whatever the ray does. */
  private pinchHeld: Record<Hand, PropId | null> = { left: null, right: null };
  /** The invisible hit boxes of the grabbable props: what a near pinch has to be close to. */
  private hitBoxes = new Map<PropId, Object3D>();
  private api!: FoleyApi;
  private clipId: string | null = null;
  private mode: Mode = 'idle';
  private recorder = new Recorder();
  private last: Take | null = null;
  private replayer: Replayer | null = null;
  private strike = new StrikeDetector();
  private shake = new ShakeMeter();
  private slide = new SlideTracker();
  private clopSide: 0 | 1 = 0;
  private lastSourceSync = 0;
  private lane = new Lane();
  private tracker: CueTracker | null = null;
  private director = new Bubble(0.46, 'paper');
  private slate = new Bubble(0.3, 'accent');
  private volumeStep = 0;
  private lastRumbleMark: number | undefined;
  private lastWhistleMark: number | undefined;
  private lastVy = new Map<string, number>();
  private lastY = new Map<string, number>();
  private returning = new Map<string, number>();
  private lastW = 0;
  private perfLogged = false;
  private waitLogged = false;
  private boundSession: XRSession | null = null;
  private hoverNext = new Set<string>();
  private pressNext = new Set<string>();

  init(): void {
    if (this.serialOn) {
      // the Serial: the toy theatre stands where the film screen would; the Director's tag hangs by its left pillar
      const base = import.meta.env.BASE_URL;
      this.serial = new Serial(`${base}serial/`, `${base}models/screen_frame.glb`, {
        onState: (s) => this.onSerialState(s),
        onWaiting: (w) => {
          this.wanted = w;
          this.wantedPulse = 0;
        },
        onStage: (cue) => sound.playStage(cue),
        onNote: (note) => {
          this.director.say(note, 'the Director', 10);
          console.log('DIRECTOR note', note);
        },
      });
      this.serial.theatre.setSize(THEATRE_SIZE);
      this.stage.theatreMount.add(this.serial.theatre.group);
      this.director.group.position.set(-0.7, 0.36, 0.04);
      this.stage.theatreMount.add(this.director.group);
      // drawn first and behind everything, so it darkens only what is not ours: the room
      this.house = new Mesh(
        new SphereGeometry(7, 24, 14),
        new MeshBasicMaterial({ color: 0x06050b, transparent: true, opacity: 0, side: BackSide, depthWrite: false, toneMapped: false }),
      );
      this.house.name = 'house-lights';
      this.house.renderOrder = -1000;
      this.house.frustumCulled = false;
      this.stage.root.add(this.house);
      void this.serial.init().catch((e) => console.warn('SERIAL init failed', e instanceof Error ? e.message : e));
      // without a headset the page is still playable: six keys are the six props, the space bar is the clapper
      const keys: Record<string, PropId> = { c: 'coconuts', d: 'door', b: 'bell', t: 'thunder', w: 'whistle', g: 'glass' };
      const onKey = (e: KeyboardEvent) => {
        if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        const prop = keys[e.key.toLowerCase()];
        if (prop) {
          void sound.ensureAudio();
          this.hit({ t: 0, prop, kind: ONE_SHOT[prop], v: 1 });
        } else if (e.key === ' ' || e.key === 'Enter') {
          if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return; // a focused button keeps its own key
          e.preventDefault();
          void this.rollSerial();
        }
      };
      window.addEventListener('keydown', onKey);
      this.cleanupFuncs.push(() => window.removeEventListener('keydown', onKey));
    } else {
      this.lane.group.position.set(0, -(SCREEN_H / 2) - 0.105, 0.03); // just under the frame's footlights
      this.lane.group.rotation.x = -0.28;
      this.stage.screen.group.add(this.lane.group);
      // the Director's tag hangs beside the theatre's left pillar; the slate sits at the table's far edge
      this.director.group.position.set(-0.5, 0.05, 0.02); // inside the glasses' view with room for its width
      this.stage.screen.group.add(this.director.group);
    }
    // the slate sits at the table's far edge; in the Serial it stands over the clapper it talks about, clear of the props
    if (this.serialOn) this.slate.group.position.set(-0.27, TABLE_H + 0.15, 0.09);
    else this.slate.group.position.set(0.0, TABLE_H + 0.02, -0.14);
    this.stage.table.add(this.slate.group);

    this.rootEntity = this.world.createTransformEntity(this.stage.root, { persistent: true });
    for (const piece of this.stage.pieces.values()) {
      const e = this.world.createTransformEntity(piece.root, { parent: this.rootEntity, persistent: true });
      this.entityPiece.set(e, piece.id);
      this.pieceEntity.set(piece.id, e);
      const id = piece.id as PropId;
      if (GRABBABLE.includes(id)) {
        // the invisible hit box is what the pinch lands on; a near pinch holds the prop, a far pinch fires its one-shot
        const hit = piece.root.getObjectByName(`hit-${id}`);
        if (hit) {
          this.hitBoxes.set(id, hit);
          const h = this.world.createTransformEntity(hit, { parent: e, persistent: true });
          h.addComponent(RayInteractable);
          h.addComponent(PokeInteractable); // a pat with an open hand sounds the prop too
          this.entityPiece.set(h, piece.id);
        }
      } else {
        e.addComponent(RayInteractable);
        // in the Serial everything on the table answers a touch: the clapper and the tiles too
        if (POKEABLE.includes(id) || this.serialOn) e.addComponent(PokeInteractable);
      }
    }
    this.stage.screen.onEnded = () => this.endTake();
    this.api = {
      stage: this.stage,
      loadClip: (id, url, cues, posterUrl) => this.loadClip(id, url, cues, posterUrl),
      cues: () => this.tracker,
      startTake: () => this.startTake(),
      replay: () => this.replay(),
      replayTake: (take) => this.replayTake(take),
      lastTake: () => this.last,
      mode: () => this.mode,
      placed: () => this.placed,
      say: (text, caption = '', seconds = 6) => this.director.say(text, caption, seconds),
      log: (...a) => console.log(...a),
      serial: () => this.serial,
      roll: () => this.rollSerial(),
    };
    let lastVis = this.world.visibilityState.value;
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((v) => {
        // entering or leaving XR: place the stage again for the new viewpoint
        if (v !== lastVis && (v === VisibilityState.NonImmersive || lastVis === VisibilityState.NonImmersive)) {
          this.placed = false;
          this.placeTimer = 0;
          this.waitLogged = false;
        }
        if (v !== VisibilityState.NonImmersive && lastVis === VisibilityState.NonImmersive) this.onSessionStart();
        lastVis = v;
      }),
    );
    console.log('STAGE ready');
    hooks.onReady(this.api);
  }

  /** Entering XR: the audio graph may start now, the display wants 72 Hz, and a recenter moves the room's origin. */
  private onSessionStart(): void {
    const session = this.world.session;
    if (!session || session === this.boundSession) return;
    this.boundSession = session;
    void sound.ensureAudio();
    const s = session as unknown as { updateTargetFrameRate?: (rate: number) => Promise<void> };
    try {
      s.updateTargetFrameRate?.(72)?.catch(() => undefined);
    } catch {
      // the runtime decides
    }
    try {
      this.world.renderer.xr.setFoveation(1);
    } catch {
      // not every runtime supports it
    }
    this.world.renderer.xr.getReferenceSpace()?.addEventListener('reset', () => this.reposition());
  }

  /** The slate at the table's edge says what the clapper will do next. */
  private onSerialState(s: SerialState): void {
    const serial = this.serial;
    if (!serial) return;
    if (s === 'ready') {
      this.slate.say(`Reel ${serial.reelNumber}: ${serial.reel.title}`, 'Tap the clapper to roll', 0);
      // the marquee before the first reel: what this is and the one thing to do
      if (serial.reelNumber === 1) serial.theatre.showCard('Coconuts: the Serial', 'You make every sound. Try the props, then tap the clapper.');
    }
    else if (s === 'playing') {
      this.slate.hide();
      sound.setMusic(true); // the house pianist plays from the first reel on
    }
    else if (s === 'pitch') {
      const st = serial.last;
      this.slate.say(st ? `${st.hits} of ${st.asked} sounds landed` : 'End of the reel', 'Make a sound to choose what happens next', 0);
    } else if (s === 'writing') this.slate.say('The Director is writing…', 'The next reel rolls by itself', 0);
  }

  /** The clapper in the Serial: roll the reel that is ready (or the next one); during a reel, pause and resume. */
  private async rollSerial(): Promise<void> {
    const serial = this.serial;
    if (!serial) return;
    await sound.ensureAudio();
    sound.clapperSnap();
    this.stage.snapClapper();
    if (serial.state === 'playing') {
      const paused = serial.togglePause();
      this.stage.setTileLabel('pause', paused ? 'Resume' : 'Pause');
      sound.setMusic(!paused);
      console.log(paused ? 'REEL pause' : 'REEL resume');
      return;
    }
    await serial.roll();
  }

  private async loadClip(id: string, url: string, cues: Cue[] = [], posterUrl?: string): Promise<void> {
    this.clipId = id;
    this.mode = 'idle';
    this.last = null;
    this.tracker = cues.length ? new CueTracker(cues) : null;
    this.lane.setTracker(this.tracker);
    this.slate.hide();
    await this.stage.screen.load(id, url, posterUrl);
  }

  private async startTake(): Promise<void> {
    if (!this.clipId) return;
    await sound.ensureAudio();
    sound.clapperSnap();
    this.stage.snapClapper();
    const ok = await this.stage.screen.play(0);
    if (!ok) return;
    this.recorder.start(this.clipId);
    this.tracker?.reset();
    this.slate.hide();
    this.mode = 'take';
    console.log('TAKE start', this.clipId);
    hooks.onTakeStart(this.api);
  }

  private endTake(): void {
    sound.stopHeld();
    if (this.mode === 'replay') {
      this.mode = 'ended';
      console.log('REPLAY done');
      this.slate.say('Played back.', 'Pinch the clapper to play it again', 5);
      return;
    }
    const take = this.recorder.stop();
    this.mode = 'ended';
    if (!take) return;
    this.last = take;
    const summary = this.tracker ? this.tracker.summary() : `${take.events.length} sounds`;
    console.log('TAKE code', encodeTake(take), 'hits', take.events.length, summary);
    this.slate.say(summary, 'Pinch the clapper to play it back', 0);
    hooks.onTakeEnd(take, this.api);
  }

  private async replay(): Promise<void> {
    if (this.last) await this.replayTake(this.last);
  }

  private async replayTake(take: Take): Promise<void> {
    if (take.clipId !== this.clipId) return;
    await sound.ensureAudio();
    const ok = await this.stage.screen.play(0);
    if (!ok) return;
    this.tracker?.reset();
    this.slate.hide();
    this.replayer = new Replayer(schedule(take), (e) => {
      sound.playHit(e);
      this.stage.flash(e.prop, 0.9);
      this.animateProp(e);
      this.tracker?.register(e);
    });
    this.mode = 'replay';
    console.log('REPLAY start', take.events.length);
  }

  private redo(): void {
    sound.stopHeld();
    this.stage.screen.pause();
    this.stage.screen.showLeader();
    this.recorder.stop();
    this.tracker?.reset();
    this.mode = 'idle';
    this.slate.hide();
    console.log('TAKE redo');
  }

  private onTile(id: string): void {
    if (this.serial && id !== 'tile-volume') {
      if (id === 'tile-pause' && this.serial.state === 'playing') {
        const paused = this.serial.togglePause();
        this.stage.setTileLabel('pause', paused ? 'Resume' : 'Pause');
        console.log(paused ? 'REEL pause' : 'REEL resume');
      } else if (id === 'tile-redo' && (this.serial.state === 'playing' || this.serial.state === 'pitch')) {
        console.log('REEL redo');
        void this.serial.restart();
      }
      return;
    }
    switch (id) {
      case 'tile-pause':
        if (this.mode === 'take' || this.mode === 'replay') {
          if (this.stage.screen.playing) {
            this.stage.screen.pause();
            this.stage.setTileLabel('pause', 'Resume');
            console.log('TAKE pause');
          } else {
            void this.stage.screen.play(this.stage.screen.currentTime);
            this.stage.setTileLabel('pause', 'Pause');
            console.log('TAKE resume');
          }
        }
        break;
      case 'tile-volume':
        this.volumeStep = (this.volumeStep + 1) % VOLUME_STEPS.length;
        sound.setMasterVolume(VOLUME_STEPS[this.volumeStep]);
        this.stage.setTileLabel('volume', VOLUME_STEPS[this.volumeStep] === 0 ? 'Muted' : `Vol ${Math.round(VOLUME_STEPS[this.volumeStep] * 100)}`);
        console.log('VOLUME', VOLUME_STEPS[this.volumeStep]);
        break;
      case 'tile-redo':
        this.redo();
        break;
    }
  }

  private onPressStart(id: string, entity: Entity): void {
    if (id === 'clapper') {
      console.log('PICK clapper', this.serial ? this.serial.state : this.mode);
      if (this.serial) {
        void this.rollSerial();
        return;
      }
      if (this.mode === 'take' || this.mode === 'replay') {
        if (this.stage.screen.playing) {
          this.stage.screen.pause();
          console.log('TAKE pause');
        } else {
          void this.stage.screen.play(this.stage.screen.currentTime);
        }
      } else if (this.mode === 'ended' && this.last) {
        void this.replay();
      } else {
        void this.startTake();
      }
      return;
    }
    if (id.startsWith('tile-')) {
      this.onTile(id);
      return;
    }
    const prop = id as PropId;
    void sound.ensureAudio();
    if (GRABBABLE.includes(prop)) {
      if (this.held.has(prop)) return; // the pinch already picked it up this frame
      // a pinch from a hand right beside the prop is a grab, not a far pinch (an open hand's touch is a pat: it sounds)
      for (const hand of HANDS) {
        const pinch = this.input.xr.getSelectState(hand);
        if ((pinch.active || pinch.start) && this.pinchHeld[hand] === null && this.distanceToProp(hand, prop) < NEAR_GRAB_M) {
          this.pinchHeld[hand] = prop;
          this.beginHold(prop, hand);
          return;
        }
      }
    }
    if (prop === 'door') return; // the door fires on release: a short press knocks, a held press slams
    this.hit({ t: this.stage.screen.currentTime, prop, kind: ONE_SHOT[prop], v: 1, hand: 'right' });
  }

  /** How far a hand's pinch point is from a grabbable prop's hit box. */
  private distanceToProp(hand: Hand, prop: PropId): number {
    const box = this.hitBoxes.get(prop);
    const target = box ? box.getWorldPosition(tmpU) : this.stage.worldOf(prop, tmpU);
    return this.pinchPoint(hand, tmpP).distanceTo(target);
  }

  /** The grabbable prop within reach of a hand's pinch, if any. */
  private nearestGrabbable(hand: Hand): PropId | null {
    let best: PropId | null = null;
    let bestD = NEAR_GRAB_M;
    for (const prop of GRABBABLE) {
      if (this.held.has(prop)) continue;
      const d = this.distanceToProp(hand, prop);
      if (d < bestD) {
        bestD = d;
        best = prop;
      }
    }
    return best;
  }

  /** Pinches drive the holds directly: closing near a prop picks it up, opening lets it go. */
  private trackPinches(): void {
    for (const hand of HANDS) {
      const s = this.input.xr.getSelectState(hand);
      if (s.start && this.pinchHeld[hand] === null) {
        const prop = this.nearestGrabbable(hand);
        if (prop) {
          void sound.ensureAudio();
          this.pinchHeld[hand] = prop;
          this.beginHold(prop, hand);
        }
      }
      const holding = this.pinchHeld[hand];
      if (holding && (s.end || (!s.active && !s.start))) {
        this.pinchHeld[hand] = null;
        this.endHold(holding);
      }
    }
  }

  private pinchPoint(hand: Hand, out: Vector3): Vector3 {
    const tip: Object3D | undefined = this.player.indexTipSpaces[hand];
    const grip: Object3D | undefined = this.player.gripSpaces[hand];
    if (tip) return tip.getWorldPosition(out);
    if (grip) return grip.getWorldPosition(out);
    return out.set(0, 0, 0);
  }

  private beginHold(prop: PropId, hand: Hand): void {
    const piece = this.stage.pieces.get(prop);
    if (!piece) return;
    this.pinchPoint(hand, tmpP);
    const offset = piece.root.getWorldPosition(new Vector3()).sub(tmpP);
    if (offset.length() > 0.12) offset.setLength(0.03);
    this.held.set(prop, { hand, offset, startedAt: performance.now() });
    this.returning.delete(prop);
    this.strike.reset();
    this.shake.reset();
    this.slide.reset();
    this.lastY.delete(prop);
    console.log('GRAB', prop, hand);
  }

  private endHold(prop: PropId): void {
    const h = this.held.get(prop);
    if (!h) return;
    this.held.delete(prop);
    console.log('RELEASE', prop);
    if (prop === 'thunder') sound.rumbleStop();
    if (prop === 'whistle') sound.whistleStop();
    if (prop === 'glass') {
      const piece = this.stage.pieces.get('glass');
      if (piece) {
        const tableTop = this.stage.table.getWorldPosition(tmpU).y + TABLE_H;
        const hgt = piece.root.getWorldPosition(tmpP).y - tableTop;
        const vy = this.lastVy.get('glass') ?? 0;
        if (isDrop(hgt, -vy)) this.hit({ t: this.stage.screen.currentTime, prop: 'glass', kind: 'crash', v: Math.min(1, 0.5 + hgt * 2) });
      }
    }
    this.lastY.delete(prop);
    this.returning.set(prop, 0);
  }

  private onPressEnd(id: string, heldMs: number): void {
    if (this.held.has(id)) return; // a held prop is let go by the pinch opening, not by the ray drifting off
    if (id !== 'door') return;
    const slam = heldMs >= SLAM_HOLD_MS;
    this.stage.swingDoor(slam ? 1 : 0.35);
    this.hit({ t: this.stage.screen.currentTime, prop: 'door', kind: slam ? 'slam' : 'knock', v: slam ? 1 : 0.8, hand: 'right' });
  }

  /** The prop moves with its sound: the bell's button dips, the door rattles or slams, the sheet shivers. */
  private animateProp(hit: HitEvent): void {
    if (hit.prop === 'bell') this.stage.pressBell();
    if (hit.prop === 'door') this.stage.swingDoor(hit.kind === 'slam' ? 1 : 0.35);
    if (hit.prop === 'thunder') this.stage.setThunderShake(Math.max(0.5, hit.v));
  }

  private hit(hit: HitEvent): void {
    sound.playHit(hit);
    this.stage.flash(hit.prop);
    if (hit.prop !== 'door') this.animateProp(hit); // the door swings where its press ends
    if (this.mode === 'take') {
      this.recorder.add(hit);
      const landed = this.tracker?.register(hit);
      if (landed) console.log('CUE hit', landed.cue.label, (landed.offset ?? 0).toFixed(2));
    }
    console.log('HIT', hit.prop, hit.kind, hit.t.toFixed(2), hit.v.toFixed(2));
    this.serial?.sound(hit.prop, hit.kind, hit.v);
    hooks.onHit(hit, this.api);
  }

  /** Presses are tracked per frame so the door can tell a tap from a hold. */
  private trackPressed(): void {
    const now = this.pressNext;
    now.clear();
    for (const e of this.queries.pressed.entities) {
      const id = this.entityPiece.get(e);
      if (!id) continue;
      now.add(id);
      if (!this.lastPressed.has(id)) {
        this.pressStarted.set(id, performance.now());
        this.onPressStart(id, e);
      }
    }
    for (const id of this.lastPressed) {
      if (now.has(id)) continue;
      const started = this.pressStarted.get(id) ?? performance.now();
      this.onPressEnd(id, performance.now() - started);
    }
    this.pressNext = this.lastPressed;
    this.lastPressed = now;
  }

  /** Held props follow the pinching hand; their motion makes the sound: coconuts strike, thunder shakes, whistle slides. */
  private trackHeld(now: number, dt: number): void {
    for (const [id, h] of this.held) {
      const piece = this.stage.pieces.get(id);
      if (!piece) continue;
      this.pinchPoint(h.hand, tmpP);
      if (tmpP.y < 0.25) {
        // the hand's tracking is gone (its spaces sit at the origin): let the prop go rather than drag it to the floor
        this.pinchHeld[h.hand] = null;
        this.endHold(id as PropId);
        continue;
      }
      tmpP.add(h.offset);
      piece.root.parent?.worldToLocal(tmpP);
      piece.root.position.copy(tmpP);
      const pos = piece.root.getWorldPosition(tmpF);
      sound.placeSource(id as PropId, pos); // a held prop's sound travels with the hand
      const sample = { t: now, x: pos.x, y: pos.y, z: pos.z };
      switch (id) {
        case 'coconuts': {
          const v = this.strike.feed(sample);
          if (v !== null) {
            this.clopSide = this.clopSide === 0 ? 1 : 0;
            this.hit({ t: this.stage.screen.currentTime, prop: 'coconuts', kind: 'clop', v, hand: this.clopSide ? 'left' : 'right' });
          }
          break;
        }
        case 'thunder': {
          const level = this.shake.feed(sample);
          sound.rumbleSet(level);
          this.stage.flash('thunder', level * 0.8);
          this.stage.setThunderShake(level);
          if (level > 0.35 && now - (this.lastRumbleMark ?? -1) > 0.5) {
            this.lastRumbleMark = now;
            const ev: HitEvent = { t: this.stage.screen.currentTime, prop: 'thunder', kind: 'rumble', v: level };
            if (this.recorder.open) {
              this.recorder.add(ev);
              const landed = this.tracker?.register(ev);
              if (landed) console.log('CUE hit', landed.cue.label);
            }
            console.log('HIT thunder rumble', ev.t.toFixed(2), level.toFixed(2));
            this.serial?.sound('thunder', 'rumble', level);
          }
          break;
        }
        case 'whistle': {
          const pitch = this.slide.feed(pos.y);
          sound.whistleSet(pitch);
          this.stage.setWhistleSlide(pitch);
          if (now - (this.lastWhistleMark ?? -1) > 0.4) {
            this.lastWhistleMark = now;
            const ev: HitEvent = { t: this.stage.screen.currentTime, prop: 'whistle', kind: 'whistle', v: pitch };
            if (this.recorder.open) {
              this.recorder.add(ev);
              const landed = this.tracker?.register(ev);
              if (landed) console.log('CUE hit', landed.cue.label);
            }
            console.log('HIT whistle slide', ev.t.toFixed(2), pitch.toFixed(2));
            // the stage hears the held whistle about once a second, not at every mark
            if (now - this.lastWhistleToStage > 0.9) {
              this.lastWhistleToStage = now;
              this.serial?.sound('whistle', 'whistle', pitch);
            }
          }
          break;
        }
      }
      const prevY = this.lastY.get(id);
      this.lastVy.set(id, prevY === undefined || dt <= 0 ? 0 : (sample.y - prevY) / dt);
      this.lastY.set(id, sample.y);
    }
  }

  private easeHome(dt: number): void {
    for (const [id, t0] of this.returning) {
      const piece = this.stage.pieces.get(id);
      if (!piece) continue;
      const t = Math.min(1, t0 + dt * 2.2);
      const k = 1 - Math.pow(1 - t, 3);
      piece.root.position.lerp(piece.home, k);
      piece.root.quaternion.slerp(piece.homeQuat, k);
      if (t >= 1) this.returning.delete(id);
      else this.returning.set(id, t);
    }
  }

  private placeStage(dt: number): void {
    const inXR = this.world.visibilityState.value !== VisibilityState.NonImmersive;
    if (!inXR) {
      // in a 2D browser the stage sits where a seated player's eyes would be; the page camera frames it from the side
      tmpP.set(0, 1.2, 0);
      tmpF.set(0, 0, -1);
      this.stage.placeFrom(tmpP, tmpF);
      this.frameBrowserCamera();
      this.placed = true;
      console.log('STAGE placed', this.stage.root.position.toArray().map((v) => +v.toFixed(3)).join(','), 'browser');
      return;
    }
    const src: Object3D = this.player.head;
    src.updateWorldMatrix(true, false);
    src.getWorldPosition(tmpP);
    this.placeTimer += dt;
    // a head near the floor is no pose yet, or a reference space whose origin is the head: wait a little, then place anyway
    if (tmpP.y < 0.3 && this.placeTimer < 2) {
      if (!this.waitLogged) {
        this.waitLogged = true;
        console.log('STAGE waiting for a head pose');
      }
      return;
    }
    if (this.placeTimer < 0.75) return; // let the tracked pose settle
    tmpF.set(0, 0, -1).applyQuaternion(src.getWorldQuaternion(tmpQ));
    this.stage.placeFrom(tmpP, tmpF);
    this.placed = true;
    console.log('STAGE placed', this.stage.root.position.toArray().map((v) => +v.toFixed(3)).join(','), 'yaw', +this.stage.root.rotation.y.toFixed(2), 'xr');
  }

  reposition(): void {
    this.placed = false;
    this.placeTimer = 0;
  }

  /** The landing's camera: wide screens see the stage from the right so it sits beside the copy; phones see it head-on. */
  private frameBrowserCamera(): void {
    const cam = this.world.camera;
    const wide = window.innerWidth > 900;
    if (this.serialOn) {
      frameSerial(cam, wide);
      return;
    }
    if (wide) {
      cam.position.set(0.42, 1.62, 1.45);
      cam.lookAt(-0.62, 1.0, -0.95);
    } else {
      cam.position.set(0.0, 1.55, 2.2);
      cam.lookAt(0.0, 1.02, -0.9);
    }
    cam.updateMatrixWorld(true);
  }

  private syncAudioSpace(time: number): void {
    if (!sound.audioContext()) return;
    const cam = this.world.camera;
    cam.updateWorldMatrix(true, false);
    cam.getWorldPosition(tmpP);
    cam.getWorldQuaternion(tmpQ);
    tmpF.set(0, 0, -1).applyQuaternion(tmpQ);
    tmpU.set(0, 1, 0).applyQuaternion(tmpQ);
    sound.placeListener(tmpP, tmpF, tmpU);
    if (time - this.lastSourceSync > 0.5) {
      this.lastSourceSync = time;
      for (const piece of this.stage.pieces.values()) {
        if (piece.id === 'clapper' || piece.id.startsWith('tile-')) continue;
        sound.placeSource(piece.id as PropId, piece.root.getWorldPosition(tmpP));
      }
      sound.placeSource('director', this.director.group.getWorldPosition(tmpP));
      if (this.serial) sound.placeSource('stage', this.stage.theatreMount.getWorldPosition(tmpP));
    }
  }

  update(dt: number, time: number): void {
    if (this.stage.dressed && !this.perfLogged) {
      this.perfLogged = true;
      const r = this.world.renderer.info.render;
      const s = modelStats();
      console.log('PERF calls', r.calls, 'triangles', r.triangles, 'models', `${s.loaded}/${s.loaded + s.failed}`);
    }
    if (!this.placed) this.placeStage(dt);
    const inXR = this.world.visibilityState.value !== VisibilityState.NonImmersive;
    if (!inXR && window.innerWidth !== this.lastW) {
      this.lastW = window.innerWidth;
      this.frameBrowserCamera();
    }
    const now = this.hoverNext;
    now.clear();
    for (const e of this.queries.hovered.entities) {
      const id = this.entityPiece.get(e);
      if (id) now.add(id);
    }
    for (const id of this.lastHovered) if (!now.has(id)) this.stage.setHovered(id, false);
    for (const id of now) if (!this.lastHovered.has(id)) this.stage.setHovered(id, true);
    this.hoverNext = this.lastHovered;
    this.lastHovered = now;
    this.trackPinches();
    this.trackPressed();
    this.trackHeld(time, dt);
    this.easeHome(dt);
    if (this.mode === 'replay' && this.replayer) this.replayer.tick(this.stage.screen.currentTime);
    if (this.serial) {
      this.serial.update(dt);
      if (this.house) {
        // down with the curtain's rise, up again between reels; lightning on the stage lights the room for an instant
        const t = this.serial.theatre;
        const want = (0.3 + 0.48 * t.curtainLevel) * (1 - 0.85 * t.flashLevel);
        const m = this.house.material as MeshBasicMaterial;
        m.opacity += (want - m.opacity) * Math.min(1, dt * 3);
      }
      if (this.serial.state === 'playing' && time - this.lastPerfLog > 8) {
        this.lastPerfLog = time;
        const r = this.world.renderer.info.render;
        console.log('PERF serial calls', r.calls, 'triangles', r.triangles, 'dt', dt.toFixed(3));
      }
      // the prop the stage is waiting for glows on the table; at an open moment they all do, in turn
      if (this.serial.state === 'ready') {
        // the clapper is the way in: it glows until the reel rolls
        this.wantedPulse -= dt;
        if (this.wantedPulse <= 0) {
          this.wantedPulse = 0.85;
          this.stage.flash('clapper', 0.9);
        }
      } else if (this.wanted) {
        this.wantedPulse -= dt;
        if (this.wantedPulse <= 0) {
          this.wantedPulse = 0.85;
          const props = this.wanted.prop ? [this.wanted.prop] : (this.wanted.options ?? PROP_IDS);
          for (const p of props) this.stage.flash(p, 0.85);
        }
      }
    } else this.lane.update(this.stage.screen.currentTime);
    const viewer: Object3D = inXR ? this.player.head : this.world.camera;
    this.director.update(dt, viewer);
    this.slate.update(dt, viewer);
    this.syncAudioSpace(time);
    this.stage.update(dt);
  }
}
