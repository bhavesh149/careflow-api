import { AppError } from '@/shared/errors/app-error.js';
import { ErrorCode } from '@/shared/errors/error-codes.js';

/** Booking-domain errors. Thrown by domain/application code, translated to HTTP at the edge. */

export const slotNotAvailable = (startTime: Date, endTime: Date): AppError =>
  new AppError(ErrorCode.SLOT_NOT_AVAILABLE, 'The selected slot is not available.', {
    details: { startTime: startTime.toISOString(), endTime: endTime.toISOString() },
  });

export const slotAlreadyHeld = (startTime: Date, endTime: Date): AppError =>
  new AppError(
    ErrorCode.SLOT_ALREADY_HELD,
    'The selected slot is currently held by another patient.',
    {
      details: { startTime: startTime.toISOString(), endTime: endTime.toISOString() },
    },
  );

export const holdNotFound = (holdId?: string): AppError =>
  new AppError(ErrorCode.HOLD_NOT_FOUND, 'The hold no longer exists.', {
    details: holdId === undefined ? undefined : { holdId },
  });

export const holdExpired = (holdId: string, expiredAt: Date): AppError =>
  new AppError(ErrorCode.HOLD_EXPIRED, 'The hold has expired. Please select the slot again.', {
    details: { holdId, expiresAt: expiredAt.toISOString() },
  });

export const holdNotOwned = (): AppError =>
  new AppError(ErrorCode.HOLD_NOT_OWNED, 'This hold belongs to another patient.');

export const maxActiveHoldsExceeded = (limit: number): AppError =>
  new AppError(
    ErrorCode.MAX_ACTIVE_HOLDS_EXCEEDED,
    `You already have the maximum of ${limit} slots on hold. Confirm or release one first.`,
    { details: { limit } },
  );

export const appointmentConflict = (startTime: Date, endTime: Date): AppError =>
  new AppError(ErrorCode.APPOINTMENT_CONFLICT, 'That time is already booked for this therapist.', {
    details: { startTime: startTime.toISOString(), endTime: endTime.toISOString() },
  });

export interface ConflictingOccurrence {
  readonly startTime: string;
  readonly endTime: string;
  readonly reason: 'ALREADY_BOOKED' | 'OUTSIDE_SCHEDULE' | 'HELD_BY_OTHER';
}

export const recurringConflict = (conflicts: readonly ConflictingOccurrence[]): AppError =>
  new AppError(
    ErrorCode.RECURRING_CONFLICT,
    'The recurring series cannot be booked because some occurrences are unavailable.',
    { details: { conflicts } },
  );

export const invalidStatusTransition = (from: string, to: string): AppError =>
  new AppError(ErrorCode.INVALID_STATUS_TRANSITION, `Cannot change status from ${from} to ${to}.`, {
    details: { from, to },
  });

export const outsideStatusWindow = (windowStart: Date, windowEnd: Date): AppError =>
  new AppError(
    ErrorCode.OUTSIDE_STATUS_WINDOW,
    'Appointment status can only be changed during the appointment window.',
    { details: { windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() } },
  );

export const appointmentAlreadyCancelled = (appointmentId: string): AppError =>
  new AppError(ErrorCode.APPOINTMENT_ALREADY_CANCELLED, 'This appointment is already cancelled.', {
    details: { appointmentId },
  });

export const seriesAlreadyCancelled = (seriesId: string): AppError =>
  new AppError(ErrorCode.SERIES_ALREADY_CANCELLED, 'This series is already cancelled.', {
    details: { seriesId },
  });

export const scheduleConflict = (message: string): AppError =>
  new AppError(ErrorCode.SCHEDULE_CONFLICT, message);

export const idempotencyKeyRequired = (): AppError =>
  new AppError(
    ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
    'This operation requires an Idempotency-Key header.',
  );

export const idempotencyKeyReused = (): AppError =>
  new AppError(
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
    'This Idempotency-Key was already used with a different request body.',
  );

export const idempotencyInProgress = (retryAfterSeconds = 1): AppError =>
  new AppError(
    ErrorCode.IDEMPOTENCY_IN_PROGRESS,
    'An identical request is currently being processed. Retry shortly.',
    { retryAfterSeconds },
  );

export const rateLimited = (retryAfterSeconds: number): AppError =>
  new AppError(ErrorCode.RATE_LIMITED, 'Too many requests. Please slow down.', {
    retryAfterSeconds,
  });
