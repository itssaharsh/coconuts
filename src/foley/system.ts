// FoleySystem: places the stage, loads the clip, turns pinches, pokes and hand motion on props into hits,
// records the take, replays it against the film, and runs the tiles and the Director's bubbles.
import { Grabbed, Hovered, OneHandGrabbable, PokeInteractable, Pressed, RayInteractable, VisibilityState, createSystem, type Entity } from '@iwsdk/core';
import { Object3D, Quaternion, Vector3 } from 'three';
import { Bubble } from './bubble';
import { CueTracker, type Cue } from './cues';
import { Lane } from './lane';
import { Recorder, encodeTake } from './recorder';
import { Replayer, schedule } from './replay';
import * as sound from './sound';
import { Stage } from './stage';
import { SCREEN_H } from './screen';
import { TABLE_H } from './toys';
import { ShakeMeter, SlideTracker, StrikeDetector, isDrop } from './triggers';
import type { HitEvent, PropId, Take } from './types';

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
  /** The Director speaks: a bubble over the theatre, optionally for a set time. */
  say: (text: string, caption?: string, seconds?: number) => void;
  log: (...a: unknown[]) => void;
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
const VOLUME_STEPS = [1, 0.6, 0.25, 0];

export class FoleySystem extends createSystem({
  pressed: { required: [RayInteractable, Pressed] },
  hovered: { required: [RayInteractable, Hovered] },
  grabbed: { required: [Grabbed] },
}) {
  private stage = new Stage();
  private rootEntity!: Entity;
  private entityPiece = new Map<Entity, string>();
  private pieceEntity = new Map<string, Entity>();
  private placed = false;
  private placeFrames = 0;
  private lastHovered = new Set<string>();
  private lastPressed = new Set<string>();
  private pressStarted = new Map<string, number>();
  private lastGrabbed = new Set<string>();
  private grabStartedAt = new Map<string, number>();
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

  init(): void {
    this.lane.group.position.set(0, -(SCREEN_H / 2) - 0.06, 0.03);
    this.lane.group.rotation.x = -0.28;
    this.stage.screen.group.add(this.lane.group);
    // the Director's tag hangs beside the theatre's left pillar; the slate sits at the table's far edge
    this.director.group.position.set(-0.62, 0.05, 0.02);
    this.stage.screen.group.add(this.director.group);
    this.slate.group.position.set(0.0, TABLE_H + 0.02, -0.14);
    this.stage.table.add(this.slate.group);

    this.rootEntity = this.world.createTransformEntity(this.stage.root, { persistent: true });
    for (const piece of this.stage.pieces.values()) {
      const e = this.world.createTransformEntity(piece.root, { parent: this.rootEntity, persistent: true });
      this.entityPiece.set(e, piece.id);
      this.pieceEntity.set(piece.id, e);
      const id = piece.id as PropId;
      if (GRABBABLE.includes(id)) {
        // the prop itself is grabbed by a near pinch; its invisible hit box is a separate entity the far ray can press
        e.addComponent(OneHandGrabbable, { translate: true, rotate: true });
        const hit = piece.root.getObjectByName('hit');
        if (hit) {
          const h = this.world.createTransformEntity(hit, { parent: e, persistent: true });
          h.addComponent(RayInteractable);
          this.entityPiece.set(h, piece.id);
        }
      } else {
        e.addComponent(RayInteractable);
        if (POKEABLE.includes(id)) e.addComponent(PokeInteractable);
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
      say: (text, caption = '', seconds = 6) => this.director.say(text, caption, seconds),
      log: (...a) => console.log(...a),
    };
    let lastVis = this.world.visibilityState.value;
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((v) => {
        // entering or leaving XR: place the stage again for the new viewpoint
        if (v !== lastVis && (v === VisibilityState.NonImmersive || lastVis === VisibilityState.NonImmersive)) {
          this.placed = false;
          this.placeFrames = 0;
        }
        lastVis = v;
      }),
    );
    console.log('STAGE ready');
    hooks.onReady(this.api);
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
      console.log('PICK clapper', this.mode);
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
    const propEntity = this.pieceEntity.get(prop);
    if (propEntity?.hasComponent(Grabbed)) return; // a near pinch that grabs the prop is not a one-shot
    const started = this.grabStartedAt.get(prop);
    if (started !== undefined && performance.now() - started < 200) return;
    if (entity.hasComponent(Grabbed)) return;
    void sound.ensureAudio();
    if (prop === 'door') return; // the door fires on release: a short press knocks, a held press slams
    this.hit({ t: this.stage.screen.currentTime, prop, kind: ONE_SHOT[prop], v: 1, hand: 'right' });
  }

  private onPressEnd(id: string, heldMs: number): void {
    if (id !== 'door') return;
    const slam = heldMs >= SLAM_HOLD_MS;
    this.stage.swingDoor(slam ? 1 : 0.35);
    this.hit({ t: this.stage.screen.currentTime, prop: 'door', kind: slam ? 'slam' : 'knock', v: slam ? 1 : 0.8, hand: 'right' });
  }

  private hit(hit: HitEvent): void {
    sound.playHit(hit);
    this.stage.flash(hit.prop);
    if (this.mode === 'take') {
      this.recorder.add(hit);
      const landed = this.tracker?.register(hit);
      if (landed) console.log('CUE hit', landed.cue.label, (landed.offset ?? 0).toFixed(2));
    }
    console.log('HIT', hit.prop, hit.kind, hit.t.toFixed(2), hit.v.toFixed(2));
    hooks.onHit(hit, this.api);
  }

  /** Presses are tracked per frame so the door can tell a tap from a hold. */
  private trackPressed(): void {
    const now = new Set<string>();
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
    this.lastPressed = now;
  }

  /** Hand motion on held props: coconuts strike, thunder shakes, whistle slides, glass drops. */
  private trackGrabbed(now: number): void {
    const current = new Set<string>();
    for (const e of this.queries.grabbed.entities) {
      const id = this.entityPiece.get(e);
      if (!id) continue;
      current.add(id);
      const piece = this.stage.pieces.get(id);
      if (!piece) continue;
      const pos = piece.root.getWorldPosition(tmpP);
      const sample = { t: now, x: pos.x, y: pos.y, z: pos.z };
      if (!this.lastGrabbed.has(id)) {
        this.grabStartedAt.set(id, performance.now());
        this.strike.reset();
        this.shake.reset();
        this.slide.reset();
        this.returning.delete(id);
        void sound.ensureAudio();
        console.log('GRAB', id);
      }
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
          if (level > 0.35 && this.recorder.open && now - (this.lastRumbleMark ?? -1) > 0.5) {
            this.lastRumbleMark = now;
            const ev: HitEvent = { t: this.stage.screen.currentTime, prop: 'thunder', kind: 'rumble', v: level };
            this.recorder.add(ev);
            const landed = this.tracker?.register(ev);
            if (landed) console.log('CUE hit', landed.cue.label);
            console.log('HIT thunder rumble', ev.t.toFixed(2), level.toFixed(2));
          }
          break;
        }
        case 'whistle': {
          const pitch = this.slide.feed(pos.y);
          sound.whistleSet(pitch);
          this.stage.setWhistleSlide(pitch);
          if (this.recorder.open && now - (this.lastWhistleMark ?? -1) > 0.4) {
            this.lastWhistleMark = now;
            const ev: HitEvent = { t: this.stage.screen.currentTime, prop: 'whistle', kind: 'whistle', v: pitch };
            this.recorder.add(ev);
            const landed = this.tracker?.register(ev);
            if (landed) console.log('CUE hit', landed.cue.label);
            console.log('HIT whistle slide', ev.t.toFixed(2), pitch.toFixed(2));
          }
          break;
        }
      }
      const prevY = this.lastY.get(id);
      this.lastVy.set(id, prevY === undefined ? 0 : (sample.y - prevY) * 72);
      this.lastY.set(id, sample.y);
    }
    for (const id of this.lastGrabbed) {
      if (current.has(id)) continue;
      console.log('RELEASE', id);
      if (id === 'thunder') sound.rumbleStop();
      if (id === 'whistle') sound.whistleStop();
      if (id === 'glass') {
        const piece = this.stage.pieces.get('glass');
        if (piece) {
          const tableTop = this.stage.table.getWorldPosition(tmpU).y + TABLE_H;
          const h = piece.root.getWorldPosition(tmpP).y - tableTop;
          const vy = this.lastVy.get('glass') ?? 0;
          if (isDrop(h, -vy)) this.hit({ t: this.stage.screen.currentTime, prop: 'glass', kind: 'crash', v: Math.min(1, 0.5 + h * 2) });
        }
      }
      this.lastY.delete(id);
      this.returning.set(id, 0);
    }
    this.lastGrabbed = current;
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

  private placeStage(): void {
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
    if (tmpP.y < 0.3) return; // no real pose yet
    if (this.placeFrames++ < 10) return; // let the tracked pose settle for a few frames
    tmpF.set(0, 0, -1).applyQuaternion(src.getWorldQuaternion(tmpQ));
    this.stage.placeFrom(tmpP, tmpF);
    this.placed = true;
    console.log('STAGE placed', this.stage.root.position.toArray().map((v) => +v.toFixed(3)).join(','), 'yaw', +this.stage.root.rotation.y.toFixed(2), 'xr');
  }

  reposition(): void {
    this.placed = false;
    this.placeFrames = 0;
  }

  /** The landing's camera: wide screens see the stage from the right so it sits beside the copy; phones see it head-on. */
  private frameBrowserCamera(): void {
    const cam = this.world.camera;
    const wide = window.innerWidth > 900;
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
    }
  }

  update(dt: number, time: number): void {
    if (!this.placed) this.placeStage();
    const inXR = this.world.visibilityState.value !== VisibilityState.NonImmersive;
    if (!inXR && window.innerWidth !== this.lastW) {
      this.lastW = window.innerWidth;
      this.frameBrowserCamera();
    }
    const now = new Set<string>();
    for (const e of this.queries.hovered.entities) {
      const id = this.entityPiece.get(e);
      if (id) now.add(id);
    }
    for (const id of this.lastHovered) if (!now.has(id)) this.stage.setHovered(id, false);
    for (const id of now) if (!this.lastHovered.has(id)) this.stage.setHovered(id, true);
    this.lastHovered = now;
    this.trackPressed();
    this.trackGrabbed(time);
    this.easeHome(dt);
    if (this.mode === 'replay' && this.replayer) this.replayer.tick(this.stage.screen.currentTime);
    this.lane.update(this.stage.screen.currentTime);
    const viewer: Object3D = inXR ? this.player.head : this.world.camera;
    this.director.update(dt, viewer);
    this.slate.update(dt, viewer);
    this.syncAudioSpace(time);
    this.stage.update(dt);
  }
}
