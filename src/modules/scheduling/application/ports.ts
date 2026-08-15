import type { Executor } from '@/shared/database/pool.js';
import type { ScheduleRule, ScheduleRuleInput } from '@/modules/scheduling/domain/schedule-rule.js';

export interface TherapistSummary {
  readonly id: string;
  readonly displayName: string;
  readonly specialization: string | null;
}

/**
 * Read-only therapist directory.
 *
 * Every booking flow starts with "which therapist?", so a client needs some way to enumerate
 * them. It is a query with no invariants of its own, which is why it is a separate narrow port
 * rather than another method on the schedule aggregate's repository.
 */
export interface TherapistDirectory {
  list(input: { limit: number; offset: number }): Promise<{
    therapists: TherapistSummary[];
    total: number;
  }>;
}

export interface ScheduleRepository {
  /** Rules currently in effect for a therapist, i.e. what a therapist sees when editing. */
  findCurrentRules(therapistId: string): Promise<ScheduleRule[]>;

  /**
   * Rules whose effective window intersects [from, to]. Used by availability expansion, and
   * accepts an executor so it can participate in the caller's transaction.
   */
  findRulesForRange(
    executor: Executor,
    therapistId: string,
    from: string,
    to: string,
  ): Promise<ScheduleRule[]>;

  /**
   * Replaces the therapist's schedule from `effectiveFrom` onward.
   *
   * Deliberately not a delete-and-insert: superseded rules are closed with an
   * `effective_until` so that historical availability remains reconstructible.
   *
   * Takes an executor so the rule rewrite and the outbox event commit atomically.
   */
  replaceSchedule(
    executor: Executor,
    input: {
      therapistId: string;
      rules: readonly ScheduleRuleInput[];
      effectiveFrom: string;
    },
  ): Promise<ScheduleRule[]>;
}
