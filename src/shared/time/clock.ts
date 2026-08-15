/**
 * Time is injected, never read from the ambient global, so that recurrence and expiry logic
 * is deterministic under test.
 *
 * Important boundary: this clock is for *pure* domain calculation only. Anything that
 * decides whether a hold is still valid must use the database clock (`now()`), because three
 * ECS tasks with three slightly-skewed system clocks must not disagree about ownership.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Deterministic clock for tests. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(next: Date): void {
    this.current = next;
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}
