import { describe, expect, it } from 'vitest';
import type { Order } from '../src/game/types';

describe('smoke', () => {
  it('types compile and vitest runs', () => {
    const order: Order = { who: 'pip', what: 'crate_red', where: { kind: 'prop', id: 'pad_blue' } };
    expect(order.who).toBe('pip');
  });
});
