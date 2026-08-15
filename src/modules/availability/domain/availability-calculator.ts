import { DateTime } from 'luxon';
import { TimeInterval } from '@/shared/time/interval.js';
import type { ScheduleRule } from '@/modules/scheduling/domain/schedule-rule.js';

/**
 * Turns weekly schedule rules into concrete bookable slots.
 *
 * This is the only place the system converts a *rule* ("Mondays 09:00-13:00") into *instants*.
 * It is pure: no database, no clock, no framework. That matters because the timezone and
 * daylight-saving edge cases here are exactly what unit tests need to pin down, and a pure
 * function makes them trivial to write.
 *
 * Timezone handling is the subtle part. `09:00` is wall-clock time in the therapist's zone, so
 * expansion must build the instant *in that zone* and then convert to UTC. Doing the arithmetic
 * in UTC and adding an offset afterwards breaks across a DST boundary: the therapist still
 * starts at 09:00 local, but that is a different UTC instant before and after the transition.
 * Luxon resolves the zone per date, so this is handled correctly even though the current
 * deployment timezone (Asia/Kolkata) has no DST.
 */

export interface AvailabilitySlot {
  readonly interval: TimeInterval;
}

export interface ExpandSlotsInput {
  readonly rules: readonly ScheduleRule[];
  /** Inclusive calendar date bounds, 'YYYY-MM-DD', interpreted in `timezone`. */
  readonly fromDate: string;
  readonly toDate: string;
  readonly timezone: string;
  readonly slotGranularityMinutes: number;
  /** Slots starting at or before this instant are omitted; the past is not bookable. */
  readonly notBefore?: Date;
}

const parseWallClock = (time: string): { hour: number; minute: number } => {
  const [hours, minutes] = time.split(':');
  return { hour: Number(hours), minute: Number(minutes ?? '0') };
};

/**
 * A rule applies on a date when the weekday matches and the date falls inside the rule's
 * effective window. `effectiveUntil` is inclusive: "effective through 31 March" includes the 31st.
 */
const ruleAppliesOn = (rule: ScheduleRule, date: DateTime): boolean => {
  if (rule.dayOfWeek !== date.weekday) {
    return false;
  }

  const isoDate = date.toISODate();
  if (isoDate === null) {
    return false;
  }

  if (isoDate < rule.effectiveFrom) {
    return false;
  }

  return rule.effectiveUntil === null || isoDate <= rule.effectiveUntil;
};

export const expandSlots = (input: ExpandSlotsInput): AvailabilitySlot[] => {
  const { rules, timezone, slotGranularityMinutes, notBefore } = input;

  if (rules.length === 0) {
    return [];
  }

  const start = DateTime.fromISO(input.fromDate, { zone: timezone }).startOf('day');
  const end = DateTime.fromISO(input.toDate, { zone: timezone }).startOf('day');

  if (!start.isValid || !end.isValid || end < start) {
    return [];
  }

  const slots: AvailabilitySlot[] = [];
  const notBeforeMs = notBefore?.getTime() ?? Number.NEGATIVE_INFINITY;

  for (let date = start; date <= end; date = date.plus({ days: 1 })) {
    for (const rule of rules) {
      if (!ruleAppliesOn(rule, date)) {
        continue;
      }

      const from = parseWallClock(rule.startTime);
      const to = parseWallClock(rule.endTime);

      const blockStart = date.set({
        hour: from.hour,
        minute: from.minute,
        second: 0,
        millisecond: 0,
      });
      const blockEnd = date.set({ hour: to.hour, minute: to.minute, second: 0, millisecond: 0 });

      let cursor = blockStart;

      while (cursor < blockEnd) {
        const slotEnd = cursor.plus({ minutes: slotGranularityMinutes });

        // Never emit a partial slot. A 09:00-09:30 remainder inside a 60-minute granularity is
        // not a bookable appointment, and offering it would produce a booking the therapist's
        // schedule does not actually cover.
        if (slotEnd > blockEnd) {
          break;
        }

        const startDate = cursor.toJSDate();

        if (startDate.getTime() > notBeforeMs) {
          slots.push({ interval: TimeInterval.of(startDate, slotEnd.toJSDate()) });
        }

        cursor = slotEnd;
      }
    }
  }

  // Rules are grouped by weekday in the query, so slots arrive per-rule rather than in
  // chronological order. Clients render a timeline, so sort once here instead of making every
  // consumer remember to.
  return slots.sort(
    (left, right) => left.interval.start.getTime() - right.interval.start.getTime(),
  );
};

/**
 * Removes slots that collide with something already occupying the therapist's time.
 *
 * Kept separate from expansion so both halves can be tested in isolation, and so the caller
 * decides what counts as blocking (confirmed appointments, live holds, or both).
 */
export const subtractBusyIntervals = (
  slots: readonly AvailabilitySlot[],
  busy: readonly TimeInterval[],
): AvailabilitySlot[] => {
  if (busy.length === 0) {
    return [...slots];
  }

  // Sorted once so the scan below can advance a single pointer instead of rechecking every
  // busy interval for every slot. Both inputs are bounded by the query's date range, but an
  // O(n*m) scan over a 60-day window with a busy therapist is needless work.
  const sortedBusy = [...busy].sort((left, right) => left.start.getTime() - right.start.getTime());
  const available: AvailabilitySlot[] = [];
  let busyIndex = 0;

  for (const slot of slots) {
    // Skip busy intervals that ended before this slot starts; they cannot affect later slots
    // either, because both lists are sorted.
    while (busyIndex < sortedBusy.length) {
      const candidate = sortedBusy[busyIndex];
      if (candidate && candidate.end.getTime() <= slot.interval.start.getTime()) {
        busyIndex += 1;
      } else {
        break;
      }
    }

    let blocked = false;
    for (let index = busyIndex; index < sortedBusy.length; index += 1) {
      const candidate = sortedBusy[index];
      if (!candidate) continue;

      // Sorted by start, so once a busy interval starts at or after the slot ends, no later
      // one can overlap this slot.
      if (candidate.start.getTime() >= slot.interval.end.getTime()) {
        break;
      }

      if (candidate.overlaps(slot.interval)) {
        blocked = true;
        break;
      }
    }

    if (!blocked) {
      available.push(slot);
    }
  }

  return available;
};
