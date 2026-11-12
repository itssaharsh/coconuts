// FoleySystem: places the stage, turns pinches, pokes and hand motion on props into sounds for the Serial,
// and runs the tiles and the slate.
import { Hovered, Pressed, RayInteractable, VisibilityState, createSystem, type Entity } from '@iwsdk/core';
import { BackSide, Box3, Matrix4, Mesh, MeshBasicMaterial, Object3D, Quaternion, SphereGeometry, Vector3 } from 'three';
import { Bubble } from './bubble';
import { automationRun, captureMode, startReel } from './env';
import { frameSerial } from '../landing/framing';
import { modelStats } from './models';
import { HOUSE_SOUNDS } from './samples';
import * as sound from './sound';
import * as voice from './voice';
import { Stage, THEATRE_SMALL } from './stage';
import { TABLE_H } from './toys';
import { PatGate, ShakeMeter, SlideTracker, StrikeDetector, Stroke, TOUCH_IN, isDrop } from './triggers';
import type { HitEvent, PropId } from './types';
import { DESK_ROUTE, PROP_IDS } from './types';
import { Serial, type SerialState } from '../serial/serial';
import type { Waiting } from '../serial/player';
import { type ReelPlan, WRITTEN } from '../serial/pieces';
import { REEL_1_FINALE } from '../serial/chapter1';

const tmpP = new Vector3();
const tmpM = new Matrix4();
const tmpM2 = new Matrix4();
const tmpBox = new Box3();
const tmpQ = new Quaternion();
const tmpF = new Vector3();
const tmpU = new Vector3();

export interface FoleyApi {
  /** The Serial: the clapper rolls its reels. */
  serial: () => Serial;
}

export interface FoleyHooks {
  onReady: (api: FoleyApi) => void;
}

let hooks: FoleyHooks = { onReady: () => {} };
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
const SLAM_HOLD_MS = 350;
/** A pinch that starts this close to a prop picks it up; a pinch from further away fires its one-shot. */
const NEAR_GRAB_M = 0.11;
/** A fingertip within TOUCH_IN of a piece's own shape touches it; it has let go once it is this far clear again. */
const TOUCH_OUT = 0.035;
/** Props a hand also picks up, and that are not drummed: a touch waits this long, in case it is the start of a pick-up. */
const PAT_WAITS: ReadonlySet<string> = new Set(['thunder', 'whistle', 'glass']);
const PAT_WAIT_S = 0.2;
/** A hand that drops out of sight while holding a prop keeps it this long: tracking blinks when one hand covers the other. */
const LOST_HOLD_S = 0.6;
/** A knock that arrives faster than this is a slam (m/s). */
const SLAM_SPEED = 1.1;

type Hand = 'left' | 'right';
const HANDS: Hand[] = ['right', 'left'];

/** How far a point is from a box (both in the box's own space): negative inside, by the depth under the nearest face. */
function depthIn(box: Box3, p: Vector3): number {
  const d = box.distanceToPoint(p);
  if (d > 0) return d;
  return -Math.min(p.x - box.min.x, box.max.x - p.x, p.y - box.min.y, box.max.y - p.y, p.z - box.min.z, box.max.z - p.z);
}
const VOLUME_STEPS = [1, 0.6, 0.25, 0];

export class FoleySystem extends createSystem({
  pressed: { required: [RayInteractable, Pressed] },
  hovered: { required: [RayInteractable, Hovered] },
}) {
  /** A capture run: a fixed step of show time for every drawn frame, and a log of every sound for the soundtrack. */
  private capture = captureMode();
  private showClock = 0;
  private frameNo = 0;
  private stage = new Stage();
  private serial!: Serial;
  /** What the stage is waiting for, so its prop can glow on the table. */
  private wanted: Waiting | null = null;
  private wantedPulse = 0;
  private lastWhistleToStage = -1;
  /** The house lights: a dark dome round the seat that dims the room (the passthrough) while the curtain is up. */
  private house: Mesh | null = null;
  /** Where the eyes were when the stage was placed; a player who then sits down (or moves seat) gets it placed again. */
  private placedEye = new Vector3();
  private movedFor = 0;
  /** A slow headset at wall size: the stage goes back to the desk and stays there. */
  private frameAvg = 1 / 72;
  private slowFor = 0;
  /** Seconds the theatre has been at wall size: its first moments compile and upload, which is not the headset being slow. */
  private bigFor = 0;
  private bigLockedAt = -1e9;
  private fxDropped = false;
  /** A narrow display: wall size is off for the whole session. */
  private narrowView = false;
  /** Each hand's fingertip, watched so a resting or drifting hand does not count as a pat. */
  private pats: Record<Hand, PatGate> = { left: new PatGate(), right: new PatGate() };
  /** What each fingertip rests on, and whether that touch counted (a resting hand's does not). */
  private touching: Record<Hand, Stroke | null> = { left: null, right: null };
  /** Whether each hand has a pose this frame (see seeHands). */
  private handSeen: Record<Hand, boolean> = { left: false, right: false };
  /** Seconds each hand has been out of sight while it holds a prop. */
  private lostFor: Record<Hand, number> = { left: 0, right: 0 };
  /** When a pinch last picked a prop up (show seconds): that pinch is not also a press from afar. */
  private grabbedAt = -1;
  /** The way the player faced when the stage was placed, flat on the floor. */
  private placedFwd = new Vector3(0, 0, -1);
  /** In the headset with the sound still locked (no gesture on the page yet): the slate says how to free it. */
  private soundLocked = false;
  /** Pinches made while the sound was locked: if they do not free it, the hint changes. */
  private lockedPinches = 0;
  private touchBounds = new Map<string, Box3>();
  private pendingPat: Record<Hand, { id: string; at: number } | null> = { left: null, right: null };
  private patsTaken = 0;
  private patsRefused = 0;
  private patFilterOff = false;
  private patClock = 0;
  private boundsFor = '';
  private redoArmedUntil = 0;
  private musicOn = false;
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
  private strike = new StrikeDetector();
  private shake = new ShakeMeter();
  private slide = new SlideTracker();
  private clopSide: 0 | 1 = 0;
  private lastSourceSync = 0;
  private slate = new Bubble(0.3);
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
    // the toy theatre stands behind the table
    const base = import.meta.env.BASE_URL;
    this.serial = new Serial(`${base}serial/`, `${base}models/screen_frame.glb`, {
      onState: (s) => this.onSerialState(s),
      onWaiting: (w) => {
        this.wanted = w;
        this.wantedPulse = 0;
      },
      // the stage's own sounds come from the stage; the audience's from behind the player's seat
      onStage: (cue) => (HOUSE_SOUNDS.has(cue) ? sound.playStage(cue, cue === 'applause' ? 0.9 : 0.55, 'house') : sound.playStage(cue)),
      onScale: (big) => {
        this.stage.setTheatreBig(big);
        this.stage.setTileLabel('size', big ? 'Stage small' : 'Stage big');
        console.log('STAGE size', big ? 'wall' : 'desk');
      },
      onNote: (note) => console.log('DIRECTOR note', note), // the theatre shows it on a card before the reel
    });
    this.serial.theatre.setSize(THEATRE_SMALL);
    this.stage.theatreMount.add(this.serial.theatre.group);
    this.serial.theatre.setDesk(this.stage.desk, DESK_ROUTE); // the film can spill onto the player's own desk
    // drawn first and behind everything, so it darkens only what is not ours: the room
    this.house = new Mesh(
      new SphereGeometry(7, 24, 14),
      new MeshBasicMaterial({ color: 0x06050b, transparent: true, opacity: 0, side: BackSide, depthWrite: false, toneMapped: false }),
    );
    this.house.name = 'house-lights';
    this.house.renderOrder = -1000;
    this.house.frustumCulled = false;
    this.stage.root.add(this.house);
    const serial = this.serial;
    void serial
      .init()
      .then(() => {
        // (a test or capture run may ask for one of the written reels instead of reel one)
        const want = startReel();
        if (want === 'finale') return serial.previewReel(REEL_1_FINALE).then(() => console.log('SERIAL starts on the end of reel one'));
        const plan = want ? (WRITTEN as Record<string, ReelPlan | undefined>)[want] : undefined;
        if (plan) return serial.preview(plan).then((ok) => console.log('SERIAL starts on the written reel for', want, ok ? '' : '(it did not stage)'));
      })
      .catch((e) => console.warn('SERIAL init failed', e instanceof Error ? e.message : e));
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
        void this.rollSerial(true);
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanupFuncs.push(() => window.removeEventListener('keydown', onKey));
    // the slate stands over the clapper it talks about, clear of the props
    this.slate.group.position.set(-0.27, TABLE_H + 0.15, 0.09);
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
          h.addComponent(RayInteractable); // (an open hand's pat is read from the fingertip itself: see trackTouches)
          this.entityPiece.set(h, piece.id);
        }
      } else {
        e.addComponent(RayInteractable);
      }
    }
    this.api = { serial: () => this.serial };
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
        // the system menu came up or the headset left the face: the sound holds too, and the frame-rate watch starts afresh
        const away = v === VisibilityState.VisibleBlurred || v === VisibilityState.Hidden;
        const wasAway = lastVis === VisibilityState.VisibleBlurred || lastVis === VisibilityState.Hidden;
        if (away !== wasAway) {
          this.slowFor = 0;
          this.frameAvg = 1 / 72;
          if (away) {
            sound.stopHeld();
            sound.setMusic(false);
          } else {
            // back on the face: a headset may have put the audio graph to sleep with the display
            void sound.ensureAudio();
            if (this.musicOn) sound.setMusic(true);
          }
        }
        lastVis = v;
      }),
    );
    if (this.capture) {
      sound.setSoundTrace((type, key, gain) => console.log('SND', this.showClock.toFixed(3), type, key, gain.toFixed(2)));
      console.log('CAPTURE on: one drawn frame is 1/30 s of the show');
      // the story's own log lines, stamped with the show's clock, so a film can be cut on what happened in it
      const plain = console.log.bind(console);
      console.log = (...a: unknown[]) => {
        plain(...a);
        if (typeof a[0] === 'string' && /^(WAIT|CUE|TITLE|REEL|PITCH|SET|STAGE size|NUDGE|DIRECTOR|VOICE)\b/.test(a[0])) plain('EVT', this.showClock.toFixed(3), a.map(String).join(' '));
      };
      // the recorder asks where the show clock stands when it starts, to lay the soundtrack under the right frame
      // (and where the figure out on the desk stands, so a filmed finger can go near it)
      (window as unknown as { __capture: unknown }).__capture = {
        clock: () => this.showClock,
        frame: () => this.frameNo,
        figure: () => {
          const p = this.serial?.theatre.deskFigureAt(new Vector3());
          return p ? { x: p.x, y: p.y, z: p.z } : null;
        },
      };
    }
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
    // a session begun from the browser's own button has had no gesture on the page, and a fingertip's touch is not
    // one: the first pinch is (which of these events counts as the gesture is the browser's choice, so all of them ask)
    const free = (): void => {
      if (sound.audioContext()?.state === 'running') return;
      this.lockedPinches++;
      void sound.ensureAudio().then(() => this.checkSound(true));
    };
    for (const type of ['selectstart', 'select', 'selectend', 'squeezestart', 'squeeze'] as const) session.addEventListener(type, free);
    void sound.ensureAudio().then(() => this.checkSound());
    // a gaze source may appear a moment after the session starts
    session.addEventListener('inputsourceschange', () => {
      if (this.placed) this.fitView();
    });
  }

  /**
   * In the headset, is the sound running? When it is not (the browser wants a gesture first), the slate asks for the
   * one gesture a headset counts: a pinch. Nothing waits for it: a tapped clapper still rolls the reel.
   */
  private checkSound(again = false): void {
    const ctx = sound.audioContext();
    const locked = !!ctx && ctx.state !== 'running' && this.world.visibilityState.value !== VisibilityState.NonImmersive;
    if (locked === this.soundLocked && !(locked && again)) return;
    if (locked !== this.soundLocked) console.log(locked ? 'AUDIO locked: waiting for a pinch' : 'AUDIO free');
    this.soundLocked = locked;
    const serial = this.serial;
    if (serial.state !== 'playing') this.onSerialState(serial.state);
    else if (!locked) this.slate.hide();
    else this.slate.say('No sound yet', this.soundHint(), 0);
  }

  /** What frees the sound: a pinch; and where pinches have not done it, the button on the page. */
  private soundHint(): string {
    return this.lockedPinches >= 3 ? 'Leave the headset view and press Enter on the page' : 'Pinch once to turn the sound on';
  }

  /** The slate at the table's edge says what the clapper will do next. */
  private onSerialState(s: SerialState): void {
    const serial = this.serial;
    serial.filmed = this.capture;
    // with a microphone allowed, the pitch card says a pitch can be spoken
    serial.pitchFooter = voice.voiceWanted() ? 'Make its sound, or hold the megaphone and say anything' : 'Make its sound to choose';
    if (s === 'ready') {
      this.slate.say(`Reel ${serial.reelNumber}: ${serial.reel.title}`, this.soundLocked ? 'Point at the clapper and pinch: a pinch turns the sound on' : 'Tap the clapper, or point at it and pinch', 0);
      // the marquee before the first reel: what this is and the one thing to do
      if (serial.resuming) {
        this.slate.say('Welcome back', this.soundLocked ? 'Point at the clapper and pinch to go on: a pinch turns the sound on' : 'Tap the clapper to go on. Redo starts the serial again.', 0);
        serial.theatre.showCard('Previously…', serial.previously || 'The story goes on.');
      } else if (serial.reelNumber === 1) serial.theatre.showCard('Coconuts: the Serial', 'You make every sound. Tap a prop, then tap the clapper.');
    }
    else if (s === 'playing') {
      if (this.soundLocked) this.slate.say('No sound yet', this.soundHint(), 0);
      else this.slate.hide();
      this.stage.setTileLabel('pause', 'Pause');
      this.musicOn = true;
      sound.setMusic(true); // the house pianist plays from the first reel on
    }
    else if (s === 'pitch') {
      const st = serial.last;
      this.slate.say(st ? `${st.hits} of ${st.asked} sounds landed` : 'End of the reel', 'Make a sound to choose what happens next', 0);
    } else if (s === 'writing') this.slate.say('The Director is writing…', 'The next reel rolls by itself', 0);
  }

  /**
   * The clapper in the Serial rolls the reel that is ready. During a reel it does nothing in the headset (a hand
   * brushing it must not stop the show: the pause tile is for that); on the page the space bar pauses and resumes.
   */
  private async rollSerial(fromKey = false): Promise<void> {
    const serial = this.serial;
    if (serial.state === 'playing') {
      if (fromKey) this.pauseSerial();
      return;
    }
    await sound.ensureAudio();
    sound.clapperSnap();
    this.stage.snapClapper();
    await serial.roll();
  }

  private pauseSerial(): void {
    const serial = this.serial;
    if (serial.state !== 'playing') return;
    const paused = serial.togglePause();
    this.stage.setTileLabel('pause', paused ? 'Resume' : 'Pause');
    this.musicOn = !paused;
    sound.setMusic(!paused);
    console.log(paused ? 'REEL pause' : 'REEL resume');
  }

  private onTile(id: string): void {
    if (id === 'tile-volume') {
      this.volumeStep = (this.volumeStep + 1) % VOLUME_STEPS.length;
      sound.setMasterVolume(VOLUME_STEPS[this.volumeStep]);
      this.stage.setTileLabel('volume', VOLUME_STEPS[this.volumeStep] === 0 ? 'Muted' : `Vol ${Math.round(VOLUME_STEPS[this.volumeStep] * 100)}`);
      console.log('VOLUME', VOLUME_STEPS[this.volumeStep]);
    } else if (id === 'tile-size') {
      if (this.narrowView) this.slate.say('The stage stays on the desk here', 'This display is too narrow for the wall', 4);
      else this.serial.theatre.grow(!this.serial.theatre.isBig);
    } else if (id === 'tile-pause') this.pauseSerial();
    else if (id === 'tile-redo') {
      const over = this.serial.state === 'ready' && this.serial.resuming;
      const again = this.serial.state === 'playing' || this.serial.state === 'pitch';
      if (!over && !again) return;
      // starting again throws the reel away: a tile brushed by a sleeve must not do that, so it asks twice
      if (performance.now() > this.redoArmedUntil) {
        this.redoArmedUntil = performance.now() + 4000;
        this.slate.say(over ? 'Start the serial again?' : 'Start this reel again?', 'Tap Redo once more', 4);
        return;
      }
      this.redoArmedUntil = 0;
      this.slate.hide();
      if (over) {
        console.log('SERIAL start over');
        void this.serial.startOver();
      } else {
        console.log('REEL redo');
        void this.serial.restart();
      }
    }
  }

  private onPressStart(id: string, entity?: Entity, touch = false): void {
    // the pinch that has just picked a prop up may also have had its ray on something else: that is not a press
    if (!touch && this.patClock - this.grabbedAt < 0.12 && !this.held.has(id)) return;
    if (id === 'clapper') {
      console.log('PICK clapper', this.serial.state);
      void this.rollSerial();
      return;
    }
    if (id.startsWith('tile-')) {
      this.onTile(id);
      return;
    }
    if (id === 'megaphone') {
      this.megaphoneDown();
      return;
    }
    const prop = id as PropId;
    void sound.ensureAudio();
    if (GRABBABLE.includes(prop) && !touch) {
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
    if (prop === 'door') return; // a pinched door fires on release: a short press knocks, a held press slams (a touched one: see touchStart)
    this.hit({ t: 0, prop, kind: ONE_SHOT[prop], v: 1, hand: 'right' });
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
      // out of sight: what it holds hangs where it was for a moment (trackHeld lets it go if the hand stays away)
      if (!this.handSeen[hand]) continue;
      if (s.start && this.pinchHeld[hand] === null) {
        // only a pinch right beside a prop picks it up (the props stand a hand's width apart)
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
    this.grabbedAt = this.patClock;
    this.lostFor[hand] = 0;
    this.returning.delete(prop);
    this.strike.reset();
    this.shake.reset();
    this.slide.reset();
    this.lastY.delete(prop);
    console.log('GRAB', prop, hand);
  }

  private endHold(prop: PropId, lost = false): void {
    const h = this.held.get(prop);
    if (!h) return;
    this.held.delete(prop);
    console.log('RELEASE', prop, lost ? '(the hand went out of sight)' : '');
    if (prop === 'thunder') sound.rumbleStop();
    if (prop === 'whistle') sound.whistleStop();
    if (prop === 'glass' && !lost) {
      const piece = this.stage.pieces.get('glass');
      if (piece) {
        const tableTop = this.stage.table.getWorldPosition(tmpU).y + TABLE_H;
        const hgt = piece.root.getWorldPosition(tmpP).y - tableTop;
        const vy = this.lastVy.get('glass') ?? 0;
        if (isDrop(hgt, -vy)) this.hit({ t: 0, prop: 'glass', kind: 'crash', v: Math.min(1, 0.5 + hgt * 2) });
      }
    }
    this.lastY.delete(prop);
    this.returning.set(prop, 0);
  }

  /** The megaphone is held: between reels, with a microphone, the player says what happens next. */
  private megaphoneDown(): void {
    const serial = this.serial;
    this.stage.flash('megaphone', 1);
    if (serial.state !== 'pitch') {
      this.slate.say('The megaphone is for between reels', 'Hold it then, and say what happens next', 4);
      return;
    }
    if (!voice.voiceWanted()) {
      // not allowed on the page. The headset view is no place for the browser's question (it would cover the show), so
      // the microphone is taken up here only when the permission already stands and the player has not said no
      void voice
        .micAllowed()
        .then((ok) => (ok ? voice.enableVoice(4000) : false))
        .then((ok) => serial.pitchNote(ok ? 'Hold the megaphone and say what happens next' : 'The microphone is allowed on the page, before the headset. Make a sound to choose.'));
      return;
    }
    void voice.startListening(6000, () => void this.megaphoneUp()).then((ok) => {
      if (ok === true) {
        serial.pitchNote('Listening… say what happens next, then let go');
        console.log('VOICE listening');
      } else if (ok === 'off') serial.pitchNote('Hold the megaphone while you speak');
      else if (serial.state === 'pitch') serial.pitchNote('No microphone just now. Make a sound to choose.');
    });
  }

  private async megaphoneUp(): Promise<void> {
    const serial = this.serial;
    if (!voice.listening()) return;
    const blob = await voice.stopListening();
    if (!blob) {
      if (serial.state === 'pitch') serial.pitchNote('Not heard. Hold the megaphone and speak, or make a sound.');
      return;
    }
    serial.pitchNote('The Director is listening…');
    const text = await serial.realTime(voice.transcribe(blob));
    if (serial.state !== 'pitch') return; // a prop chose in the meantime
    if (text) {
      console.log('VOICE heard', text.split(' ').length, 'words');
      void serial.choose({ text, spoken: true });
    } else {
      console.log('VOICE not heard');
      serial.pitchNote('Not heard. Make a sound to choose.');
    }
  }

  private onPressEnd(id: string, heldMs: number): void {
    if (id === 'megaphone') {
      void this.megaphoneUp();
      return;
    }
    if (this.held.has(id)) return; // a held prop is let go by the pinch opening, not by the ray drifting off
    if (id !== 'door') return;
    const slam = heldMs >= SLAM_HOLD_MS;
    this.stage.swingDoor(slam ? 1 : 0.35);
    this.hit({ t: 0, prop: 'door', kind: slam ? 'slam' : 'knock', v: slam ? 1 : 0.8, hand: 'right' });
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
    console.log('HIT', hit.prop, hit.kind, hit.t.toFixed(2), hit.v.toFixed(2));
    this.serial.sound(hit.prop, hit.kind, hit.v);
  }

  /** The piece's own shape (what can be seen of it), as a box in its own space: what a fingertip touches. */
  private shapeOf(id: string): Box3 | null {
    // the models arrive after the primitives: measure again once they are in
    const key = this.stage.dressed ? 'dressed' : 'plain';
    if (this.boundsFor !== key) {
      this.boundsFor = key;
      this.touchBounds.clear();
    }
    let box = this.touchBounds.get(id);
    if (box) return box;
    const piece = this.stage.pieces.get(id);
    if (!piece) return null;
    box = new Box3();
    piece.root.updateWorldMatrix(true, true);
    tmpM.copy(piece.root.matrixWorld).invert();
    piece.root.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh || !m.visible || m.name.startsWith('hit') || m.name === 'lamp' || m.name === 'blob') return;
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      if (mat && mat.visible === false) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      if (!m.geometry.boundingBox) return;
      tmpBox.copy(m.geometry.boundingBox).applyMatrix4(tmpM2.multiplyMatrices(tmpM, m.matrixWorld));
      box!.union(tmpBox);
    });
    if (box.isEmpty()) return null;
    this.touchBounds.set(id, box);
    if (automationRun()) console.log('SHAPE', id, box.min.toArray().map((v) => v.toFixed(3)).join(','), box.max.toArray().map((v) => v.toFixed(3)).join(','));
    return box;
  }

  /**
   * An open hand's pat: the fingertip on a piece's own shape. (The SDK's touch pointer measures to the nearest
   * surface of anything in the piece, hit boxes included, so a finger passing through a box fires on the way in
   * and again on the way out; here a touch begins once, when the fingertip reaches the thing itself, and ends
   * when it is clearly off it.) A hand that only rests or drifts there does not count.
   */
  /**
   * Which hands have a pose this frame. A hand that goes out of sight keeps its last place in the SDK's spaces (it
   * does not go home to the origin), so the place alone cannot say: the frame is asked for the fingertip itself.
   */
  private seeHands(inXR: boolean): void {
    const xr = this.world.renderer.xr;
    const frame = inXR ? (xr.getFrame() as XRFrame | null) : null;
    const ref = inXR ? xr.getReferenceSpace() : null;
    for (const hand of HANDS) {
      this.pinchPoint(hand, tmpP);
      let seen = inXR && tmpP.lengthSq() > 1e-8; // (a hand never seen yet sits at the origin)
      if (seen && frame && ref) {
        try {
          const src = this.input.xr.getPrimaryInputSource(hand);
          const tip = src?.hand?.get('index-finger-tip');
          if (!src) seen = false;
          else if (tip) seen = !!frame.getJointPose?.(tip, ref);
          else seen = !!frame.getPose(src.gripSpace ?? src.targetRaySpace, ref);
        } catch {
          // a runtime that will not say: the place is all there is to go on
        }
      }
      this.handSeen[hand] = seen;
    }
  }

  private trackTouches(inXR: boolean): void {
    for (const hand of HANDS) {
      const cur = this.touching[hand];
      this.pinchPoint(hand, tmpP);
      const tracked = inXR && this.handSeen[hand];
      const s = this.input.xr.getSelectState(hand);
      const pinching = s.active || s.start;
      let on: string | null = null;
      let depth = Infinity;
      if (tracked) {
        let best = Infinity;
        for (const piece of this.stage.pieces.values()) {
          if (this.held.has(piece.id)) continue;
          const box = this.shapeOf(piece.id);
          if (!box) continue;
          const d = depthIn(box, piece.root.worldToLocal(tmpU.copy(tmpP)));
          const mine = cur?.id === piece.id;
          if (d <= (mine ? TOUCH_OUT : TOUCH_IN) && (mine ? -Infinity : d) < best) {
            best = mine ? -Infinity : d; // what is already touched stays touched until the finger is clear of it
            on = piece.id;
            depth = d;
          }
        }
      }
      if (cur && on === cur.id) {
        // still on the piece it touched: its stroke is followed down, back up, and down again
        const gate = this.pats[hand];
        const did = cur.feed(depth, this.patClock, pinching, gate.arrival(), gate.speed, () => automationRun() || this.patFilterOff || gate.deliberate());
        if (did === 'pat') this.pat(cur.id, hand);
        else if (did === 'lift') this.touchEnd(cur.id);
        continue;
      }
      if (cur?.live && !cur.lifted) this.touchEnd(cur.id);
      if (!on) {
        this.touching[hand] = null;
        continue;
      }
      // a pinching hand is picking something up or pressing from afar; a hand that only rests or drifts is not patting
      const live = !pinching && (automationRun() || this.patFilterOff || this.pats[hand].deliberate());
      this.touching[hand] = new Stroke(on, depth, live);
      if (live) this.pat(on, hand);
      else if (!pinching) {
        console.log('TOUCH ignored (a resting hand)', on);
        // (five refusals and not one touch taken yet: on this headset the filter is wrong about hands, so it steps aside)
        if (++this.patsRefused >= 5 && this.patsTaken === 0) {
          this.patFilterOff = true;
          console.log('TOUCH filter off: it had refused every touch');
        }
      }
    }
  }

  /** A touch that counts: it sounds now, or (the props a hand also picks up) in a moment, unless a pinch closes first. */
  private pat(id: string, hand: Hand): void {
    this.patsTaken++;
    if (PAT_WAITS.has(id)) this.pendingPat[hand] = { id, at: this.patClock };
    else this.touchStart(id, hand);
  }

  /**
   * A hand reaching in to pick up the thunder sheet, the whistle or the bag of glass touches it a moment before its
   * pinch closes: those three wait a tenth of a second, and a pinch in that time is a pick-up, not a pat. (The
   * coconuts are drummed in rhythm: they answer at once.)
   */
  private firePendingPats(time: number): void {
    for (const hand of HANDS) {
      const p = this.pendingPat[hand];
      if (!p) continue;
      const s = this.input.xr.getSelectState(hand);
      if (s.active || s.start || this.held.has(p.id)) this.pendingPat[hand] = null;
      else if (time - p.at >= PAT_WAIT_S) {
        this.pendingPat[hand] = null;
        this.touchStart(p.id, hand);
      }
    }
  }

  private touchStart(id: string, hand: Hand): void {
    if (id === 'door') {
      // a touched door answers at once: a rap knocks, a hard hit slams
      void sound.ensureAudio();
      const slam = this.pats[hand].arrival() > SLAM_SPEED;
      this.stage.swingDoor(slam ? 1 : 0.35);
      this.hit({ t: 0, prop: 'door', kind: slam ? 'slam' : 'knock', v: slam ? 1 : 0.8, hand });
      return;
    }
    this.onPressStart(id, undefined, true);
  }

  private touchEnd(id: string): void {
    if (id === 'megaphone') void this.megaphoneUp();
  }

  /** Presses are tracked per frame so the door can tell a tap from a hold. */
  private trackPressed(): void {
    const now = this.pressNext;
    now.clear();
    // a press is timed on the show's clock (in a capture run a second of the show takes many real ones)
    const t = this.capture ? this.showClock * 1000 : performance.now();
    for (const e of this.queries.pressed.entities) {
      const id = this.entityPiece.get(e);
      if (!id) continue;
      now.add(id);
      if (!this.lastPressed.has(id)) {
        this.pressStarted.set(id, t);
        this.onPressStart(id, e);
      }
    }
    for (const id of this.lastPressed) {
      if (now.has(id)) continue;
      const started = this.pressStarted.get(id) ?? t;
      this.onPressEnd(id, t - started);
    }
    this.pressNext = this.lastPressed;
    this.lastPressed = now;
  }

  /** Held props follow the pinching hand; their motion makes the sound: coconuts strike, thunder shakes, whistle slides. */
  private trackHeld(now: number, dt: number): void {
    for (const [id, h] of this.held) {
      const piece = this.stage.pieces.get(id);
      if (!piece) continue;
      if (!this.handSeen[h.hand]) {
        // out of sight (one hand over the other, a hand in the lap): the prop hangs where it was for a moment, and
        // is then let go without the sound a real let-go would make
        if ((this.lostFor[h.hand] += dt) > LOST_HOLD_S) {
          this.pinchHeld[h.hand] = null;
          this.endHold(id as PropId, true);
        }
        continue;
      }
      if (this.lostFor[h.hand] > 0) {
        // back in sight, perhaps somewhere else: the jump is not a strike or a shake
        this.lostFor[h.hand] = 0;
        this.strike.reset();
        this.shake.reset();
        this.lastY.delete(id);
      }
      this.pinchPoint(h.hand, tmpP);
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
            this.hit({ t: 0, prop: 'coconuts', kind: 'clop', v, hand: this.clopSide ? 'left' : 'right' });
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
            const ev: HitEvent = { t: 0, prop: 'thunder', kind: 'rumble', v: level };
            console.log('HIT thunder rumble', ev.t.toFixed(2), level.toFixed(2));
            this.serial.sound('thunder', 'rumble', level);
          }
          break;
        }
        case 'whistle': {
          const pitch = this.slide.feed(pos.y);
          sound.whistleSet(pitch);
          this.stage.setWhistleSlide(pitch);
          if (now - (this.lastWhistleMark ?? -1) > 0.4) {
            this.lastWhistleMark = now;
            const ev: HitEvent = { t: 0, prop: 'whistle', kind: 'whistle', v: pitch };
            console.log('HIT whistle slide', ev.t.toFixed(2), pitch.toFixed(2));
            // the stage hears the held whistle about once a second, not at every mark
            if (now - this.lastWhistleToStage > 0.9) {
              this.lastWhistleToStage = now;
              this.serial.sound('whistle', 'whistle', pitch);
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
      this.serial.theatre.warm();
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
    this.placedEye.copy(tmpP);
    this.placedFwd.set(tmpF.x, 0, tmpF.z);
    if (this.placedFwd.lengthSq() < 1e-4) this.placedFwd.set(0, 0, -1);
    this.placedFwd.normalize();
    this.movedFor = 0;
    this.placed = true;
    this.serial.theatre.warm(); // the headset's programs are its own (stereo): build them now, behind the curtain
    this.fitView();
    console.log('STAGE placed', this.stage.root.position.toArray().map((v) => +v.toFixed(3)).join(','), 'yaw', +this.stage.root.rotation.y.toFixed(2), 'xr');
  }

  reposition(): void {
    this.placed = false;
    this.placeTimer = 0;
  }

  /**
   * A display with a narrow field of view (Meta VR Glasses) cannot hold a stage the size of a wall: there the
   * theatre stays the toy on the desk, which fits the view whole.
   */
  private fitView(): void {
    const serial = this.serial;
    const eye = this.world.renderer.xr.getCamera().cameras[0];
    const m = eye?.projectionMatrix.elements;
    if (!m || !(m[0] > 0)) return;
    const fov = (2 * Math.atan(1 / m[0]) * 180) / Math.PI;
    // the glasses aim by gaze; the emulator masks their view without narrowing its projection, so the gaze source is the tell there
    let gaze = false;
    for (const src of this.world.session?.inputSources ?? []) if (src.targetRayMode === 'gaze') gaze = true;
    this.narrowView = fov < 80 || gaze;
    if (this.narrowView) {
      serial.theatre.allowBig = false;
      if (serial.theatre.isBig) serial.theatre.grow(false);
    }
    console.log('VIEW field of view', fov.toFixed(0), 'degrees across', gaze ? 'gaze' : '', this.narrowView ? '(narrow: the stage stays desk size)' : '');
  }

  /**
   * People press Enter standing and then sit down: when the head has settled well away from where the stage was
   * placed for (a different height, or another seat), the stage is placed again. Leaning in to reach a prop is not that.
   * The same watch sends a wall-size stage back to the desk for good when the headset cannot keep its frame rate.
   */
  private watchSeat(dt: number): void {
    const head: Object3D = this.player.head;
    head.getWorldPosition(tmpP);
    const dy = Math.abs(tmpP.y - this.placedEye.y);
    const dxz = Math.hypot(tmpP.x - this.placedEye.x, tmpP.z - this.placedEye.z);
    // (leaning in over the table to watch what runs across it brings the head forward and down: that is not a new seat)
    const toward = (tmpP.x - this.placedEye.x) * this.placedFwd.x + (tmpP.z - this.placedEye.z) * this.placedFwd.z;
    const away = tmpP.y > 0.3 && (dy > 0.28 || dxz > 0.9) && toward < 0.1 && this.held.size === 0;
    this.movedFor = away ? this.movedFor + dt : 0;
    if (this.movedFor > 1.6) {
      console.log('STAGE placing again: the seat moved', dy.toFixed(2), dxz.toFixed(2));
      this.reposition();
      this.placeTimer = 1; // the pose is already tracked: no need to wait for it to settle again
    }
    // only while the player is really looking: under the system menu the headset draws the page a few times a second
    if (!automationRun() && this.world.visibilityState.value === VisibilityState.Visible) {
      const t = this.serial.theatre;
      const big = this.stage.theatreBig;
      if (!big) this.frameAvg = 1 / 72;
      else this.frameAvg += (Math.min(dt, 0.1) - this.frameAvg) * 0.04;
      this.bigFor = big ? this.bigFor + dt : 0;
      const slow = big && this.bigFor > 3 && this.frameAvg > 0.024; // under about 42 frames a second, past the first moments
      this.slowFor = slow ? this.slowFor + dt : 0;
      if (this.slowFor > 3) {
        this.slowFor = 0;
        this.frameAvg = 1 / 72;
        if (t.fx && !this.fxDropped) {
          // the weather goes first: rain and mist cost more than they are worth on a headset that struggles
          this.fxDropped = true;
          t.fx.dispose();
          t.fx = null;
          this.bigFor = 0;
          console.log('STAGE effects off: the frame rate fell at wall size');
        } else {
          t.allowBig = false;
          this.bigLockedAt = performance.now();
          t.grow(false);
          console.log('STAGE kept at desk size: the frame rate fell at wall size');
        }
      }
      // not for ever: a minute on, the next thunder may try the wall again
      if (!t.allowBig && !this.narrowView && performance.now() - this.bigLockedAt > 60000) t.allowBig = true;
    }
  }

  /** The page's camera: the stage framed into the rectangle the page keeps for it (see frameSerial). */
  private frameBrowserCamera(): void {
    const cam = this.world.camera;
    frameSerial(cam, window.innerWidth > 900);
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
      // the clapper's snap comes from the 'director' source, which has always stood at the world's origin here
      sound.placeSource('director', tmpP.set(0, 0, 0));
      sound.placeSource('stage', this.stage.theatreMount.getWorldPosition(tmpP));
      // the house: a metre and a half behind where the player sits, facing the stage with them
      this.stage.root.getWorldPosition(tmpU);
      tmpF.set(this.placedEye.x - tmpP.x, 0, this.placedEye.z - tmpP.z);
      if (tmpF.lengthSq() < 1e-6) tmpF.set(0, 0, 1);
      tmpF.normalize();
      sound.placeSource('house', tmpU.set(this.placedEye.x, Math.max(1, this.placedEye.y), this.placedEye.z).addScaledVector(tmpF, 1.5));
    }
  }

  update(dt: number, time: number): void {
    if (this.capture) {
      dt = 1 / 30;
      this.showClock += dt;
      if (this.frameNo++ % 30 === 0) console.log('FRAME', this.frameNo - 1, this.showClock.toFixed(3));
    } else dt = Math.min(dt, 0.1); // a headset put down and picked up again comes back as one enormous step: the show does not jump
    if (this.stage.dressed && !this.perfLogged) {
      this.perfLogged = true;
      const r = this.world.renderer.info.render;
      const s = modelStats();
      console.log('PERF calls', r.calls, 'triangles', r.triangles, 'models', `${s.loaded}/${s.loaded + s.failed}`);
    }
    if (!this.placed) this.placeStage(dt);
    // nothing is shown before it stands where the player sits (or it would lie round their feet for a moment)
    this.stage.root.visible = this.placed;
    const vis = this.world.visibilityState.value;
    const inXR = vis !== VisibilityState.NonImmersive;
    const away = vis === VisibilityState.VisibleBlurred || vis === VisibilityState.Hidden;
    if (inXR && this.placed) this.watchSeat(dt);
    this.patClock = time;
    this.seeHands(inXR);
    if (inXR) {
      for (const hand of HANDS) {
        if (!this.handSeen[hand]) this.pats[hand].reset(); // out of sight: where it turns up next says nothing of how it came
        else {
          this.pinchPoint(hand, tmpP);
          this.pats[hand].feed(time, tmpP.x, tmpP.y, tmpP.z);
        }
      }
      if (this.soundLocked && sound.audioContext()?.state === 'running') this.checkSound();
      // a finger that goes near the little figure out on the table: it notices
      if (this.serial) for (const hand of HANDS) if (this.handSeen[hand]) this.serial.theatre.poke(this.pinchPoint(hand, tmpP));
    }
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
    this.trackTouches(inXR);
    this.firePendingPats(time);
    this.trackHeld(time, dt);
    this.easeHome(dt);
    if (this.redoArmedUntil && performance.now() > this.redoArmedUntil) {
      this.redoArmedUntil = 0;
      this.onSerialState(this.serial.state); // the question went unanswered: the slate says again what it said
    }
    // under the system menu, or with the headset off the face, the reel holds its breath
    if (!away) this.serial.update(dt);
    // the theatre's size follows its mount (desk or wall)
    const size = this.stage.theatreSize;
    if (Math.abs(size - this.serial.theatre.scale) > 1e-4) {
      this.serial.theatre.setSize(size);
    }
    if (this.house) {
      // down with the curtain's rise, up again between reels; lightning on the stage lights the room for an instant
      const t = this.serial.theatre;
      // (the room stays present: it is the auditorium; and when somebody leaves the picture the house lights come up)
      const want = t.houseUp ? 0.07 : (0.24 + 0.34 * t.curtainLevel) * (1 - 0.85 * t.flashLevel);
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
        if (this.serial.state === 'pitch' && voice.voiceWanted()) this.stage.flash('megaphone', 0.85);
      }
    }
    const viewer: Object3D = inXR ? this.player.head : this.world.camera;
    this.slate.update(dt, viewer);
    this.syncAudioSpace(time);
    this.stage.update(dt);
  }
}
