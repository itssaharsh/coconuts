// Hand-motion detectors, written as pure classes so tests can feed them synthetic traces.

export interface Sample {
  t: number; // seconds
  x: number;
  y: number;
  z: number;
}

/**
 * Fires on each downward reversal of a held object: the hand moves down, then stops or comes back up.
 * That is a coconut shell meeting the other one, or a shoe meeting the ground.
 */
/**
 * The detectors below take speed from one sample to the next. They were tuned on samples about a thirtieth of a
 * second apart; a headset feeds them two or three times as often, and the same few millimetres of tracking jitter
 * would then read as two or three times the speed. Samples closer together than this are passed over.
 */
const MIN_STEP_S = 0.028;

export class StrikeDetector {
  private prev: Sample | null = null;
  private vy = 0;
  private minVy = 0;
  private lastFire = -Infinity;

  constructor(
    public threshold = 0.45, // m/s downward speed a strike must reach
    public refractory = 0.11, // s between strikes
  ) {}

  reset(): void {
    this.prev = null;
    this.vy = 0;
    this.minVy = 0;
  }

  /** Returns the strike strength 0..1 when a strike lands on this sample, else null. */
  feed(s: Sample): number | null {
    if (!this.prev) {
      this.prev = s;
      return null;
    }
    const dt = s.t - this.prev.t;
    if (dt < MIN_STEP_S) return null;
    const vyRaw = (s.y - this.prev.y) / dt;
    this.vy = this.vy * 0.4 + vyRaw * 0.6; // light smoothing against tracking jitter
    this.prev = s;
    let fired: number | null = null;
    if (this.vy < this.minVy) this.minVy = this.vy;
    const reversing = this.vy > this.minVy * 0.35; // speed has fallen to a third of the peak, or turned upward
    if (reversing && -this.minVy >= this.threshold && s.t - this.lastFire >= this.refractory) {
      fired = Math.min(1, (-this.minVy - this.threshold) / 1.2 + 0.35);
      this.lastFire = s.t;
      this.minVy = 0;
    }
    if (this.vy >= 0) this.minVy = Math.min(0, this.minVy * 0.5);
    return fired;
  }
}

/** Shake level 0..1 from the speed of a held object over a short window (the thunder sheet). */
export class ShakeMeter {
  private prev: Sample | null = null;
  private level = 0;

  constructor(
    public fullSpeed = 1.2, // m/s that counts as a full shake
    public release = 3.5, // 1/s decay
  ) {}

  reset(): void {
    this.prev = null;
    this.level = 0;
  }

  feed(s: Sample): number {
    if (!this.prev) {
      this.prev = s;
      return 0;
    }
    const dt = s.t - this.prev.t;
    if (dt < MIN_STEP_S) return this.level;
    const dx = s.x - this.prev.x;
    const dy = s.y - this.prev.y;
    const dz = s.z - this.prev.z;
    const speed = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
    this.prev = s;
    const target = Math.min(1, speed / this.fullSpeed);
    this.level = target > this.level ? this.level + (target - this.level) * 0.5 : this.level * Math.max(0, 1 - this.release * dt);
    return this.level;
  }

  get value(): number {
    return this.level;
  }
}

/** Pitch 0..1 from how far the hand has moved up (or along an axis) since the grab (the slide whistle). */
export class SlideTracker {
  private origin: number | null = null;

  constructor(public range = 0.18) {}

  reset(): void {
    this.origin = null;
  }

  feed(along: number): number {
    if (this.origin === null) this.origin = along - this.range * 0.4; // start a little above the bottom
    return Math.max(0, Math.min(1, (along - this.origin) / this.range));
  }
}

/** Was the thing let go high enough to crash, and fast enough to count as a drop rather than a put-down? */
export function isDrop(heightAboveTable: number, downwardSpeed: number): boolean {
  return heightAboveTable > 0.06 || downwardSpeed > 0.6;
}

/**
 * Tells a deliberate pat from a hand that only rests or drifts over the table. Hand tracking jitters by a few
 * millimetres and a tired hand sinks slowly: either can carry a fingertip into a prop. A pat is different: the
 * finger came from somewhere (it travelled) or it is moving fast right now (a drum roll with small lifts).
 * Feed it the fingertip's position every frame.
 */
export class PatGate {
  private readonly p: Float32Array;
  private readonly t: Float64Array;
  private head = 0;
  private count = 0;

  constructor(
    public travel = 0.025, // m the fingertip must have come in the last `window` seconds
    public window = 0.9,
    public speed = 0.2, // m/s that counts as a pat whatever the travel
    private size = 96, // (the window at 90 samples a second, and to spare)
  ) {
    this.p = new Float32Array(size * 3);
    this.t = new Float64Array(size);
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
  }

  feed(t: number, x: number, y: number, z: number): void {
    if (this.count > 0) {
      // a fingertip does not jump: a step this long in one sample is the tracking finding the hand again somewhere
      // else, and what came before says nothing about how it got here
      const j = (this.head - 1 + this.size) % this.size;
      const step = Math.hypot(x - this.p[j * 3], y - this.p[j * 3 + 1], z - this.p[j * 3 + 2]);
      const dt = t - this.t[j];
      if (step > 0.12 || (step > 0.06 && dt > 0 && step / dt > 8)) this.reset();
    }
    const i = this.head;
    this.p[i * 3] = x;
    this.p[i * 3 + 1] = y;
    this.p[i * 3 + 2] = z;
    this.t[i] = t;
    this.head = (i + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  /** How far the fingertip has come in the window, and how fast it was moving just now (m, m/s). */
  private measure(): { far: number; fast: number } {
    let far = 0;
    let fast = 0;
    if (this.count < 3) return { far, fast }; // a hand that has only just appeared here did not reach for anything
    const last = (this.head - 1 + this.size) % this.size;
    const now = this.t[last];
    const x = this.p[last * 3];
    const y = this.p[last * 3 + 1];
    const z = this.p[last * 3 + 2];
    for (let n = 1; n < this.count; n++) {
      const i = (last - n + this.size) % this.size;
      const age = now - this.t[i];
      if (age > this.window) break;
      const d = Math.hypot(x - this.p[i * 3], y - this.p[i * 3 + 1], z - this.p[i * 3 + 2]);
      if (d > far) far = d;
      // speed over a short stretch (long enough that jitter does not pass for motion)
      if (age >= 0.04 && age <= 0.12 && d / age > fast) fast = d / age;
    }
    return { far, fast };
  }

  /** True when the fingertip that was last fed came where it is on purpose. */
  deliberate(): boolean {
    const m = this.measure();
    return m.far >= this.travel || m.fast >= this.speed;
  }

  /** How fast the fingertip was moving as it arrived, m/s (a hard knock is a slam). */
  arrival(): number {
    return this.measure().fast;
  }
}

/** A fingertip this near a piece's own shape touches it (metres). */
export const TOUCH_IN = 0.012;
/**
 * A finger sinks a centimetre or three into a prop that is not there, and a drummer lifts no further than that
 * between pats. So a touch is followed as a stroke: once the finger has come this far back up out of it, the pat is
 * over, and from there this far down again is the next one, without the finger ever leaving the prop. (Three times
 * the few millimetres a tracked fingertip jitters by; a missed pat costs the player more than a doubled one.)
 */
export const TOUCH_LIFT = 0.015;
export const TOUCH_DROP = 0.01;
/** A return this soon after the lift is drumming and needs no other proof that it was meant. */
const DRUM_S = 1.2;

/**
 * One fingertip on one piece, from the moment it touches until it is clear of it. Feed it, every frame, how far the
 * fingertip is from the piece's shape: metres, negative inside (the depth under the nearest face).
 */
export class Stroke {
  /** The finger has come back up out of its stroke: its next way down is a new pat. */
  lifted = false;
  private deep: number;
  private high: number;
  private liftedAt = 0;

  /** `live`: the touch counted when it began (a creeping or resting finger's does not). */
  constructor(
    public readonly id: string,
    depth: number,
    public live: boolean,
  ) {
    this.deep = depth;
    this.high = depth;
  }

  /**
   * 'pat': the finger struck again, or a touch that had not counted now does. 'lift': a pat that counted is over.
   * `arrival` is the fingertip's speed just now (m/s), `fast` the speed that makes a pat of any touch, and `meant`
   * says whether a slow return should count (asked only then).
   */
  feed(depth: number, t: number, pinching: boolean, arrival: number, fast: number, meant: () => boolean): 'pat' | 'lift' | null {
    if (!this.lifted) {
      if (depth < this.deep) this.deep = depth;
      if (!this.live && !pinching && this.high - depth >= 0.01 && arrival >= fast) {
        // it crept in and did not count; now it presses on in earnest: a pat after all
        this.live = true;
        return 'pat';
      }
      if (depth - this.deep >= TOUCH_LIFT) {
        // up out of the stroke: the pat is over, and the next way down is a new one
        const was = this.live;
        this.lifted = true;
        this.high = depth;
        this.liftedAt = t;
        return was ? 'lift' : null;
      }
      return null;
    }
    if (depth > this.high) this.high = depth;
    if (pinching || depth > TOUCH_IN || this.high - depth < TOUCH_DROP) return null;
    // down again: a quick return is drumming; a slow one has to be as deliberate as a first touch
    this.live = t - this.liftedAt < DRUM_S || meant();
    this.lifted = false;
    this.deep = depth;
    this.high = depth;
    return this.live ? 'pat' : null;
  }
}
