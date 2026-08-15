import { describe, expect, it } from 'vitest';
import {
  Weekday,
  ruleDurationMinutes,
  validateWeeklyRules,
} from '@/modules/scheduling/domain/schedule-rule.js';

/**
 * The database also refuses overlapping blocks, via the GiST exclusion constraint. These checks
 * exist so the therapist gets a message naming the offending pair instead of a raw constraint
 * violation — the application explains, the database guarantees.
 */

const SLOT = 60;

const block = (dayOfWeek: number, startTime: string, endTime: string) => ({
  dayOfWeek,
  startTime,
  endTime,
});

describe('ruleDurationMinutes', () => {
  it('measures a block in minutes', () => {
    expect(ruleDurationMinutes(block(Weekday.MONDAY, '09:00', '13:00'))).toBe(240);
    expect(ruleDurationMinutes(block(Weekday.MONDAY, '09:30', '10:00'))).toBe(30);
  });
});

describe('validateWeeklyRules', () => {
  it('accepts an empty week as "not taking appointments"', () => {
    // Deliberately legal, and it must not touch appointments already booked.
    expect(() => validateWeeklyRules([], SLOT)).not.toThrow();
  });

  it('accepts several blocks on the same day with a gap between them', () => {
    expect(() =>
      validateWeeklyRules(
        [block(Weekday.MONDAY, '09:00', '13:00'), block(Weekday.MONDAY, '14:00', '18:00')],
        SLOT,
      ),
    ).not.toThrow();
  });

  it('accepts adjacent blocks, because the comparison is half-open', () => {
    expect(() =>
      validateWeeklyRules(
        [block(Weekday.MONDAY, '09:00', '13:00'), block(Weekday.MONDAY, '13:00', '17:00')],
        SLOT,
      ),
    ).not.toThrow();
  });

  it('accepts identical hours on different days', () => {
    expect(() =>
      validateWeeklyRules(
        [block(Weekday.MONDAY, '09:00', '13:00'), block(Weekday.TUESDAY, '09:00', '13:00')],
        SLOT,
      ),
    ).not.toThrow();
  });

  it('rejects a block that ends before it starts', () => {
    expect(() => validateWeeklyRules([block(Weekday.MONDAY, '13:00', '09:00')], SLOT)).toThrow(
      /end after it starts/i,
    );
  });

  it('rejects a zero-length block', () => {
    expect(() => validateWeeklyRules([block(Weekday.MONDAY, '09:00', '09:00')], SLOT)).toThrow(
      /end after it starts/i,
    );
  });

  it('rejects a block shorter than one slot', () => {
    // Accepting it would advertise availability no patient could ever book.
    expect(() => validateWeeklyRules([block(Weekday.MONDAY, '09:00', '09:30')], SLOT)).toThrow(
      /at least the slot length/i,
    );
  });

  it('rejects overlapping blocks on the same day and names both', () => {
    try {
      validateWeeklyRules(
        [block(Weekday.MONDAY, '09:00', '13:00'), block(Weekday.MONDAY, '12:00', '16:00')],
        SLOT,
      );
      expect.unreachable('the overlap should have been refused');
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect(details.dayOfWeek).toBe(Weekday.MONDAY);
      expect(details.first).toEqual({ startTime: '09:00', endTime: '13:00' });
      expect(details.second).toEqual({ startTime: '12:00', endTime: '16:00' });
    }
  });

  it('detects an overlap regardless of the order submitted', () => {
    expect(() =>
      validateWeeklyRules(
        [block(Weekday.MONDAY, '12:00', '16:00'), block(Weekday.MONDAY, '09:00', '13:00')],
        SLOT,
      ),
    ).toThrow(/must not overlap/i);
  });

  it('detects a block fully contained in another', () => {
    expect(() =>
      validateWeeklyRules(
        [block(Weekday.MONDAY, '09:00', '17:00'), block(Weekday.MONDAY, '10:00', '11:00')],
        SLOT,
      ),
    ).toThrow(/must not overlap/i);
  });

  it('reports a validation error the API can return as 400', () => {
    try {
      validateWeeklyRules([block(Weekday.MONDAY, '09:00', '09:15')], SLOT);
      expect.unreachable('the block should have been refused');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('VALIDATION_ERROR');
      expect((error as { httpStatus?: number }).httpStatus).toBe(400);
    }
  });
});
