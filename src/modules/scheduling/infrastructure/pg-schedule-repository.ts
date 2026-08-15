import { sql } from 'drizzle-orm';
import type { Database, Executor } from '@/shared/database/pool.js';
import { scheduleConflict } from '@/shared/errors/domain-errors.js';
import { ConstraintName, isConstraintViolation } from '@/shared/database/pg-errors.js';
import type { ScheduleRepository } from '@/modules/scheduling/application/ports.js';
import type { ScheduleRule } from '@/modules/scheduling/domain/schedule-rule.js';

type ScheduleRuleRow = {
  id: string;
  therapistId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
};

const SELECT_COLUMNS = sql`
  id,
  therapist_id    AS "therapistId",
  day_of_week     AS "dayOfWeek",
  start_time      AS "startTime",
  end_time        AS "endTime",
  effective_from  AS "effectiveFrom",
  effective_until AS "effectiveUntil"
`;

export const createPgScheduleRepository = (db: Database): ScheduleRepository => ({
  findCurrentRules: async (therapistId: string): Promise<ScheduleRule[]> => {
    const result = await db.execute<ScheduleRuleRow>(sql`
      SELECT ${SELECT_COLUMNS}
        FROM therapist_schedules
       WHERE therapist_id = ${therapistId}::uuid
         AND (effective_until IS NULL OR effective_until >= CURRENT_DATE)
       ORDER BY day_of_week, start_time
    `);

    return [...result.rows];
  },

  /**
   * Overlap rather than containment: a rule effective 1 Jan - 31 Mar is relevant to a query for
   * March even though it neither starts nor ends inside the window. Getting this wrong silently
   * drops availability at range boundaries.
   */
  findRulesForRange: async (
    executor: Executor,
    therapistId: string,
    from: string,
    to: string,
  ): Promise<ScheduleRule[]> => {
    const result = await executor.execute<ScheduleRuleRow>(sql`
      SELECT ${SELECT_COLUMNS}
        FROM therapist_schedules
       WHERE therapist_id = ${therapistId}::uuid
         AND effective_from <= ${to}::date
         AND (effective_until IS NULL OR effective_until >= ${from}::date)
       ORDER BY day_of_week, start_time
    `);

    return [...result.rows];
  },

  /**
   * Effective-dated replacement, in three steps:
   *
   *   1. Delete rules that were only ever going to start on or after the new effective date.
   *      They never took effect, so there is no history worth keeping.
   *   2. Close rules currently in effect by setting effective_until to the day before the new
   *      date, preserving what availability looked like when past bookings were made.
   *   3. Insert the new week.
   *
   * The alternative — deleting everything and inserting the new set — would destroy the record
   * of why a past appointment was bookable, which is exactly the question asked during a
   * dispute.
   */
  replaceSchedule: async (
    executor,
    { therapistId, rules, effectiveFrom },
  ): Promise<ScheduleRule[]> => {
    await executor.execute(sql`
      DELETE FROM therapist_schedules
       WHERE therapist_id = ${therapistId}::uuid
         AND effective_from >= ${effectiveFrom}::date
    `);

    await executor.execute(sql`
      UPDATE therapist_schedules
         SET effective_until = (${effectiveFrom}::date - interval '1 day')::date
       WHERE therapist_id = ${therapistId}::uuid
         AND effective_from < ${effectiveFrom}::date
         AND (effective_until IS NULL OR effective_until >= ${effectiveFrom}::date)
    `);

    if (rules.length > 0) {
      const values = rules.map(
        (rule) =>
          sql`(${therapistId}::uuid, ${rule.dayOfWeek}, ${rule.startTime}::time, ${rule.endTime}::time, ${effectiveFrom}::date)`,
      );

      try {
        await executor.execute(sql`
          INSERT INTO therapist_schedules (therapist_id, day_of_week, start_time, end_time, effective_from)
          VALUES ${sql.join(values, sql`, `)}
        `);
      } catch (error) {
        // The application already checks for overlap and reports it precisely; reaching here
        // means the database caught something the check missed, so translate rather than 500.
        if (isConstraintViolation(error, ConstraintName.THERAPIST_SCHEDULES_NO_OVERLAP)) {
          throw scheduleConflict('The submitted schedule blocks overlap each other.');
        }
        throw error;
      }
    }

    const result = await executor.execute<ScheduleRuleRow>(sql`
      SELECT ${SELECT_COLUMNS}
        FROM therapist_schedules
       WHERE therapist_id = ${therapistId}::uuid
         AND (effective_until IS NULL OR effective_until >= ${effectiveFrom}::date)
       ORDER BY day_of_week, start_time
    `);

    return [...result.rows];
  },
});
