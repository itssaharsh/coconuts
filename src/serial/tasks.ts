// Cooperative tasks: everything on stage advances from update(dt), never from timers, so a reel can be paused,
// replayed deterministically and captured frame by frame at a fixed time step.
export interface Task {
  /** Advance by dt seconds; true when the task has finished. */
  update(dt: number): boolean;
  /** Optional: stop early and leave things tidy. */
  cancel?(): void;
}

export const done: Task = { update: () => true };

export function wait(seconds: number): Task {
  let left = seconds;
  return { update: (dt) => (left -= dt) <= 0 };
}

export function call(fn: () => void): Task {
  return {
    update: () => {
      fn();
      return true;
    },
  };
}

/** Run tasks one after another. Tasks are made lazily, so a later beat sees the world the earlier ones left. */
export function sequence(makers: (() => Task)[]): Task {
  let i = 0;
  let current: Task | null = null;
  return {
    update(dt) {
      // a finished task hands the rest of the frame to the next one only when it finished instantly
      for (let guard = 0; guard < 64; guard++) {
        if (!current) {
          if (i >= makers.length) return true;
          current = makers[i++]();
        }
        if (!current.update(dt)) return false;
        current = null;
        dt = 0;
      }
      return false;
    },
    cancel() {
      current?.cancel?.();
      current = null;
      i = makers.length;
    },
  };
}

/** Run tasks together; finished when all are. */
export function parallel(tasks: Task[]): Task {
  const live = [...tasks];
  return {
    update(dt) {
      for (let i = live.length - 1; i >= 0; i--) if (live[i].update(dt)) live.splice(i, 1);
      return live.length === 0;
    },
    cancel() {
      for (const t of live) t.cancel?.();
      live.length = 0;
    },
  };
}

/** Run until `until()` is true or `seconds` pass; reports which through `onEnd`. */
export function waitFor(until: () => boolean, seconds: number, onEnd?: (timedOut: boolean) => void): Task {
  let left = seconds;
  return {
    update(dt) {
      if (until()) {
        onEnd?.(false);
        return true;
      }
      left -= dt;
      if (left <= 0) {
        onEnd?.(true);
        return true;
      }
      return false;
    },
  };
}
