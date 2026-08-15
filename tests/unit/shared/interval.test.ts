import { describe, expect, it } from 'vitest';
import { TimeInterval, overlapsAny } from '@/shared/time/interval.js';

/**
 * `TimeInterval` has to mean exactly what Postgres' `tstzrange(start, end, '[)')` means, because
 * the exclusion constraints are the final arbiter of double booking. If these two definitions of
 * "overlap" ever diverge, the application and the database disagree about what is bookable — and
 * the database wins, in production, at the worst moment.
 */

const at = (iso: string): Date => new Date(`2026-03-02T${iso}:00.000Z`);
const between = (start: string, end: string): TimeInterval => TimeInterval.of(at(start), at(end));

describe('TimeInterval.of', () => {
  it('rejects an end at or before the start', () => {
    expect(() => between('10:00', '10:00')).toThrow(/strictly after/i);
    expect(() => between('10:00', '09:00')).toThrow(/strictly after/i);
  });

  it('rejects invalid dates', () => {
    expect(() => TimeInterval.of(new Date('nonsense'), at('10:00'))).toThrow(/valid dates/i);
  });

  it('copies its bounds so a caller cannot mutate them afterwards', () => {
    const start = at('09:00');
    const interval = TimeInterval.of(start, at('10:00'));

    start.setUTCHours(23);

    expect(interval.start.toISOString()).toBe('2026-03-02T09:00:00.000Z');
  });

  it('reports its duration in minutes', () => {
    expect(between('09:00', '10:30').durationMinutes).toBe(90);
  });
});

describe('overlaps', () => {
  const session = between('10:00', '11:00');

  it('does not overlap an interval that ends exactly when it starts', () => {
    // The half-open rule, and the reason back-to-back appointments are bookable at all.
    expect(session.overlaps(between('09:00', '10:00'))).toBe(false);
    expect(between('09:00', '10:00').overlaps(session)).toBe(false);
  });

  it('does not overlap an interval that starts exactly when it ends', () => {
    expect(session.overlaps(between('11:00', '12:00'))).toBe(false);
  });

  it('overlaps a partial collision from either side', () => {
    expect(session.overlaps(between('09:30', '10:30'))).toBe(true);
    expect(session.overlaps(between('10:30', '11:30'))).toBe(true);
  });

  it('overlaps an interval it contains, and one that contains it', () => {
    expect(session.overlaps(between('10:15', '10:45'))).toBe(true);
    expect(session.overlaps(between('09:00', '12:00'))).toBe(true);
  });

  it('is symmetric', () => {
    const other = between('10:30', '11:30');

    expect(session.overlaps(other)).toBe(other.overlaps(session));
  });

  it('does not overlap a disjoint interval', () => {
    expect(session.overlaps(between('14:00', '15:00'))).toBe(false);
  });
});

describe('contains and equals', () => {
  it('contains an interval within its bounds, inclusively', () => {
    const day = between('09:00', '17:00');

    expect(day.contains(between('09:00', '10:00'))).toBe(true);
    expect(day.contains(between('16:00', '17:00'))).toBe(true);
    expect(day.contains(between('16:00', '18:00'))).toBe(false);
  });

  it('compares by value, not identity', () => {
    expect(between('09:00', '10:00').equals(between('09:00', '10:00'))).toBe(true);
    expect(between('09:00', '10:00').equals(between('09:00', '11:00'))).toBe(false);
  });

  it('serialises to the API field names', () => {
    expect(between('09:00', '10:00').toJSON()).toEqual({
      startTime: '2026-03-02T09:00:00.000Z',
      endTime: '2026-03-02T10:00:00.000Z',
    });
  });
});

describe('overlapsAny', () => {
  const candidates = [between('09:00', '10:00'), between('11:00', '12:00')];

  it('is false when nothing collides, including adjacent neighbours', () => {
    expect(overlapsAny(between('10:00', '11:00'), candidates)).toBe(false);
  });

  it('is true when any candidate collides', () => {
    expect(overlapsAny(between('11:30', '12:30'), candidates)).toBe(true);
  });

  it('is false for an empty candidate list', () => {
    expect(overlapsAny(between('10:00', '11:00'), [])).toBe(false);
  });
});
