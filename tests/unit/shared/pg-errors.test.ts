import { describe, expect, it } from 'vitest';
import {
  ConstraintName,
  PgErrorCode,
  asPostgresError,
  isRetryableTransactionError,
  translateWriteError,
} from '@/shared/database/pg-errors.js';
import { TimeInterval } from '@/shared/time/interval.js';

/**
 * These assertions guard the seam where Postgres' verdict becomes the API's answer.
 *
 * The regression that motivated the wrapped-error case is worth spelling out: Drizzle does not
 * re-throw the driver error, it throws its own error with the `pg` error as `cause`. Reading
 * only the outer error finds no SQLSTATE, so a lost race for a slot — the single most important
 * conflict in this system — came back as an opaque 500 instead of a 409 the client can act on.
 */

const pgError = (code: string, constraint?: string): Error =>
  Object.assign(new Error('boom'), { code, constraint });

/** How Drizzle surfaces a failed query. */
const wrapped = (inner: Error): Error =>
  new Error('Failed query: INSERT INTO holds ...', { cause: inner });

const interval = TimeInterval.of(
  new Date('2026-03-02T09:00:00.000Z'),
  new Date('2026-03-02T10:00:00.000Z'),
);

describe('asPostgresError', () => {
  it('finds the driver error through a wrapper', () => {
    const inner = pgError(PgErrorCode.EXCLUSION_VIOLATION, ConstraintName.HOLDS_NO_OVERLAP);

    expect(asPostgresError(wrapped(inner))?.code).toBe(PgErrorCode.EXCLUSION_VIOLATION);
  });

  it('stops rather than looping on a self-referential cause', () => {
    const looping: { code?: string; cause?: unknown } = {};
    looping.cause = looping;

    expect(asPostgresError(looping)).toBeUndefined();
  });

  it('ignores values that are not errors', () => {
    expect(asPostgresError('nope')).toBeUndefined();
    expect(asPostgresError(null)).toBeUndefined();
  });
});

describe('translateWriteError', () => {
  it('maps a hold overlap to SLOT_ALREADY_HELD, wrapped or not', () => {
    const inner = pgError(PgErrorCode.EXCLUSION_VIOLATION, ConstraintName.HOLDS_NO_OVERLAP);

    for (const error of [inner, wrapped(inner)]) {
      const translated = translateWriteError(error, { interval });
      expect(translated.code).toBe('SLOT_ALREADY_HELD');
      expect(translated.httpStatus).toBe(409);
    }
  });

  it('distinguishes the patient double-booking from the therapist conflict', () => {
    const patientClash = translateWriteError(
      wrapped(
        pgError(PgErrorCode.EXCLUSION_VIOLATION, ConstraintName.APPOINTMENTS_PATIENT_NO_OVERLAP),
      ),
      { interval },
    );
    const therapistClash = translateWriteError(
      wrapped(pgError(PgErrorCode.EXCLUSION_VIOLATION, ConstraintName.APPOINTMENTS_NO_OVERLAP)),
      { interval },
    );

    expect(patientClash.code).toBe('APPOINTMENT_CONFLICT');
    expect(patientClash.message).toContain('another appointment');
    expect(therapistClash.code).toBe('APPOINTMENT_CONFLICT');
    expect(therapistClash.message).not.toContain('another appointment');
  });

  it('keeps an unrecognised database failure opaque', () => {
    const translated = translateWriteError(wrapped(pgError('42P01')));

    expect(translated.code).toBe('INTERNAL_ERROR');
    // The client must never see table names or SQL text.
    expect(translated.expose).toBe(false);
  });

  it('passes a deliberate domain error straight through', () => {
    const domain = translateWriteError(
      translateWriteError(
        pgError(PgErrorCode.EXCLUSION_VIOLATION, ConstraintName.HOLDS_NO_OVERLAP),
        {
          interval,
        },
      ),
    );

    expect(domain.code).toBe('SLOT_ALREADY_HELD');
  });

  it('recognises retryable transaction failures through a wrapper', () => {
    expect(isRetryableTransactionError(wrapped(pgError(PgErrorCode.DEADLOCK_DETECTED)))).toBe(true);
    expect(isRetryableTransactionError(wrapped(pgError(PgErrorCode.CHECK_VIOLATION)))).toBe(false);
  });
});
