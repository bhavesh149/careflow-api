import { DateTime } from 'luxon';
import type { AppConfig } from '@/shared/config/index.js';
import type { Logger } from '@/shared/logging/index.js';
import type { CacheClient } from '@/shared/cache/index.js';
import type { Database } from '@/shared/database/index.js';
import { appendOutboxEvent, AggregateType, EventType } from '@/shared/events/index.js';
import { withTransaction } from '@/shared/database/unit-of-work.js';
import { validationError } from '@/shared/errors/app-error.js';
import {
  validateWeeklyRules,
  type ScheduleRule,
  type ScheduleRuleInput,
} from '@/modules/scheduling/domain/schedule-rule.js';
import type { ScheduleRepository } from '@/modules/scheduling/application/ports.js';

/**
 * Schedule read/write use cases.
 *
 * The invariant that matters here is I7: changing a schedule must never mutate an existing
 * appointment. This service therefore only ever writes to `therapist_schedules`. There is no
 * code path from a schedule edit to the appointments table, which is a much stronger guarantee
 * than "we remember not to cascade".
 *
 * A therapist who removes Monday hours keeps every Monday appointment already booked; those
 * simply stop being offered to new patients. If they want to free the time they cancel the
 * appointments explicitly, which notifies the patients.
 */

/**
 * Response DTO. Arrays are mutable rather than readonly so they satisfy the Zod-inferred
 * response type that Fastify's `send` expects; deep-readonly DTOs would force a copy at every
 * route for no safety benefit at the serialisation boundary.
 */
export interface ScheduleView {
  readonly rules: {
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
  }[];
  readonly timezone: string;
  readonly slotGranularityMinutes: number;
}

export interface ScheduleService {
  getSchedule(therapistId: string): Promise<ScheduleView>;
  replaceSchedule(input: {
    therapistId: string;
    rules: readonly ScheduleRuleInput[];
    effectiveFrom?: string;
    requestId: string;
  }): Promise<ScheduleView>;
}

/** Cache key prefix; schedule reads are cached per therapist and invalidated on write. */
export const scheduleCacheKey = (therapistId: string): string => `schedule:v1:${therapistId}`;

const toView = (rules: readonly ScheduleRule[], config: AppConfig): ScheduleView => ({
  rules: rules.map((rule) => ({
    dayOfWeek: rule.dayOfWeek,
    // Normalise 'HH:MM:SS' from Postgres down to the 'HH:MM' the API contract specifies.
    startTime: rule.startTime.slice(0, 5),
    endTime: rule.endTime.slice(0, 5),
    effectiveFrom: rule.effectiveFrom,
    effectiveUntil: rule.effectiveUntil,
  })),
  timezone: config.APP_TIMEZONE,
  slotGranularityMinutes: config.SLOT_GRANULARITY_MINUTES,
});

export const createScheduleService = (dependencies: {
  config: AppConfig;
  logger: Logger;
  db: Database;
  cache: CacheClient;
  schedules: ScheduleRepository;
}): ScheduleService => {
  const { config, logger, db, cache, schedules } = dependencies;

  return {
    getSchedule: async (therapistId) => {
      const cacheKey = scheduleCacheKey(therapistId);
      const cached = await cache.get(cacheKey);

      if (cached !== null) {
        try {
          return JSON.parse(cached) as ScheduleView;
        } catch {
          // A corrupt entry is not worth an error; fall through and refresh it.
        }
      }

      const rules = await schedules.findCurrentRules(therapistId);
      const view = toView(rules, config);

      // Short TTL: schedules change rarely, but a stale read here only affects what the
      // therapist sees while editing, never whether a booking is allowed.
      await cache.set(cacheKey, JSON.stringify(view), 300);

      return view;
    },

    replaceSchedule: async ({ therapistId, rules, effectiveFrom, requestId }) => {
      validateWeeklyRules(rules, config.SLOT_GRANULARITY_MINUTES);

      const today = DateTime.now().setZone(config.APP_TIMEZONE).startOf('day');
      const effectiveDate = effectiveFrom
        ? DateTime.fromISO(effectiveFrom, { zone: config.APP_TIMEZONE }).startOf('day')
        : today;

      if (!effectiveDate.isValid) {
        throw validationError('effectiveFrom must be a valid calendar date.');
      }

      // Backdating would rewrite the availability that past bookings were made against, so the
      // audit trail would no longer explain why those appointments were allowed.
      if (effectiveDate < today) {
        throw validationError('A schedule change cannot take effect in the past.', {
          effectiveFrom: effectiveDate.toISODate(),
          today: today.toISODate(),
        });
      }

      const effectiveFromIso = effectiveDate.toISODate();
      if (effectiveFromIso === null) {
        throw validationError('effectiveFrom must be a valid calendar date.');
      }

      const updated = await withTransaction(db, async (tx) => {
        const result = await schedules.replaceSchedule(tx, {
          therapistId,
          rules,
          effectiveFrom: effectiveFromIso,
        });

        // Same transaction as the schedule write: if the commit fails, no event is emitted.
        await appendOutboxEvent(tx, {
          aggregateType: AggregateType.THERAPIST_SCHEDULE,
          aggregateId: therapistId,
          eventType: EventType.SCHEDULE_UPDATED,
          payload: {
            therapistId,
            effectiveFrom: effectiveFromIso,
            ruleCount: rules.length,
            requestId,
          },
        });

        return result;
      });

      // Invalidate rather than update-in-place: the next read repopulates from the source of
      // truth, so a failed cache write degrades to a miss instead of serving a wrong schedule.
      await cache.del(scheduleCacheKey(therapistId));

      logger.info(
        {
          therapistId,
          ruleCount: rules.length,
          effectiveFrom: effectiveFromIso,
          event: 'schedule.updated',
        },
        'therapist schedule replaced',
      );

      return toView(updated, config);
    },
  };
};
