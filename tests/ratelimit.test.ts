import { describe, expect, it } from 'vitest';
import { allow } from '../api/_lib/ratelimit';

describe('rate limit', () => {
  it('allows 30 a minute per IP and refills', () => {
    const t = 1_000_000;
    for (let i = 0; i < 30; i++) expect(allow('10.0.0.1', t)).toBe(true);
    expect(allow('10.0.0.1', t)).toBe(false);
    expect(allow('10.0.0.2', t)).toBe(true);
    expect(allow('10.0.0.1', t + 2000)).toBe(true);
    expect(allow('10.0.0.1', t + 2000)).toBe(false);
  });
});
