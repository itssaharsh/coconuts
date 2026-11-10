// FoleySystem: places the stage, loads the clip, turns pinches and hand motion on props into hits,
// records the take and replays it against the film.
import { Grabbed, Hovered, OneHandGrabbable, Pressed, RayInteractable, VisibilityState, createSystem, type Entity } from '@iwsdk/core';
import { Object3D, Quaternion, Vector3 } from 'three';
import { CueTracker, type Cue } from './cues';
import { Lane } from './lane';
import { Recorder, encodeTake } from './recorder';
import { Replayer, schedule } from './replay';
import * as sound from './sound';
import { Stage } from './stage';
import { TABLE_H } from './toys';
import { ShakeMeter, SlideTracker, StrikeDetector, isDrop } from './triggers';
import type { HitEvent, PropId, Take } from './types';

const tmpP = new Vector3();
const tmpQ = new Quaternion();
const tmpF = new Vector3();
const tmpU = new Vector3();

export interface FoleyApi {
  stage: Stage;
  loadClip: (id: string, url: string, cues?: Cue[]) => Promise<void>;
  cues: () => CueTracker | null;
  startTake: () => Promise<void>;
  replay: () => Promise<void>;
  lastTake: () => Take | null;
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

type Mode = 'idle' | 'take' | 'ended' | 'replay';

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
  private lastHovered = new Set<string>();
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
  private lastPos = new Map<string, Vector3>();
  private lastSourceSync = 0;
  private lane = new Lane();
  private tracker: CueTracker | null = null;

  init(): void {
    this.lane.group.position.set(0, -0.285, 0.03);
    this.lane.group.rotation.x = -0.28;
    this.stage.screen.group.add(this.lane.group);
    this.rootEntity = this.world.createTransformEntity(this.stage.root, { persistent: true });
    for (const piece of this.stage.pieces.values()) {
      const e = this.world.createTransformEntity(piece.root, { parent: this.rootEntity, persistent: true });
      this.entityPiece.set(e, piece.id);
      this.pieceEntity.set(piece.id, e);
      if (GRABBABLE.includes(piece.id as PropId)) {
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
      }
    }
    this.stage.screen.onEnded = () => this.endTake();
    this.api = {
      stage: this.stage,
      loadClip: (id, url, cues) => this.loadClip(id, url, cues),
      cues: () => this.tracker,
      startTake: () => this.startTake(),
      replay: () => this.replay(),
      lastTake: () => this.last,
      log: (...a) => console.log(...a),
    };
    this.queries.pressed.subscribe('qualify', (entity) => this.onPressed(entity));
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

  private async loadClip(id: string, url: string, cues: Cue[] = []): Promise<void> {
    this.clipId = id;
    this.mode = 'idle';
    this.tracker = cues.length ? new CueTracker(cues) : null;
    this.lane.setTracker(this.tracker);
    await this.stage.screen.load(id, url);
  }

  private async startTake(): Promise<void> {
    if (!this.clipId) return;
    await sound.ensureAudio();
    const ok = await this.stage.screen.play(0);
    if (!ok) return;
    this.recorder.start(this.clipId);
    this.tracker?.reset();
    this.mode = 'take';
    console.log('TAKE start', this.clipId);
    hooks.onTakeStart(this.api);
  }

  private endTake(): void {
    sound.stopHeld();
    if (this.mode === 'replay') {
      this.mode = 'ended';
      console.log('REPLAY done');
      return;
    }
    const take = this.recorder.stop();
    this.mode = 'ended';
    if (!take) return;
    this.last = take;
    console.log('TAKE code', encodeTake(take), 'hits', take.events.length, this.tracker ? this.tracker.summary() : '');
    hooks.onTakeEnd(take, this.api);
  }

  private async replay(): Promise<void> {
    if (!this.last) return;
    await sound.ensureAudio();
    const ok = await this.stage.screen.play(0);
    if (!ok) return;
    this.replayer = new Replayer(schedule(this.last), (e) => {
      sound.playHit(e);
      this.stage.flash(e.prop, 0.9);
    });
    this.mode = 'replay';
    console.log('REPLAY start', this.last.events.length);
  }

  private onPressed(entity: Entity): void {
    const id = this.entityPiece.get(entity);
    if (!id) return;
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
    const prop = id as PropId;
    // a near pinch that grabs the prop is not a one-shot
    const propEntity = this.pieceEntity.get(prop);
    if (propEntity?.hasComponent(Grabbed)) return;
    const started = this.grabStartedAt.get(prop);
    if (started !== undefined && performance.now() - started < 200) return;
    void sound.ensureAudio();
    this.hit({ t: this.stage.screen.currentTime, prop, kind: ONE_SHOT[prop], v: 1, hand: 'right' });
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
          if (level > 0.35 && this.recorder.open && (now - (this.lastRumbleMark ?? -1) > 0.5)) {
            this.lastRumbleMark = now;
            this.recorder.add({ t: this.stage.screen.currentTime, prop: 'thunder', kind: 'rumble', v: level });
            this.stage.flash('thunder', level);
          }
          break;
        }
        case 'whistle': {
          const pitch = this.slide.feed(pos.y);
          sound.whistleSet(pitch);
          if (this.recorder.open && now - (this.lastWhistleMark ?? -1) > 0.4) {
            this.lastWhistleMark = now;
            this.recorder.add({ t: this.stage.screen.currentTime, prop: 'whistle', kind: 'whistle', v: pitch });
          }
          break;
        }
        case 'glass': {
          this.lastPos.set(id, (this.lastPos.get(id) ?? new Vector3()).copy(pos));
          break;
        }
      }
      this.lastVy.set(id, this.lastVy.has(id) ? (sample.y - (this.lastY.get(id) ?? sample.y)) * 72 : 0);
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
      this.returnHome(id);
    }
    this.lastGrabbed = current;
  }
  private lastRumbleMark: number | undefined;
  private lastWhistleMark: number | undefined;
  private lastVy = new Map<string, number>();
  private lastY = new Map<string, number>();
  private returning = new Map<string, number>();

  private returnHome(id: string): void {
    this.returning.set(id, 0);
  }

  private easeHome(dt: number): void {
    for (const [id, t0] of this.returning) {
      const piece = this.stage.pieces.get(id);
      if (!piece) continue;
      const t = Math.min(1, t0 + dt * 2.2);
      const k = 1 - Math.pow(1 - t, 3);
      piece.root.position.lerp(piece.home, k);
      piece.root.quaternion.slerp(new Quaternion(), k);
      if (t >= 1) this.returning.delete(id);
      else this.returning.set(id, t);
    }
  }

  private placeFrames = 0;

  private placeStage(): void {
    const inXR = this.world.visibilityState.value !== VisibilityState.NonImmersive;
    const src: Object3D = inXR ? this.player.head : this.world.camera;
    src.updateWorldMatrix(true, false);
    src.getWorldPosition(tmpP);
    if (tmpP.y < 0.3) return; // no real pose yet
    if (inXR && this.placeFrames++ < 10) return; // let the tracked pose settle for a few frames
    tmpF.set(0, 0, -1).applyQuaternion(src.getWorldQuaternion(tmpQ));
    this.stage.placeFrom(tmpP, tmpF);
    this.placed = true;
    console.log('STAGE placed', this.stage.root.position.toArray().map((v) => +v.toFixed(3)).join(','), 'yaw', +this.stage.root.rotation.y.toFixed(2), inXR ? 'xr' : 'browser');
  }

  reposition(): void {
    this.placed = false;
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
        if (piece.id === 'clapper') continue;
        sound.placeSource(piece.id as PropId, piece.root.getWorldPosition(tmpP));
      }
    }
  }

  update(dt: number, time: number): void {
    if (!this.placed) this.placeStage();
    const now = new Set<string>();
    for (const e of this.queries.hovered.entities) {
      const id = this.entityPiece.get(e);
      if (id) now.add(id);
    }
    for (const id of this.lastHovered) if (!now.has(id)) this.stage.setHovered(id, false);
    for (const id of now) if (!this.lastHovered.has(id)) this.stage.setHovered(id, true);
    this.lastHovered = now;
    this.trackGrabbed(time);
    this.easeHome(dt);
    if (this.mode === 'replay' && this.replayer) this.replayer.tick(this.stage.screen.currentTime);
    this.lane.update(this.stage.screen.currentTime);
    this.syncAudioSpace(time);
    this.stage.update(dt);
  }
}
