import { describe, expect, it } from 'vitest';
import { clampStep, MAX_STEP_S } from '../src/foley/sdk-fixes';

// the SDK's cursor smoothing, as it is written: alpha = lerp(alpha, target, 30 * delta)
class FakeCursor {
  focusAlpha = 0;
  scale = 1;
  updateFromIntersection(_i: unknown, delta: number, focused: boolean): void {
    const t = 30 * delta;
    this.focusAlpha = this.focusAlpha + ((focused ? 1 : 0) - this.focusAlpha) * t;
    this.scale = 1 + (0.8 - 1) * this.focusAlpha;
  }
}

describe('the SDK cursor at a slow frame rate', () => {
  it('without the fix, a quarter-second frame makes the cursor grow without bound', () => {
    const c = new FakeCursor();
    for (let i = 0; i < 40; i++) c.updateFromIntersection(null, 0.25, i % 2 === 0);
    expect(Math.abs(c.scale)).toBeGreaterThan(1e6);
  });

  it('with the step clamped, it stays between its two sizes whatever the frame rate', () => {
    class Patched extends FakeCursor {}
    expect(clampStep(Patched.prototype, 'updateFromIntersection', 1)).toBe(true);
    expect(clampStep(Patched.prototype, 'updateFromIntersection', 1)).toBe(false); // once is enough
    const c = new Patched();
    for (let i = 0; i < 400; i++) {
      c.updateFromIntersection(null, [0.25, 0.011, 2, 0.4][i % 4], i % 3 !== 0);
      expect(c.focusAlpha).toBeGreaterThanOrEqual(0);
      expect(c.focusAlpha).toBeLessThanOrEqual(1);
      expect(c.scale).toBeGreaterThanOrEqual(0.8 - 1e-9);
      expect(c.scale).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('a normal headset frame passes through unchanged', () => {
    const seen: number[] = [];
    class Spy {
      step(_a: unknown, d: number): void {
        seen.push(d);
      }
    }
    clampStep(Spy.prototype, 'step', 1);
    new Spy().step(null, 1 / 72);
    new Spy().step(null, 0.5);
    expect(seen).toEqual([1 / 72, MAX_STEP_S]);
  });
});
