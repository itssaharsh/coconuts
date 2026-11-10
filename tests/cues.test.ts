import { describe, expect, it } from 'vitest';
import { CueTracker, type Cue } from '../src/foley/cues';

const cues: Cue[] = [
  { t: 2.0, prop: 'coconuts', label: 'horse trots in', window: [0.6, 0.8] },
  { t: 2.4, prop: 'coconuts', label: 'horse again', window: [0.3, 0.3] },
  { t: 5.0, prop: 'door', label: 'door slams', window: [0.6, 0.8] },
  { t: 9.0, prop: 'whistle', label: 'falls off roof', window: [0.6, 1.0] },
];

describe('CueTracker', () => {
  it('lands a hit inside the window exactly once and picks the nearest open cue', () => {
    const c = new CueTracker(cues);
    const first = c.register({ t: 2.3, prop: 'coconuts', kind: 'clop', v: 1 });
    expect(first?.cue.label).toBe('horse again');
    const second = c.register({ t: 2.3, prop: 'coconuts', kind: 'clop', v: 1 });
    expect(second?.cue.label).toBe('horse trots in');
    expect(c.register({ t: 2.3, prop: 'coconuts', kind: 'clop', v: 1 })).toBeNull();
    expect(c.hits).toBe(2);
  });

  it('ignores the wrong prop and hits outside the window', () => {
    const c = new CueTracker(cues);
    expect(c.register({ t: 5.0, prop: 'bell', kind: 'ding', v: 1 })).toBeNull();
    expect(c.register({ t: 6.1, prop: 'door', kind: 'slam', v: 1 })).toBeNull();
    expect(c.register({ t: 5.7, prop: 'door', kind: 'slam', v: 1 })?.offset).toBeCloseTo(0.7);
    expect(c.summary()).toBe('1 of 4 cues hit');
  });

  it('lists upcoming cues and the highlights', () => {
    const c = new CueTracker(cues);
    expect(c.upcoming(1.0).map((s) => s.cue.t)).toEqual([2.0, 2.4, 5.0]);
    c.register({ t: 2.05, prop: 'coconuts', kind: 'clop', v: 1 });
    c.register({ t: 5.6, prop: 'door', kind: 'slam', v: 1 });
    const h = c.highlights();
    expect(h.best?.cue.label).toBe('horse trots in');
    expect(h.late?.cue.label).toBe('door slams');
    expect(h.missed.map((s) => s.cue.label)).toEqual(['horse again', 'falls off roof']);
  });
});
