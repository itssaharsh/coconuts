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
