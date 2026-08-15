import { validationError } from '@/shared/errors/app-error.js';

/**
 * A half-open time interval `[start, end)`. Half-open is the whole ballgame for a booking
 * system: with closed intervals a 10:00-11:00 and an 11:00-12:00 appointment would be
 * considered overlapping, and back-to-back sessions would be impossible to book. This
 * matches the `'[)'` bound used by the Postgres `tstzrange` exclusion constraints exactly,
 * so the application and the database always agree on what "overlap" means.
 */
export class TimeInterval {
  private constructor(
    public readonly start: Date,
    public readonly end: Date,
  ) {}

  static of(start: Date, end: Date): TimeInterval {
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw validationError('Interval bounds must be valid dates.');
    }
    if (end.getTime() <= start.getTime()) {
      throw validationError('Interval end must be strictly after its start.', {
        start: start.toISOString(),
        end: end.toISOString(),
      });
    }
    return new TimeInterval(new Date(start.getTime()), new Date(end.getTime()));
  }

  get durationMinutes(): number {
    return (this.end.getTime() - this.start.getTime()) / 60_000;
  }

  overlaps(other: TimeInterval): boolean {
    return this.start.getTime() < other.end.getTime() && other.start.getTime() < this.end.getTime();
  }

  contains(other: TimeInterval): boolean {
    return (
      this.start.getTime() <= other.start.getTime() && this.end.getTime() >= other.end.getTime()
    );
  }

  equals(other: TimeInterval): boolean {
    return (
      this.start.getTime() === other.start.getTime() && this.end.getTime() === other.end.getTime()
    );
  }

  toJSON(): { startTime: string; endTime: string } {
    return { startTime: this.start.toISOString(), endTime: this.end.toISOString() };
  }
}

/** True when any interval in `candidates` overlaps `target`. */
export const overlapsAny = (target: TimeInterval, candidates: readonly TimeInterval[]): boolean =>
  candidates.some((candidate) => candidate.overlaps(target));
