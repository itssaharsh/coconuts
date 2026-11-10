// Replays a take against the film clock: each event fires when the video reaches its time.
import type { HitEvent, Take } from './types';

export interface ReplaySchedule {
  /** Events in time order, each fired once. */
  events: HitEvent[];
}

export function schedule(take: Take): ReplaySchedule {
  return { events: [...take.events].sort((a, b) => a.t - b.t) };
}

/**
 * Drives a schedule from a clock you poll (the video's currentTime). `fire` is called for every event
 * whose time has passed since the last poll, in order, so a replay fires exactly the recorded hits.
 */
export class Replayer {
  private next = 0;
  private lastClock = -1;

  constructor(
    private plan: ReplaySchedule,
    private fire: (e: HitEvent, late: number) => void,
    public lookahead = 0.05,
  ) {}

  reset(): void {
    this.next = 0;
    this.lastClock = -1;
  }

  get done(): boolean {
    return this.next >= this.plan.events.length;
  }

  /** Call every frame with the film clock in seconds. */
  tick(clock: number): void {
    if (clock < this.lastClock - 0.2) this.reset(); // the film was rewound
    this.lastClock = clock;
    const ev = this.plan.events;
    while (this.next < ev.length && ev[this.next].t <= clock + this.lookahead) {
      const e = ev[this.next++];
      this.fire(e, clock - e.t);
    }
  }
}
