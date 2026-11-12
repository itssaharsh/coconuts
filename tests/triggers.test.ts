import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { PatGate, ShakeMeter, SlideTracker, StrikeDetector, Stroke, TOUCH_IN, besideBy, depthIn, depthPast, entryFace, isDrop, type Sample } from '../src/foley/triggers';

function trace(fn: (t: number) => { x?: number; y: number; z?: number }, seconds: number, hz = 72): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i <= seconds * hz; i++) {
    const t = i / hz;
    const p = fn(t);
    out.push({ t, x: p.x ?? 0, y: p.y, z: p.z ?? 0 });
  }
  return out;
}

describe('StrikeDetector (coconuts)', () => {
  it('fires once per downstroke of a 3 Hz shake and never while still', () => {
    const d = new StrikeDetector();
    const shaking = trace((t) => ({ y: 1 + 0.06 * Math.sin(2 * Math.PI * 3 * t) }), 2);
    const hits = shaking.map((s) => d.feed(s)).filter((v): v is number => v !== null);
    expect(hits.length).toBeGreaterThanOrEqual(5);
    expect(hits.length).toBeLessThanOrEqual(7);
    for (const h of hits) expect(h).toBeGreaterThan(0);
    d.reset();
    const still = trace((t) => ({ y: 1 + 0.001 * Math.sin(t) }), 2);
    expect(still.map((s) => d.feed(s)).filter((v) => v !== null)).toHaveLength(0);
  });

  it('ignores a slow drift and tracking jitter', () => {
    const d = new StrikeDetector();
    const drift = trace((t) => ({ y: 1 - 0.1 * t + 0.002 * ((t * 97) % 1) }), 2);
    expect(drift.map((s) => d.feed(s)).filter((v) => v !== null)).toHaveLength(0);
  });

  it('a harder strike reports more strength', () => {
    const soft = new StrikeDetector();
    const hard = new StrikeDetector();
    const s1 = trace((t) => ({ y: 1 + 0.04 * Math.sin(2 * Math.PI * 2.5 * t) }), 1).map((s) => soft.feed(s)).filter((v): v is number => v !== null);
    const s2 = trace((t) => ({ y: 1 + 0.12 * Math.sin(2 * Math.PI * 2.5 * t) }), 1).map((s) => hard.feed(s)).filter((v): v is number => v !== null);
    expect(Math.max(...s2)).toBeGreaterThan(Math.max(...s1));
  });
});

describe('ShakeMeter (thunder sheet)', () => {
  it('rises while shaking and falls when still', () => {
    const m = new ShakeMeter();
    const levels = trace((t) => ({ x: 0.05 * Math.sin(2 * Math.PI * 4 * t), y: 1 }), 1).map((s) => m.feed(s));
    expect(Math.max(...levels)).toBeGreaterThan(0.5);
    const after = trace((t) => ({ x: 0, y: 1, z: 0 }), 1, 72).map((s, i) => m.feed({ ...s, t: 1 + i / 72 }));
    expect(after[after.length - 1]).toBeLessThan(0.05);
  });
});

describe('SlideTracker (whistle)', () => {
  it('maps the pull to 0..1 from where the grab started', () => {
    const s = new SlideTracker(0.2);
    const first = s.feed(1.0);
    expect(first).toBeCloseTo(0.4, 1);
    expect(s.feed(1.12)).toBeGreaterThan(first);
    expect(s.feed(2)).toBe(1);
    expect(s.feed(-2)).toBe(0);
  });
});

describe('isDrop (bag of glass)', () => {
  it('counts a release from height or at speed, not a gentle put-down', () => {
    expect(isDrop(0.1, 0)).toBe(true);
    expect(isDrop(0.02, 1.0)).toBe(true);
    expect(isDrop(0.02, 0.1)).toBe(false);
  });
});

describe('PatGate: a pat is deliberate, a resting hand is not', () => {
  const FRAME = 1 / 72;
  const feedFor = (g: PatGate, t0: number, secs: number, at: (t: number) => [number, number, number]): number => {
    let t = t0;
    for (; t < t0 + secs; t += FRAME) g.feed(t, ...at(t - t0));
    return t;
  };
  // a few millimetres of tracking jitter, the same every run
  const jitter = (t: number): number => 0.003 * Math.sin(t * 173.1) + 0.002 * Math.sin(t * 61.7);

  it('a hand that rests over a prop, jittering, never counts', () => {
    const g = new PatGate();
    feedFor(g, 0, 3, (t) => [0.1 + jitter(t), 0.8 + jitter(t + 1), -0.4 + jitter(t + 2)]);
    expect(g.deliberate()).toBe(false);
  });

  it('a hand that sinks slowly onto a prop (2 cm a second) does not count', () => {
    const g = new PatGate();
    feedFor(g, 0, 2, (t) => [0.1 + jitter(t), 0.84 - 0.02 * t + jitter(t + 1), -0.4]);
    expect(g.deliberate()).toBe(false);
  });

  it('a reach from above counts, even an unhurried one (10 cm in half a second)', () => {
    const g = new PatGate();
    const t = feedFor(g, 0, 1, () => [0.1, 0.9, -0.4]);
    feedFor(g, t, 0.5, (dt) => [0.1, 0.9 - 0.2 * dt, -0.4]);
    expect(g.deliberate()).toBe(true);
  });

  it('a drum roll with small lifts counts by its speed (2 cm strokes, 6 a second)', () => {
    const g = new PatGate();
    // the fingertip bobs 2 cm at 6 Hz; the press lands at the bottom of a stroke, 2 cm below where it was 80 ms before
    feedFor(g, 0, 1.075, (t) => [0.1, 0.8 + 0.01 * Math.cos(2 * Math.PI * 6 * t), -0.4]);
    expect(g.deliberate()).toBe(true);
  });

  it('arrival speed tells a rap from a slam', () => {
    const rap = new PatGate();
    let t = feedFor(rap, 0, 0.5, () => [0, 0.9, -0.4]);
    feedFor(rap, t, 0.15, (dt) => [0, 0.9, -0.4 - 0.5 * dt]); // half a metre a second
    expect(rap.arrival()).toBeGreaterThan(0.35);
    expect(rap.arrival()).toBeLessThan(0.7);
    const slam = new PatGate();
    t = feedFor(slam, 0, 0.5, () => [0, 0.9, -0.4]);
    feedFor(slam, t, 0.12, (dt) => [0, 0.9, -0.4 - 1.8 * dt]);
    expect(slam.arrival()).toBeGreaterThan(1.1);
  });

  it('a hand that has just appeared has no history and does not count', () => {
    const g = new PatGate();
    g.feed(0, 0, 0, 0);
    g.feed(FRAME, 0.1, 0.8, -0.4);
    expect(g.deliberate()).toBe(false);
    g.reset();
    feedFor(g, 1, 1, () => [0.1, 0.8, -0.4]);
    expect(g.deliberate()).toBe(false);
  });
});

// a few millimetres of tracking jitter, the same every run
const wobble = (t: number): number => 0.003 * Math.sin(t * 173.1) + 0.002 * Math.sin(t * 61.7);

describe('the held-prop detectors at a headset rate (90 samples a second)', () => {
  it('a shell held still only jitters and never strikes; a shake still strikes once per downstroke', () => {
    const d = new StrikeDetector();
    const still = trace((t) => ({ y: 1 + wobble(t) }), 3, 90);
    expect(still.map((s) => d.feed(s)).filter((v) => v !== null)).toHaveLength(0);
    d.reset();
    const hits = trace((t) => ({ y: 1 + 0.06 * Math.sin(2 * Math.PI * 3 * t) }), 2, 90)
      .map((s) => d.feed(s))
      .filter((v): v is number => v !== null);
    expect(hits.length).toBeGreaterThanOrEqual(5);
    expect(hits.length).toBeLessThanOrEqual(7);
  });

  it('a sheet held still stays quiet; shaken, it still roars', () => {
    const m = new ShakeMeter();
    const still = trace((t) => ({ x: wobble(t), y: 1 + wobble(t + 1), z: wobble(t + 2) }), 3, 90).map((s) => m.feed(s));
    expect(Math.max(...still)).toBeLessThan(0.2);
    m.reset();
    const shaken = trace((t) => ({ x: 0.05 * Math.sin(2 * Math.PI * 4 * t), y: 1 }), 1, 90).map((s) => m.feed(s));
    expect(Math.max(...shaken)).toBeGreaterThan(0.5);
  });
});

describe('PatGate: a hand the tracking loses and finds again', () => {
  it('found again somewhere else, it has not travelled there', () => {
    const g = new PatGate();
    let t = 0;
    for (; t < 1; t += 1 / 72) g.feed(t, 0.3, 0.9, -0.2); // at rest
    for (let i = 0; i < 4; i++) g.feed((t += 1 / 72), 0.1, 0.82, -0.4); // and then, at once, 30 cm away inside a prop
    expect(g.deliberate()).toBe(false);
  });

  it('a quick pat on a slow frame is not taken for a jump (2 m/s at 36 frames a second)', () => {
    const g = new PatGate();
    let t = 0;
    for (; t < 0.5; t += 1 / 36) g.feed(t, 0.1, 0.95, -0.4);
    for (let i = 1; i <= 3; i++) g.feed(t + i / 36, 0.1, 0.95 - (2 / 36) * i, -0.4);
    expect(g.deliberate()).toBe(true);
    expect(g.arrival()).toBeGreaterThan(1.1);
  });
});

describe('Stroke: one fingertip on one prop, down, up and down again', () => {
  const never = (): boolean => false;
  const run = (s: Stroke, secs: number, depth: (t: number) => number, o: { pinching?: boolean; arrival?: number; meant?: () => boolean; t0?: number } = {}) => {
    const out = { pats: 0, lifts: 0 };
    for (let i = 1; i <= secs * 72; i++) {
      const t = i / 72;
      const did = s.feed(depth(t), (o.t0 ?? 0) + t, o.pinching ?? false, o.arrival ?? 0, 0.2, o.meant ?? never);
      if (did === 'pat') out.pats++;
      else if (did === 'lift') out.lifts++;
    }
    return out;
  };

  it('drumming with small lifts: every way down is a pat, and the finger never leaves the prop', () => {
    // in at the top, then bobbing between 2 cm deep and 1 cm clear, four times a second (3 cm strokes)
    const s = new Stroke('coconuts', 0.01, true);
    const got = run(s, 1, (t) => -0.005 + 0.015 * Math.cos(2 * Math.PI * 4 * t));
    expect(got.pats).toBe(3); // (the first of the four was the touch itself)
    expect(got.lifts).toBeGreaterThanOrEqual(3);
  });

  it('a finger resting inside a prop, jittering, never pats again', () => {
    const s = new Stroke('bell', -0.01, true);
    expect(run(s, 3, (t) => -0.01 + wobble(t))).toEqual({ pats: 0, lifts: 0 });
  });

  it('a touch that crept in counts once the finger presses on in earnest, and only then', () => {
    const slow = new Stroke('bell', 0.01, false);
    expect(run(slow, 0.5, (t) => 0.01 - 0.04 * t, { arrival: 0.04 }).pats).toBe(0);
    const firm = new Stroke('bell', 0.01, false);
    expect(run(firm, 0.2, (t) => 0.01 - 0.3 * t, { arrival: 0.3 }).pats).toBe(1);
    expect(firm.live).toBe(true);
  });

  it('small strokes are enough: two centimetres up and down, five times a second', () => {
    const s = new Stroke('coconuts', -0.002, true);
    const got = run(s, 1, (t) => -0.012 + 0.01 * Math.cos(2 * Math.PI * 5 * t));
    expect(got.pats).toBe(4);
  });

  it('a touch that did not count can simply be tapped again', () => {
    const s = new Stroke('bell', 0.01, false);
    // sinks 1 cm slowly, comes up 2.5 cm, goes down again
    const got = run(s, 1, (t) => (t < 0.4 ? 0.01 - 0.05 * t : t < 0.6 ? -0.01 + 0.125 * (t - 0.4) : 0.015 - 0.1 * (t - 0.6)));
    expect(got).toEqual({ pats: 1, lifts: 0 });
  });

  it('a slow return after a rest has to be meant', () => {
    const up = (t: number): number => (t < 0.3 ? -0.01 + 0.1 * t : 0.02);
    const down = (t: number): number => 0.02 - 0.03 * t;
    const idle = new Stroke('door', -0.01, true);
    expect(run(idle, 3, up).lifts).toBe(1);
    expect(run(idle, 1, down, { t0: 3 }).pats).toBe(0);
    const meant = new Stroke('door', -0.01, true);
    run(meant, 3, up);
    expect(run(meant, 1, down, { t0: 3, meant: () => true }).pats).toBe(1);
  });

  it('a pinching hand is picking something up, not patting', () => {
    const s = new Stroke('glass', 0.01, true);
    expect(run(s, 1, (t) => -0.005 + 0.015 * Math.cos(2 * Math.PI * 4 * t), { pinching: true }).pats).toBe(0);
  });

  it('lifting ends a pat that counted exactly once (a held megaphone is let go)', () => {
    const s = new Stroke('megaphone', -0.02, true);
    const got = run(s, 1, (t) => (t < 0.5 ? -0.02 + wobble(t) * 0.5 : -0.02 + 0.08 * (t - 0.5)));
    expect(got).toEqual({ pats: 0, lifts: 1 });
  });
});

/**
 * The touch loop of the game, reduced to one fingertip and one piece: in reach of the shape (TOUCH_IN) a stroke starts,
 * measured past the face the finger came in by; it lasts while the finger is over or through that face and less than
 * 3.5 cm clear of it.
 */
function touchRun(box: Box3, path: (t: number) => [number, number, number], secs: number, o: { pinch?: (t: number) => boolean } = {}) {
  let stroke: Stroke | null = null;
  let face = 3;
  let pats = 0;
  let lifts = 0;
  const p = new Vector3();
  for (let i = 0; i <= secs * 72; i++) {
    const t = i / 72;
    p.set(...path(t));
    const pinching = o.pinch?.(t) ?? false;
    if (stroke) {
      const past = depthPast(box, p, face);
      if (Math.max(past, besideBy(box, p, face >> 1)) <= 0.035) {
        const did = stroke.feed(past, t, pinching, 1, 0.2, () => true);
        if (did === 'pat') pats++;
        else if (did === 'lift') lifts++;
        continue;
      }
      stroke = null;
    }
    if (depthIn(box, p) <= TOUCH_IN) {
      face = entryFace(box, p);
      stroke = new Stroke('piece', depthPast(box, p, face), !pinching);
      if (!pinching) pats++;
    }
  }
  return { pats, lifts };
}

describe('a touch measured against the face it came in by', () => {
  // a round tile on the table rim: 5 cm across, 1 cm thick
  const tile = new Box3(new Vector3(-0.025, 0, -0.025), new Vector3(0.025, 0.01, 0.025));
  // the little door's leaf with its base: 5 cm deep in all
  const door = new Box3(new Vector3(-0.03, 0, -0.025), new Vector3(0.03, 0.09, 0.025));

  it('the face a finger comes in by is the one it is furthest outside of', () => {
    expect(entryFace(tile, new Vector3(0, 0.05, 0))).toBe(3); // from above: +y
    expect(entryFace(door, new Vector3(0, 0.05, 0.08))).toBe(5); // from the player's side: +z
    expect(depthPast(tile, new Vector3(0, -0.04, 0), 3)).toBeCloseTo(-0.05); // through the tile, and on: deeper
    expect(besideBy(tile, new Vector3(0.035, 0.02, 0), 1)).toBeCloseTo(0.01);
  });

  it('pressing on through a thin tile is one press, not two', () => {
    for (const reach of [0.025, 0.06]) {
      // down from 5 cm above to `reach` below the face and back, in half a second each way
      const got = touchRun(tile, (t) => [0, t < 0.5 ? 0.06 - (0.05 + reach) * (t / 0.5) : 0.01 - reach + (0.05 + reach) * Math.min(1, (t - 0.5) / 0.5), 0], 1.2);
      expect(got.pats).toBe(1);
    }
  });

  it('knocking through the door is one knock', () => {
    for (const reach of [0.02, 0.08]) {
      const got = touchRun(door, (t) => [0, 0.05, t < 0.3 ? 0.08 - (0.055 + reach) * (t / 0.3) : 0.025 - reach + (0.055 + reach) * Math.min(1, (t - 0.3) / 0.3)], 0.8);
      expect(got.pats).toBe(1);
    }
  });

  it('drumming on a prop with small lifts still counts every stroke', () => {
    const shells = new Box3(new Vector3(-0.06, 0, -0.04), new Vector3(0.06, 0.05, 0.04));
    const got = touchRun(shells, (t) => [0, 0.045 + 0.0125 * Math.cos(2 * Math.PI * 4 * t) + (t < 0.05 ? 0.03 : 0), 0], 1);
    expect(got.pats).toBeGreaterThanOrEqual(4);
  });

  it('a finger resting on a prop while the hand pinches does not sound it again when the pinch opens', () => {
    // resting 1 cm into the bell; the pinch lifts the fingertip 2 cm for half a second, then it settles back
    const bell = new Box3(new Vector3(-0.04, 0, -0.04), new Vector3(0.04, 0.05, 0.04));
    const got = touchRun(
      bell,
      (t) => [0, t < 0.2 ? 0.07 - 0.03 * (t / 0.2) : t < 1 ? 0.04 : t < 1.5 ? 0.06 : 0.04, 0],
      2.5,
      { pinch: (t) => t >= 0.9 && t < 1.6 },
    );
    expect(got.pats).toBe(1); // the first touch, and nothing for the pinch
  });
});

describe('PatGate and a stalled frame', () => {
  it('a fast reach over a frame that stalled for 80 ms is still a reach', () => {
    const g = new PatGate();
    let t = 0;
    for (; t < 0.5; t += 1 / 72) g.feed(t, 0.1, 0.95, -0.4);
    g.feed(t + 0.08, 0.1, 0.95 - 0.16, -0.4); // 2 m/s across the stall
    g.feed(t + 0.08 + 1 / 72, 0.1, 0.95 - 0.165, -0.4);
    expect(g.fresh()).toBe(false);
    expect(g.deliberate()).toBe(true);
  });

  it('a hand found again 30 cm away in one frame starts afresh', () => {
    const g = new PatGate();
    let t = 0;
    for (; t < 0.5; t += 1 / 72) g.feed(t, 0.3, 0.95, -0.2);
    g.feed(t + 1 / 72, 0.05, 0.85, -0.4);
    expect(g.fresh()).toBe(true);
    expect(g.deliberate()).toBe(false);
  });
});
