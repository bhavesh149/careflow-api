import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  expandSlots,
  subtractBusyIntervals,
} from '@/modules/availability/domain/availability-calculator.js';
import { TimeInterval } from '@/shared/time/interval.js';
import type { ScheduleRule } from '@/modules/scheduling/domain/schedule-rule.js';

/**
 * Slot expansion is the one place a *rule* ("Mondays 09:00-13:00") becomes *instants*, so it owns
 * the timezone and partial-slot decisions. Everything here is pure, which is why these cases can
 * be pinned down exactly rather than inferred from an end-to-end run.
 */

const TIMEZONE = 'Asia/Kolkata';

const rule = (overrides: Partial<ScheduleRule> = {}): ScheduleRule => ({
  id: 'rule-1',
  therapistId: 'therapist-1',
  // Luxon weekdays: 1 = Monday.
  dayOfWeek: 1,
  startTime: '09:00',
  endTime: '13:00',
  effectiveFrom: '2026-01-01',
  effectiveUntil: null,
  ...overrides,
});

const localTimes = (slots: readonly { interval: TimeInterval }[], zone = TIMEZONE): string[] =>
  slots.map((slot) => DateTime.fromJSDate(slot.interval.start, { zone }).toFormat('yyyy-MM-dd HH:mm'));

const interval = (startIso: string, endIso: string): TimeInterval =>
  TimeInterval.of(
    DateTime.fromISO(startIso, { zone: TIMEZONE }).toJSDate(),
    DateTime.fromISO(endIso, { zone: TIMEZONE }).toJSDate(),
  );

describe('expandSlots', () => {
  it('expands a rule into whole slots of the configured granularity', () => {
    // 2 March 2026 is a Monday.
    const slots = expandSlots({
      rules: [rule()],
      fromDate: '2026-03-02',
      toDate: '2026-03-02',
      timezone: TIMEZONE,
      slotGranularityMinutes: 60,
    });

    expect(localTimes(slots)).toEqual([
      '2026-03-02 09:00',
      '2026-03-02 10:00',
      '2026-03-02 11:00',
      '2026-03-02 12:00',
    ]);
    expect(slots.every((slot) => slot.interval.durationMinutes === 60)).toBe(true);
  });

  it('never emits a partial trailing slot', () => {
    // 09:00-10:30 with 60-minute slots yields one slot, not one and a half. Offering the
    // remainder would create a booking the therapist's schedule does not cover.
    const slots = expandSlots({
      rules: [rule({ startTime: '09:00', endTime: '10:30' })],
      fromDate: '2026-03-02',
      toDate: '2026-03-02',
      timezone: TIMEZONE,
      slotGranularityMinutes: 60,
    });

    expect(localTimes(slots)).toEqual(['2026-03-02 09:00']);
  });

  it('only applies a rule on its own weekday', () => {
    const slots = expandSlots({
      rules: [rule({ dayOfWeek: 3 })],
      fromDate: '2026-03-02',
      toDate: '2026-03-08',
      timezone: TIMEZONE,
      slotGranularityMinutes: 60,
    });

    // 4 March 2026 is the Wednesday of that week.
    expect(new Set(localTimes(slots).map((value) => value.slice(0, 10)))).toEqual(
      new Set(['2026-03-04']),
    );
  });

  it('returns slots in chronological order across rules and days', () => {
    const slots = expandSlots({
      rules: [
        rule({ id: 'afternoon', dayOfWeek: 2, startTime: '14:00', endTime: '16:00' }),
        rule({ id: 'morning', dayOfWeek: 1, startTime: '09:00', endTime: '11:00' }),
      ],
      fromDate: '2026-03-02',
      toDate: '2026-03-03',
      timezone: TIMEZONE,
      slotGranularityMinutes: 60,
    });

    expect(localTimes(slots)).toEqual([
      '2026-03-02 09:00',
      '2026-03-02 10:00',
      '2026-03-03 14:00',
      '2026-03-03 15:00',
    ]);
  });

  describe('effective dating', () => {
    it('ignores a rule before it takes effect', () => {
      const slots = expandSlots({
        rules: [rule({ effectiveFrom: '2026-03-09' })],
        fromDate: '2026-03-02',
        toDate: '2026-03-02',
        timezone: TIMEZONE,
        slotGranularityMinutes: 60,
      });

      expect(slots).toEqual([]);
    });

    it('treats effectiveUntil as inclusive', () => {
      const slots = expandSlots({
        rules: [rule({ effectiveUntil: '2026-03-02' })],
        fromDate: '2026-03-02',
        toDate: '2026-03-09',
        timezone: TIMEZONE,
        slotGranularityMinutes: 60,
      });

      // The 2nd is included; the following Monday is past the window.
      expect(new Set(localTimes(slots).map((value) => value.slice(0, 10)))).toEqual(
        new Set(['2026-03-02']),
      );
    });
  });

  describe('the past is not bookable', () => {
    it('omits slots at or before notBefore', () => {
      const slots = expandSlots({
        rules: [rule()],
        fromDate: '2026-03-02',
        toDate: '2026-03-02',
        timezone: TIMEZONE,
        slotGranularityMinutes: 60,
        notBefore: DateTime.fromISO('2026-03-02T10:30', { zone: TIMEZONE }).toJSDate(),
      });

      expect(localTimes(slots)).toEqual(['2026-03-02 11:00', '2026-03-02 12:00']);
    });

    it('omits a slot starting exactly at notBefore, because it is already under way', () => {
      const slots = expandSlots({
        rules: [rule()],
        fromDate: '2026-03-02',
        toDate: '2026-03-02',
        timezone: TIMEZONE,
        slotGranularityMinutes: 60,
        notBefore: DateTime.fromISO('2026-03-02T11:00', { zone: TIMEZONE }).toJSDate(),
      });

      expect(localTimes(slots)).toEqual(['2026-03-02 12:00']);
    });
  });

  describe('timezones', () => {
    it('interprets wall-clock times in the therapist zone, not UTC', () => {
      const slots = expandSlots({
        rules: [rule({ startTime: '09:00', endTime: '10:00' })],
        fromDate: '2026-03-02',
        toDate: '2026-03-02',
        timezone: TIMEZONE,
        slotGranularityMinutes: 60,
      });

      // Asia/Kolkata is UTC+05:30, so 09:00 local is 03:30 UTC.
      expect(slots[0]!.interval.start.toISOString()).toBe('2026-03-02T03:30:00.000Z');
    });

    it('keeps the local start time across a daylight-saving transition', () => {
      // Europe/London switches to BST on 29 March 2026, between these two Mondays.
      const slots = expandSlots({
        rules: [rule({ startTime: '09:00', endTime: '10:00', effectiveFrom: '2026-01-01' })],
        fromDate: '2026-03-23',
        toDate: '2026-03-30',
        timezone: 'Europe/London',
        slotGranularityMinutes: 60,
      });

      expect(localTimes(slots, 'Europe/London')).toEqual([
        '2026-03-23 09:00',
        '2026-03-30 09:00',
      ]);
      expect(slots.map((slot) => slot.interval.start.toISOString().slice(11, 16))).toEqual([
        '09:00',
        '08:00',
      ]);
    });
  });

  describe('degenerate input', () => {
    it('returns nothing without rules', () => {
      expect(
        expandSlots({
          rules: [],
          fromDate: '2026-03-02',
          toDate: '2026-03-09',
          timezone: TIMEZONE,
          slotGranularityMinutes: 60,
        }),
      ).toEqual([]);
    });

    it('returns nothing when the range is inverted', () => {
      expect(
        expandSlots({
          rules: [rule()],
          fromDate: '2026-03-09',
          toDate: '2026-03-02',
          timezone: TIMEZONE,
          slotGranularityMinutes: 60,
        }),
      ).toEqual([]);
    });
  });
});

describe('subtractBusyIntervals', () => {
  const slots = [
    { interval: interval('2026-03-02T09:00', '2026-03-02T10:00') },
    { interval: interval('2026-03-02T10:00', '2026-03-02T11:00') },
    { interval: interval('2026-03-02T11:00', '2026-03-02T12:00') },
  ];

  it('returns every slot when nothing is busy', () => {
    expect(subtractBusyIntervals(slots, [])).toHaveLength(3);
  });

  it('removes a slot an appointment overlaps', () => {
    const available = subtractBusyIntervals(slots, [
      interval('2026-03-02T10:15', '2026-03-02T10:45'),
    ]);

    expect(localTimes(available)).toEqual(['2026-03-02 09:00', '2026-03-02 11:00']);
  });

  it('keeps back-to-back slots, because intervals are half-open', () => {
    // This is the case closed intervals get wrong: an appointment ending exactly at 10:00 must
    // not block the 10:00 slot, or no clinic could ever book consecutive sessions.
    const available = subtractBusyIntervals(slots, [
      interval('2026-03-02T09:00', '2026-03-02T10:00'),
    ]);

    expect(localTimes(available)).toEqual(['2026-03-02 10:00', '2026-03-02 11:00']);
  });

  it('removes several slots covered by one long booking', () => {
    const available = subtractBusyIntervals(slots, [
      interval('2026-03-02T09:30', '2026-03-02T11:30'),
    ]);

    expect(available).toEqual([]);
  });

  it('handles unsorted busy intervals', () => {
    const available = subtractBusyIntervals(slots, [
      interval('2026-03-02T11:00', '2026-03-02T12:00'),
      interval('2026-03-02T09:00', '2026-03-02T10:00'),
    ]);

    expect(localTimes(available)).toEqual(['2026-03-02 10:00']);
  });

  it('ignores busy intervals outside the slot range', () => {
    const available = subtractBusyIntervals(slots, [
      interval('2026-03-02T06:00', '2026-03-02T07:00'),
      interval('2026-03-02T18:00', '2026-03-02T19:00'),
    ]);

    expect(available).toHaveLength(3);
  });
});
