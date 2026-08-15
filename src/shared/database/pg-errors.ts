import { AppError, internalError } from '@/shared/errors/app-error.js';
import { appointmentConflict, slotAlreadyHeld } from '@/shared/errors/domain-errors.js';
import type { TimeInterval } from '@/shared/time/interval.js';

/**
 * Translation layer between Postgres error codes and domain errors.
 *
 * This exists because the database is the *final* arbiter of the booking invariants, not
 * just a backstop. Under contention the application-level conflict check can pass and the
 * INSERT still lose the race; when that happens Postgres raises `23P01` and the caller must
 * receive the same deterministic 409 it would have received from the pre-check.
 *
 * Reference: https://www.postgresql.org/docs/17/errcodes-appendix.html
 */
export const PgErrorCode = {
  UNIQUE_VIOLATION: '23505',
  EXCLUSION_VIOLATION: '23P01',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014',
  TOO_MANY_CONNECTIONS: '53300',
  READ_ONLY_SQL_TRANSACTION: '25006',
  INSUFFICIENT_PRIVILEGE: '42501',
} as const;

/** Constraint names referenced by the error mapper. Must match the migration SQL. */
export const ConstraintName = {
  APPOINTMENTS_NO_OVERLAP: 'appointments_no_overlap',
  APPOINTMENTS_PATIENT_NO_OVERLAP: 'appointments_patient_no_overlap',
  HOLDS_NO_OVERLAP: 'holds_no_overlap',
  THERAPIST_SCHEDULES_NO_OVERLAP: 'therapist_schedules_no_overlap',
  IDEMPOTENCY_UNIQUE: 'idempotency_records_actor_operation_key_key',
  USERS_EMAIL_UNIQUE: 'users_email_key',
} as const;

export interface PostgresErrorShape {
  readonly code?: string;
  readonly constraint?: string;
  readonly detail?: string;
  readonly table?: string;
  readonly message?: string;
}

/**
 * Finds the driver error inside whatever wrapper it arrives in.
 *
 * Drizzle re-throws query failures as its own error with the message "Failed query: ..." and
 * the `pg` error attached as `cause`. Inspecting only the outermost error therefore finds no
 * SQLSTATE, and every exclusion-constraint violation would degrade into an opaque 500 instead
 * of the deterministic 409 the whole concurrency design depends on. The chain is walked with a
 * depth bound so a self-referential `cause` cannot spin here.
 */
export const asPostgresError = (error: unknown): PostgresErrorShape | undefined => {
  let current: unknown = error;

  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }

    const candidate = current as PostgresErrorShape & { cause?: unknown };
    if (typeof candidate.code === 'string') {
      return candidate;
    }

    current = candidate.cause;
  }

  return undefined;
};

export const isPgError = (error: unknown, code: string): boolean =>
  asPostgresError(error)?.code === code;

export const isConstraintViolation = (error: unknown, constraint: string): boolean => {
  const pgError = asPostgresError(error);
  return pgError?.constraint === constraint;
};

/** True for errors that are safe to retry verbatim, because the transaction left no trace. */
export const isRetryableTransactionError = (error: unknown): boolean => {
  const code = asPostgresError(error)?.code;
  return code === PgErrorCode.SERIALIZATION_FAILURE || code === PgErrorCode.DEADLOCK_DETECTED;
};

/**
 * Maps a database write failure onto the domain error a client should see.
 * Anything unrecognised becomes an opaque INTERNAL_ERROR: leaking `detail` would expose
 * table names, column names and other patients' appointment times.
 */
export const translateWriteError = (
  error: unknown,
  context: { interval?: TimeInterval } = {},
): AppError => {
  if (AppError.isAppError(error)) {
    return error;
  }

  const pgError = asPostgresError(error);

  if (pgError?.code === PgErrorCode.EXCLUSION_VIOLATION) {
    const interval = context.interval;

    if (pgError.constraint === ConstraintName.HOLDS_NO_OVERLAP) {
      return interval
        ? slotAlreadyHeld(interval.start, interval.end)
        : new AppError('SLOT_ALREADY_HELD', 'The selected slot is currently held.');
    }

    // Distinguished from the therapist conflict because the remedy is different: the patient
    // must cancel their own other appointment, not pick a different therapist.
    if (pgError.constraint === ConstraintName.APPOINTMENTS_PATIENT_NO_OVERLAP) {
      return new AppError(
        'APPOINTMENT_CONFLICT',
        'You already have another appointment during this time.',
        {
          details: interval
            ? { startTime: interval.start.toISOString(), endTime: interval.end.toISOString() }
            : undefined,
        },
      );
    }

    return interval
      ? appointmentConflict(interval.start, interval.end)
      : new AppError('APPOINTMENT_CONFLICT', 'That time is already booked for this therapist.');
  }

  return internalError('A database error occurred.', error);
};
