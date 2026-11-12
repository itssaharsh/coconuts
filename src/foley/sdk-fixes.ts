// Small corrections to the Immersive Web SDK, applied once before the world is made.
import { CursorVisual } from '@iwsdk/core';

/** The longest frame step a smoothing gets to see (seconds). */
export const MAX_STEP_S = 1 / 30;

/**
 * Wrap a method that takes a frame step (seconds) as its argument at `deltaAt` so it never sees more than `max`.
 * Wrapping twice does nothing more.
 */
export function clampStep(proto: object, method: string, deltaAt: number, max = MAX_STEP_S): boolean {
  const p = proto as Record<string, unknown> & { __clampedSteps?: string[] };
  const original = p[method];
  if (typeof original !== 'function' || p.__clampedSteps?.includes(method)) return false;
  p[method] = function (this: unknown, ...args: unknown[]) {
    if (typeof args[deltaAt] === 'number') args[deltaAt] = Math.min(args[deltaAt] as number, max);
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  p.__clampedSteps = [...(p.__clampedSteps ?? []), method];
  return true;
}

/**
 * The ray's cursor eases toward its focused look with lerp(alpha, target, 30 * delta). A frame longer than a fifteenth
 * of a second makes that factor greater than 2: the value overshoots further every frame and the cursor's disc grows
 * without bound, a white slab across the view (seen in the emulator after every far pinch; on a headset, after a hitch).
 * A step of at most a thirtieth of a second keeps the factor at 1 or less.
 */
export function applySdkFixes(): void {
  clampStep(CursorVisual.prototype, 'updateFromIntersection', 1);
}
