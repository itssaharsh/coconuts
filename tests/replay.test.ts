import { describe, expect, it } from 'vitest';
import { Recorder, decodeTake, encodeTake } from '../src/foley/recorder';
import { Replayer, schedule } from '../src/foley/replay';
import type { HitEvent, Take } from '../src/foley/types';

const take: Take = {
  clipId: 'one-week',
  startedAt: '2026-11-10T18:00:00Z',
  events: [
    { t: 1.5, prop: 'coconuts', kind: 'clop', v: 0.8, hand: 'right' },
    { t: 1.72, prop: 'coconuts', kind: 'clop', v: 0.6, hand: 'left' },
    { t: 4.0, prop: 'door', kind: 'knock', v: 1 },
    { t: 9.25, prop: 'whistle', kind: 'whistle', v: 0.5, hand: 'gaze' },
    { t: 12.1, prop: 'glass', kind: 'crash', v: 1, hand: 'right' },
  ],
};

describe('take codes', () => {
  it('round-trip through the share code within 10 ms and 1/31 strength', () => {
    const code = encodeTake(take);
    expect(code.startsWith('one-week.')).toBe(true);
    expect(code).not.toMatch(/[+/=]/);
    const back = decodeTake(code)!;
    expect(back.clipId).toBe('one-week');
    expect(back.events).toHaveLength(5);
    back.events.forEach((e, i) => {
      expect(Math.abs(e.t - take.events[i].t)).toBeLessThanOrEqual(0.01);
      expect(e.prop).toBe(take.events[i].prop);
      expect(e.kind).toBe(take.events[i].kind);
      expect(Math.abs(e.v - take.events[i].v)).toBeLessThanOrEqual(1 / 31 + 1e-9);
      expect(e.hand).toBe(take.events[i].hand);
    });
  });

  it('rejects garbage', () => {
    expect(decodeTake('nodot')).toBeNull();
    expect(decodeTake('one-week.!!!')).toBeNull();
  });
});

describe('Replayer', () => {
  it('fires every event once, in order, at the film clock', () => {
    const fired: { t: number; late: number }[] = [];
    const r = new Replayer(schedule(take), (e: HitEvent, late) => fired.push({ t: e.t, late }), 0);
    for (let clock = 0; clock <= 13; clock += 1 / 72) r.tick(clock);
    expect(fired.map((f) => f.t)).toEqual([1.5, 1.72, 4.0, 9.25, 12.1]);
    for (const f of fired) expect(f.late).toBeLessThan(1 / 72 + 1e-9);
    expect(r.done).toBe(true);
  });

  it('rewinds with the film', () => {
    let n = 0;
    const r = new Replayer(schedule(take), () => n++, 0);
    for (let clock = 0; clock <= 5; clock += 0.05) r.tick(clock);
    expect(n).toBe(3);
    r.tick(0.1);
    for (let clock = 0.1; clock <= 5; clock += 0.05) r.tick(clock);
    expect(n).toBe(6);
  });
});

describe('Recorder', () => {
  it('rounds times to 10 ms and closes into a take', () => {
    const rec = new Recorder();
    rec.start('one-week', 'x');
    rec.add({ t: 1.23456, prop: 'bell', kind: 'ding', v: 1 });
    expect(rec.count).toBe(1);
    const t = rec.stop()!;
    expect(t.events[0].t).toBe(1.23);
    expect(rec.open).toBe(false);
  });
});
