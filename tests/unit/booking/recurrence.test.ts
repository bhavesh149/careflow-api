import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { describeHorizonLimit, expandRecurrence } from '@/modules/booking/domain/recurrence.js';

/**
 * Recurrence is the part of this system where "obviously correct" code is usually wrong, because
 * calendars are not arithmetic: months have different lengths and clocks jump. Every case below is
 * a decision the requirements left open, so these assertions are the specification.
 */

const TIMEZONE = 'Asia/Kolkata';

const expand = (
  overrides: Partial<Parameters<typeof expandRecurrence>[0]> & { anchorStart: Date },
): ReturnType<typeof expandRecurrence> =>
  expandRecurrence({
    frequency: 'WEEKLY',
    anchorEnd: new Date(overrides.anchorStart.getTime() + 60 * 60_000),
    occurrences: 4,
    timezone: TIMEZONE,
    maxOccurrences: 26,
    maxHorizonDays: 183,
    ...overrides,
  });

/** Local wall-clock time in the therapist's zone, which is how a schedule is expressed. */
const local = (iso: string): Date => DateTime.fromISO(iso, { zone: TIMEZONE }).toJSDate();

const localDayAndHour = (date: Date): string =>
  DateTime.fromJSDate(date, { zone: TIMEZONE }).toFormat('yyyy-MM-dd HH:mm');

describe('expandRecurrence', () => {
  it('produces the requested number of occurrences, starting with the anchor', () => {
    const occurrences = expand({ anchorStart: local('2026-03-02T10:00'), occurrences: 4 });

    expect(occurrences.map((occurrence) => localDayAndHour(occurrence.interval.start))).toEqual([
      '2026-03-02 10:00',
      '2026-03-09 10:00',
      '2026-03-16 10:00',
      '2026-03-23 10:00',
    ]);
    expect(occurrences.map((occurrence) => occurrence.index)).toEqual([0, 1, 2, 3]);
  });

  it('preserves the anchor duration for every occurrence', () => {
    const anchorStart = local('2026-03-02T10:00');
    const occurrences = expand({
      anchorStart,
      anchorEnd: new Date(anchorStart.getTime() + 90 * 60_000),
    });

    for (const occurrence of occurrences) {
      expect(occurrence.interval.durationMinutes).toBe(90);
    }
  });

  it.each([
    { frequency: 'DAILY' as const, expected: ['2026-03-02 10:00', '2026-03-03 10:00'] },
    { frequency: 'WEEKLY' as const, expected: ['2026-03-02 10:00', '2026-03-09 10:00'] },
    { frequency: 'BIWEEKLY' as const, expected: ['2026-03-02 10:00', '2026-03-16 10:00'] },
    { frequency: 'MONTHLY' as const, expected: ['2026-03-02 10:00', '2026-04-02 10:00'] },
  ])('steps $frequency by the right interval', ({ frequency, expected }) => {
    const occurrences = expand({
      anchorStart: local('2026-03-02T10:00'),
      frequency,
      occurrences: 2,
    });

    expect(occurrences.map((occurrence) => localDayAndHour(occurrence.interval.start))).toEqual(
      expected,
    );
  });

  describe('monthly overflow', () => {
    it('clamps the 31st to the last day of a shorter month and flags it', () => {
      const occurrences = expand({
        anchorStart: local('2026-01-31T10:00'),
        frequency: 'MONTHLY',
        occurrences: 3,
      });

      expect(occurrences.map((occurrence) => localDayAndHour(occurrence.interval.start))).toEqual([
        '2026-01-31 10:00',
        // Not 3 March: rolling forward would move the appointment into the wrong month.
        '2026-02-28 10:00',
        '2026-03-31 10:00',
      ]);
      expect(occurrences.map((occurrence) => occurrence.clamped)).toEqual([false, true, false]);
    });

    it('does not let a clamp drag the rest of the series earlier', () => {
      // The regression this guards: advancing from the clamped date instead of the anchor gives
      // 31 Jan -> 28 Feb -> 28 Mar -> 28 Apr, quietly moving a standing appointment.
      const occurrences = expand({
        anchorStart: local('2026-01-31T10:00'),
        frequency: 'MONTHLY',
        occurrences: 5,
      });

      expect(occurrences.map((occurrence) => localDayAndHour(occurrence.interval.start))).toEqual([
        '2026-01-31 10:00',
        '2026-02-28 10:00',
        '2026-03-31 10:00',
        '2026-04-30 10:00',
        '2026-05-31 10:00',
      ]);
    });

    it('clamps to 29 February in a leap year', () => {
      const occurrences = expand({
        anchorStart: local('2028-01-31T10:00'),
        frequency: 'MONTHLY',
        occurrences: 2,
      });

      expect(localDayAndHour(occurrences[1]!.interval.start)).toBe('2028-02-29 10:00');
    });
  });

  describe('bounds', () => {
    it('caps at maxOccurrences when the count binds first', () => {
      const occurrences = expand({
        anchorStart: local('2026-03-02T10:00'),
        frequency: 'DAILY',
        occurrences: 100,
        maxOccurrences: 26,
      });

      expect(occurrences).toHaveLength(26);
    });

    it('caps at the horizon when the date binds first', () => {
      // 26 fortnightly occurrences would span a year; the six-month horizon stops it sooner.
      const occurrences = expand({
        anchorStart: local('2026-03-02T10:00'),
        frequency: 'BIWEEKLY',
        occurrences: 26,
        maxOccurrences: 26,
        maxHorizonDays: 183,
      });

      expect(occurrences.length).toBeLessThan(26);
      const last = occurrences.at(-1)!.interval.start;
      expect(last.getTime() - local('2026-03-02T10:00').getTime()).toBeLessThanOrEqual(
        183 * 24 * 3_600_000,
      );
    });

    it('rejects a series with no occurrences', () => {
      expect(() => expand({ anchorStart: local('2026-03-02T10:00'), occurrences: 0 })).toThrow(
        /at least one occurrence/i,
      );
    });

    it('rejects an anchor that ends before it starts', () => {
      const anchorStart = local('2026-03-02T10:00');

      expect(() =>
        expand({ anchorStart, anchorEnd: new Date(anchorStart.getTime() - 60_000) }),
      ).toThrow(/end after it starts/i);
    });
  });

  describe('daylight saving', () => {
    it('keeps the local wall-clock time across a spring-forward transition', () => {
      // Europe/London moves to BST on 29 March 2026. A 10:00 session must stay at 10:00 local,
      // which means the UTC instant shifts by an hour — the opposite of what naive UTC
      // arithmetic produces.
      const anchorStart = DateTime.fromISO('2026-03-23T10:00', {
        zone: 'Europe/London',
      }).toJSDate();

      const occurrences = expandRecurrence({
        frequency: 'WEEKLY',
        anchorStart,
        anchorEnd: new Date(anchorStart.getTime() + 60 * 60_000),
        occurrences: 2,
        timezone: 'Europe/London',
        maxOccurrences: 26,
        maxHorizonDays: 183,
      });

      const localTimes = occurrences.map((occurrence) =>
        DateTime.fromJSDate(occurrence.interval.start, { zone: 'Europe/London' }).toFormat('HH:mm'),
      );
      expect(localTimes).toEqual(['10:00', '10:00']);

      const utcTimes = occurrences.map((occurrence) =>
        occurrence.interval.start.toISOString().slice(11, 16),
      );
      expect(utcTimes).toEqual(['10:00', '09:00']);
    });
  });
});

describe('describeHorizonLimit', () => {
  it('reports no truncation when everything requested was produced', () => {
    expect(describeHorizonLimit(4, 4, 26, 183)).toEqual({ truncated: false });
  });

  it('blames the occurrence cap when that is what bound', () => {
    const result = describeHorizonLimit(100, 26, 26, 183);

    expect(result.truncated).toBe(true);
    expect(result.reason).toMatch(/26 occurrences/);
  });

  it('blames the horizon when the count was within the cap', () => {
    const result = describeHorizonLimit(26, 14, 26, 183);

    expect(result.truncated).toBe(true);
    expect(result.reason).toMatch(/183-day/);
  });
});
