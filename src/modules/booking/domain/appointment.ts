import { invalidStatusTransition, outsideStatusWindow } from '@/shared/errors/domain-errors.js';
import type { AppointmentStatus } from '@/shared/domain/vocabulary.js';

/**
 * Appointment lifecycle rules.
 *
 * Pure domain logic: no database, no clock, no HTTP. The transition table is data rather than a
 * pile of if-statements so that the legal moves are readable at a glance and exhaustively
 * testable.
 */

/**
 *   SCHEDULED -> COMPLETED | NO_SHOW | CANCELLED
 *   COMPLETED, NO_SHOW, CANCELLED -> (terminal)
 *
 * Terminal states are genuinely terminal. In particular a CANCELLED appointment cannot be
 * revived: the slot became publicly bookable the moment it was cancelled, so "un-cancelling"
 * could resurrect an appointment on top of one someone else has since booked. The patient
 * books again instead.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<AppointmentStatus, readonly AppointmentStatus[]>> =
  Object.freeze({
    SCHEDULED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'],
    COMPLETED: [],
    NO_SHOW: [],
    CANCELLED: [],
  });

export const canTransition = (from: AppointmentStatus, to: AppointmentStatus): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to);

export const assertTransitionAllowed = (from: AppointmentStatus, to: AppointmentStatus): void => {
  if (!canTransition(from, to)) {
    throw invalidStatusTransition(from, to);
  }
};

/** Statuses a therapist may set to record what happened in a session. */
export const THERAPIST_OUTCOME_STATUSES: readonly AppointmentStatus[] = ['COMPLETED', 'NO_SHOW'];

/**
 * A therapist may record an outcome from the appointment's start until `graceHours` after it ends.
 *
 * Both bounds are deliberate. Blocking before the start prevents marking a session complete
 * before it has happened, which would corrupt reporting. The grace period after the end exists
 * because clinicians write up notes later, but leaving the window open forever would let history
 * be rewritten months on. 24 hours is the configured default (STATUS_UPDATE_GRACE_HOURS).
 */
export const assertWithinStatusWindow = (
  appointment: { startTime: Date; endTime: Date },
  now: Date,
  graceHours: number,
): void => {
  const windowStart = appointment.startTime;
  const windowEnd = new Date(appointment.endTime.getTime() + graceHours * 3_600_000);

  if (now.getTime() < windowStart.getTime() || now.getTime() > windowEnd.getTime()) {
    throw outsideStatusWindow(windowStart, windowEnd);
  }
};

/**
 * Cancellation is only allowed before the appointment starts.
 *
 * After the start time the session either happened or the patient did not turn up, and both of
 * those are outcomes the therapist records — not something the patient can retroactively erase.
 */
export const canCancel = (
  appointment: { startTime: Date; status: AppointmentStatus },
  now: Date,
): boolean => appointment.status === 'SCHEDULED' && appointment.startTime.getTime() > now.getTime();
