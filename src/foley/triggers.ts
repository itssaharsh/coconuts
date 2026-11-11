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
    if (dt <= 0) return null;
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
    const dt = Math.max(1e-3, s.t - this.prev.t);
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
    public travel = 0.03, // m the fingertip must have come in the last `window` seconds
    public window = 0.7,
    public speed = 0.2, // m/s that counts as a pat whatever the travel
    private size = 64,
  ) {
    this.p = new Float32Array(size * 3);
    this.t = new Float64Array(size);
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
  }

  feed(t: number, x: number, y: number, z: number): void {
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
