import { validationError } from '@/shared/errors/app-error.js';

/**
 * A therapist's weekly availability rule: "Mondays, 09:00-13:00, effective from 1 March".
 *
 * This is a *rule*, not a set of slots. Storing rules rather than materialised future slots is
 * what keeps the data bounded and lets a therapist change next month's hours without touching
 * a single existing appointment.
 */

/** ISO-8601 weekday numbering, matching Luxon and Postgres `isodow`. */
export const Weekday = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7,
} as const;

export interface ScheduleRule {
  readonly id: string;
  readonly therapistId: string;
  readonly dayOfWeek: number;
  /** Wall-clock 'HH:MM' in the application timezone. */
  readonly startTime: string;
  readonly endTime: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}

/** The shape a therapist submits; ids and effective dates are assigned by the application. */
export interface ScheduleRuleInput {
  readonly dayOfWeek: number;
  readonly startTime: string;
  readonly endTime: string;
}

const toMinutes = (time: string): number => {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
};

export const ruleDurationMinutes = (rule: ScheduleRuleInput): number =>
  toMinutes(rule.endTime) - toMinutes(rule.startTime);

/**
 * Validates a submitted week of rules before it reaches the database.
 *
 * The database enforces non-overlap too (via the GiST exclusion constraint), but catching it
 * here produces a precise, actionable message naming the offending pair instead of a generic
 * constraint violation. Belt and braces: the application explains, the database guarantees.
 */
export const validateWeeklyRules = (
  rules: readonly ScheduleRuleInput[],
  slotGranularityMinutes: number,
): void => {
  if (rules.length === 0) {
    // An empty week is legitimate: it means "I am not taking appointments". Existing
    // appointments are unaffected, which is invariant I7.
    return;
  }

  for (const rule of rules) {
    if (toMinutes(rule.endTime) <= toMinutes(rule.startTime)) {
      throw validationError('A schedule block must end after it starts.', {
        dayOfWeek: rule.dayOfWeek,
        startTime: rule.startTime,
        endTime: rule.endTime,
      });
    }

    // A block shorter than one slot can never yield a bookable slot, so accepting it would
    // silently produce availability the patient can never use.
    if (ruleDurationMinutes(rule) < slotGranularityMinutes) {
      throw validationError(
        `A schedule block must be at least the slot length of ${slotGranularityMinutes} minutes.`,
        { dayOfWeek: rule.dayOfWeek, startTime: rule.startTime, endTime: rule.endTime },
      );
    }
  }

  const byDay = new Map<number, ScheduleRuleInput[]>();
  for (const rule of rules) {
    const existing = byDay.get(rule.dayOfWeek);
    if (existing) {
      existing.push(rule);
    } else {
      byDay.set(rule.dayOfWeek, [rule]);
    }
  }

  for (const [dayOfWeek, dayRules] of byDay) {
    const sorted = [...dayRules].sort(
      (left, right) => toMinutes(left.startTime) - toMinutes(right.startTime),
    );

    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (!previous || !current) continue;

      // Half-open comparison: a block ending at 13:00 and one starting at 13:00 are adjacent,
      // not overlapping, and must remain allowed.
      if (toMinutes(current.startTime) < toMinutes(previous.endTime)) {
        throw validationError('Schedule blocks on the same day must not overlap.', {
          dayOfWeek,
          first: { startTime: previous.startTime, endTime: previous.endTime },
          second: { startTime: current.startTime, endTime: current.endTime },
        });
      }
    }
  }
};
