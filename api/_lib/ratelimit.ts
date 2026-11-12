// A token bucket per client IP: 30 requests a minute, refilled smoothly. In memory, so it is per warm
// instance and best effort; it stops one browser tab from hammering the model, not a determined crowd.

const CAPACITY = 30;
const MAX_TRACKED = 5000;

/** The first hop of x-forwarded-for (the client as Vercel saw it), then x-real-ip. */
export function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  const first = fwd?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * A limiter of its own: `capacity` requests a minute for each client IP, refilled smoothly. A route that costs money
 * each time (a reel from the model) takes a smaller one beside the default.
 */
export function limiter(capacity: number): (ip: string, now?: number) => boolean {
  const refillPerMs = capacity / 60_000;
  const buckets = new Map<string, { tokens: number; at: number }>();
  /** Forget buckets that have refilled; if that is not enough, forget the oldest. */
  const prune = (now: number): void => {
    for (const [k, b] of buckets) {
      if (b.tokens + (now - b.at) * refillPerMs >= capacity) buckets.delete(k);
    }
    if (buckets.size < MAX_TRACKED) return;
    const drop = buckets.size - MAX_TRACKED + 1;
    let i = 0;
    for (const k of buckets.keys()) {
      if (i++ >= drop) break;
      buckets.delete(k);
    }
  };
  return (ip: string, now = performance.now()): boolean => {
    const key = ip || 'unknown';
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= MAX_TRACKED) prune(now);
      b = { tokens: capacity, at: now };
      buckets.set(key, b);
    } else {
      b.tokens = Math.min(capacity, b.tokens + Math.max(0, now - b.at) * refillPerMs);
      b.at = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

/** Take one token for this IP; false when the bucket is empty. */
export const allow = limiter(CAPACITY);
