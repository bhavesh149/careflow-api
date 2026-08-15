import { describe, expect, it } from 'vitest';
import {
  THERAPIST_OUTCOME_STATUSES,
  assertTransitionAllowed,
  assertWithinStatusWindow,
  canCancel,
  canTransition,
} from '@/modules/booking/domain/appointment.js';
import type { AppointmentStatus } from '@/shared/domain/vocabulary.js';

/**
 * The lifecycle rules, asserted exhaustively rather than by example: a state machine with a gap
 * is how "cancelled" appointments come back to life on top of somebody else's booking.
 */

const ALL: readonly AppointmentStatus[] = ['SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];
const TERMINAL: readonly AppointmentStatus[] = ['COMPLETED', 'NO_SHOW', 'CANCELLED'];

const at = (iso: string): Date => new Date(iso);

describe('appointment state machine', () => {
  it('allows exactly the three moves out of SCHEDULED', () => {
    const allowed = ALL.filter((to) => canTransition('SCHEDULED', to));

    expect(allowed).toEqual(['COMPLETED', 'NO_SHOW', 'CANCELLED']);
  });

  it('treats every terminal status as genuinely terminal', () => {
    for (const from of TERMINAL) {
      for (const to of ALL) {
        expect(canTransition(from, to), `${from} -> ${to} must be refused`).toBe(false);
      }
    }
  });

  it('refuses to revive a cancelled appointment', () => {
    // The slot became publicly bookable the moment it was cancelled, so un-cancelling could
    // resurrect this appointment on top of one somebody else has since booked.
    expect(() => assertTransitionAllowed('CANCELLED', 'SCHEDULED')).toThrow();
  });

  it('reports an invalid transition as a client-visible conflict, not a crash', () => {
    try {
      assertTransitionAllowed('COMPLETED', 'CANCELLED');
      expect.unreachable('the transition should have been refused');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('INVALID_STATUS_TRANSITION');
      expect((error as { httpStatus?: number }).httpStatus).toBe(409);
    }
  });

  it('offers therapists only the two outcome statuses', () => {
    expect([...THERAPIST_OUTCOME_STATUSES]).toEqual(['COMPLETED', 'NO_SHOW']);
  });
});

describe('assertWithinStatusWindow', () => {
  const appointment = {
    startTime: at('2026-03-02T09:00:00.000Z'),
    endTime: at('2026-03-02T10:00:00.000Z'),
  };
  const graceHours = 24;

  it('rejects recording an outcome before the session starts', () => {
    // Marking a session complete before it happens would corrupt reporting.
    expect(() =>
      assertWithinStatusWindow(appointment, at('2026-03-02T08:59:59.000Z'), graceHours),
    ).toThrow();
  });

  it('accepts the moment the session starts', () => {
    expect(() =>
      assertWithinStatusWindow(appointment, at('2026-03-02T09:00:00.000Z'), graceHours),
    ).not.toThrow();
  });

  it('accepts during the session and within the grace period', () => {
    for (const now of ['2026-03-02T09:30:00.000Z', '2026-03-02T23:00:00.000Z']) {
      expect(() => assertWithinStatusWindow(appointment, at(now), graceHours)).not.toThrow();
    }
  });

  it('accepts the last instant of the grace period and rejects the next', () => {
    expect(() =>
      assertWithinStatusWindow(appointment, at('2026-03-03T10:00:00.000Z'), graceHours),
    ).not.toThrow();
    expect(() =>
      assertWithinStatusWindow(appointment, at('2026-03-03T10:00:01.000Z'), graceHours),
    ).toThrow();
  });

  it('explains the window it enforced', () => {
    try {
      assertWithinStatusWindow(appointment, at('2026-03-10T00:00:00.000Z'), graceHours);
      expect.unreachable('the update should have been refused');
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect(details.windowStart).toBe('2026-03-02T09:00:00.000Z');
      expect(details.windowEnd).toBe('2026-03-03T10:00:00.000Z');
    }
  });
});

describe('canCancel', () => {
  const startTime = at('2026-03-02T09:00:00.000Z');

  it('allows cancelling a scheduled appointment that has not started', () => {
    expect(canCancel({ startTime, status: 'SCHEDULED' }, at('2026-03-02T08:00:00.000Z'))).toBe(
      true,
    );
  });

  it('refuses once the appointment has started', () => {
    // From the start time onwards the session either happened or the patient did not turn up,
    // and both are outcomes for the therapist to record rather than history to erase.
    expect(canCancel({ startTime, status: 'SCHEDULED' }, startTime)).toBe(false);
    expect(canCancel({ startTime, status: 'SCHEDULED' }, at('2026-03-02T09:30:00.000Z'))).toBe(
      false,
    );
  });

  it('refuses for any non-scheduled status', () => {
    for (const status of TERMINAL) {
      expect(canCancel({ startTime, status }, at('2026-03-01T00:00:00.000Z'))).toBe(false);
    }
  });
});
