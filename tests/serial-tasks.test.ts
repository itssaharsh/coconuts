import { describe, expect, it } from 'vitest';
import { call, done, parallel, sequence, type Task, wait, waitFor } from '../src/serial/tasks';

/** A task that finishes after `n` updates and logs its life. */
function counted(log: string[], name: string, n: number): Task & { cancelled: boolean } {
  let left = n;
  const t = {
    cancelled: false,
    update: () => {
      log.push(`${name}:update`);
      return --left <= 0;
    },
    cancel: () => {
      t.cancelled = true;
      log.push(`${name}:cancel`);
    },
  };
  return t;
}

describe('wait / done / call', () => {
  it('done is finished at once', () => {
    expect(done.update(0.1)).toBe(true);
  });

  it('wait finishes once the seconds have passed', () => {
    const t = wait(1);
    expect(t.update(0.4)).toBe(false);
    expect(t.update(0.4)).toBe(false);
    expect(t.update(0.2)).toBe(true);
  });

  it('call runs its function once, on its first update', () => {
    let n = 0;
    const t = call(() => n++);
    expect(n).toBe(0);
    expect(t.update(0)).toBe(true);
    expect(n).toBe(1);
  });
});

describe('sequence', () => {
  it('makes its tasks lazily and in order', () => {
    const log: string[] = [];
    const t = sequence([
      () => (log.push('make a'), counted(log, 'a', 2)),
      () => (log.push('make b'), counted(log, 'b', 1)),
    ]);
    expect(log).toEqual([]);
    expect(t.update(0.1)).toBe(false);
    expect(log).toEqual(['make a', 'a:update']);
    // a finishes, and b (one update long) is made and finished in the same frame
    expect(t.update(0.1)).toBe(true);
    expect(log).toEqual(['make a', 'a:update', 'a:update', 'make b', 'b:update']);
  });

  it('a later maker sees what an earlier task left behind', () => {
    let world = 0;
    const t = sequence([() => call(() => (world = 5)), () => call(() => (world *= 2))]);
    expect(t.update(0)).toBe(true);
    expect(world).toBe(10);
  });

  it('runs instant tasks within one frame and hands the next task dt 0', () => {
    const dts: number[] = [];
    const t = sequence([
      () => done,
      () => ({ update: (dt) => (dts.push(dt), true) }),
      () => wait(1),
    ]);
    expect(t.update(0.5)).toBe(false);
    expect(dts).toEqual([0]);
  });

  it('an empty sequence is finished at once', () => {
    expect(sequence([]).update(0)).toBe(true);
  });

  it('cancel cancels the running task and never makes the rest', () => {
    const log: string[] = [];
    const a = counted(log, 'a', 5);
    const t = sequence([() => a, () => (log.push('make b'), done)]);
    t.update(0.1);
    t.cancel?.();
    expect(a.cancelled).toBe(true);
    expect(log).not.toContain('make b');
  });

  it('a cancelled sequence reports finished and stops driving the cancelled task', () => {
    const log: string[] = [];
    const a = counted(log, 'a', 5);
    const t = sequence([() => a]);
    t.update(0.1);
    t.cancel?.();
    const before = log.filter((l) => l === 'a:update').length;
    expect(t.update(0.1)).toBe(true);
    expect(log.filter((l) => l === 'a:update').length).toBe(before);
  });
});

describe('parallel', () => {
  it('finishes only when all its tasks have finished', () => {
    const log: string[] = [];
    const t = parallel([counted(log, 'a', 1), counted(log, 'b', 3)]);
    expect(t.update(0.1)).toBe(false);
    expect(t.update(0.1)).toBe(false);
    expect(t.update(0.1)).toBe(true);
    // a finished in the first frame and was not updated again
    expect(log.filter((l) => l === 'a:update')).toHaveLength(1);
    expect(log.filter((l) => l === 'b:update')).toHaveLength(3);
  });

  it('an empty parallel is finished at once', () => {
    expect(parallel([]).update(0)).toBe(true);
  });

  it('cancel cancels every live task', () => {
    const log: string[] = [];
    const a = counted(log, 'a', 4);
    const b = counted(log, 'b', 4);
    const t = parallel([a, b]);
    t.update(0.1);
    t.cancel?.();
    expect(a.cancelled && b.cancelled).toBe(true);
    expect(t.update(0.1)).toBe(true);
  });
});

describe('waitFor', () => {
  it('ends with timedOut false as soon as the condition holds', () => {
    let ok = false;
    const ends: boolean[] = [];
    const t = waitFor(() => ok, 5, (timedOut) => ends.push(timedOut));
    expect(t.update(1)).toBe(false);
    ok = true;
    expect(t.update(1)).toBe(true);
    expect(ends).toEqual([false]);
  });

  it('ends with timedOut true when the seconds run out', () => {
    const ends: boolean[] = [];
    const t = waitFor(() => false, 2, (timedOut) => ends.push(timedOut));
    expect(t.update(1)).toBe(false);
    expect(t.update(1)).toBe(true);
    expect(ends).toEqual([true]);
  });

  it('works without an onEnd', () => {
    expect(waitFor(() => true, 1).update(0)).toBe(true);
  });
});
