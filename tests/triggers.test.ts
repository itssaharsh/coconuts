import { describe, expect, it } from 'vitest';
import { ShakeMeter, SlideTracker, StrikeDetector, isDrop, type Sample } from '../src/foley/triggers';

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
