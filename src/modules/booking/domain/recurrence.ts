import { DateTime } from 'luxon';
import { validationError } from '@/shared/errors/app-error.js';
import { TimeInterval } from '@/shared/time/interval.js';
import type { RecurrenceFrequency } from '@/shared/domain/vocabulary.js';

/**
 * Expands a recurrence rule into concrete occurrences.
 *
 * Pure and clock-free, which makes every awkward calendar case directly testable. Three
 * decisions are encoded here that the requirements left open:
 *
 * 1. HORIZON. "Repeat weekly" with no end date is unbounded, and generating rows forever is not
 *    an option. Generation stops at min(maxOccurrences, maxHorizonDays) — 26 occurrences or six
 *    months by default. A patient booking a standing weekly session gets six months of
 *    appointments and re-books, which also matches how clinics actually plan.
 *
 * 2. MONTHLY OVERFLOW. "Monthly on the 31st" has no meaning in February. The occurrence is
 *    clamped to the last valid day of the month (28th/29th) rather than silently rolling into
 *    March, which would move the appointment into the wrong month, and rather than being skipped,
 *    which would quietly give the patient fewer sessions than they asked for.
 *    Crucially, clamping does not shift the anchor: after February clamps to the 28th, March
 *    returns to the 31st. Advancing from the clamped date would drag the whole series earlier
 *    month by month.
 *
 * 3. DST. Occurrences are advanced in the therapist's timezone, so a 10:00 session stays at
 *    10:00 local across a daylight-saving transition instead of drifting to 09:00 or 11:00.
 */

export interface RecurrenceInput {
  readonly frequency: RecurrenceFrequency;
  readonly anchorStart: Date;
  readonly anchorEnd: Date;
  /** Requested occurrence count, including the first. Clamped to the configured horizon. */
  readonly occurrences: number;
  readonly timezone: string;
  readonly maxOccurrences: number;
  readonly maxHorizonDays: number;
}

export interface RecurrenceOccurrence {
  readonly index: number;
  readonly interval: TimeInterval;
  /** True when a monthly occurrence was clamped to a shorter month. */
  readonly clamped: boolean;
}

const advance = (anchor: DateTime, frequency: RecurrenceFrequency, step: number): DateTime => {
  switch (frequency) {
    case 'DAILY':
      return anchor.plus({ days: step });
    case 'WEEKLY':
      return anchor.plus({ weeks: step });
    case 'BIWEEKLY':
      return anchor.plus({ weeks: step * 2 });
    case 'MONTHLY':
      // Luxon's plus({ months }) already clamps 31 Jan -> 28 Feb. Computing from the original
      // anchor each time (rather than from the previous occurrence) is what stops the clamp
      // from becoming permanent.
      return anchor.plus({ months: step });
  }
};

export const expandRecurrence = (input: RecurrenceInput): RecurrenceOccurrence[] => {
  const {
    frequency,
    anchorStart,
    anchorEnd,
    occurrences,
    timezone,
    maxOccurrences,
    maxHorizonDays,
  } = input;

  if (occurrences < 1) {
    throw validationError('A recurring series must contain at least one occurrence.');
  }

  if (anchorEnd.getTime() <= anchorStart.getTime()) {
    throw validationError('The first occurrence must end after it starts.');
  }

  const durationMinutes = (anchorEnd.getTime() - anchorStart.getTime()) / 60_000;
  const requested = Math.min(occurrences, maxOccurrences);

  const start = DateTime.fromJSDate(anchorStart, { zone: timezone });
  if (!start.isValid) {
    throw validationError('The first occurrence is not a valid instant.');
  }

  const horizonEnd = start.plus({ days: maxHorizonDays });
  const anchorDay = start.day;

  const result: RecurrenceOccurrence[] = [];

  for (let step = 0; step < requested; step += 1) {
    const occurrenceStart = advance(start, frequency, step);

    // The occurrence-count cap and the horizon cap are both upper bounds; whichever binds first
    // wins, so a daily series stops at 26 occurrences while a monthly one stops at six months.
    if (occurrenceStart > horizonEnd) {
      break;
    }

    const occurrenceEnd = occurrenceStart.plus({ minutes: durationMinutes });

    result.push({
      index: step,
      interval: TimeInterval.of(occurrenceStart.toJSDate(), occurrenceEnd.toJSDate()),
      // Reported so the API can tell the patient that their "31st of each month" booking lands
      // on the 28th in February, rather than leaving them to notice later.
      clamped: frequency === 'MONTHLY' && occurrenceStart.day !== anchorDay,
    });
  }

  return result;
};

/**
 * The effective number of occurrences a request will produce, used to explain truncation to the
 * client before anything is written.
 */
export const describeHorizonLimit = (
  requested: number,
  produced: number,
  maxOccurrences: number,
  maxHorizonDays: number,
): { truncated: boolean; reason?: string } => {
  if (produced >= requested) {
    return { truncated: false };
  }

  return {
    truncated: true,
    reason:
      requested > maxOccurrences
        ? `Limited to ${maxOccurrences} occurrences per series.`
        : `Limited to a ${maxHorizonDays}-day booking horizon.`,
  };
};
