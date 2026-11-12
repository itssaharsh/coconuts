// A token bucket per client IP: 30 requests a minute, refilled smoothly. In memory, so it is per warm
// instance and best effort; it stops one browser tab from hammering the model, not a determined crowd.

const CAPACITY = 30;
const REFILL_PER_MS = CAPACITY / 60_000;
const MAX_TRACKED = 5000;

const buckets = new Map<string, { tokens: number; at: number }>();

/** The first hop of x-forwarded-for (the client as Vercel saw it), then x-real-ip. */
export function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  const first = fwd?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Take one token for this IP; false when the bucket is empty. */
export function allow(ip: string, now = performance.now()): boolean {
  const key = ip || 'unknown';
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_TRACKED) prune(now);
    b = { tokens: CAPACITY, at: now };
    buckets.set(key, b);
  } else {
    b.tokens = Math.min(CAPACITY, b.tokens + Math.max(0, now - b.at) * REFILL_PER_MS);
    b.at = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Forget buckets that have refilled; if that is not enough, forget the oldest. */
function prune(now: number): void {
  for (const [k, b] of buckets) {
    if (b.tokens + (now - b.at) * REFILL_PER_MS >= CAPACITY) buckets.delete(k);
  }
  if (buckets.size < MAX_TRACKED) return;
  const drop = buckets.size - MAX_TRACKED + 1;
  let i = 0;
  for (const k of buckets.keys()) {
    if (i++ >= drop) break;
    buckets.delete(k);
  }
}
