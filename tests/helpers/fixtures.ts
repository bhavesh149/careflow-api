import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { DateTime } from 'luxon';
import { Pool } from 'pg';
import { hashPassword } from '@/shared/security/password.js';
import type { CareflowApp } from '@/shared/http/types.js';
import { request } from './http.js';

/**
 * Shared clinic data for every suite above `unit`.
 *
 * A therapist with a weekday 08:00–18:00 pattern, plus patients that share one password hash.
 * Argon2id is intentionally expensive; hashing once per worker is what keeps the suite from
 * spending most of its time stretching passwords.
 */

export const TEST_PASSWORD = 'Careflow!2026';
export const APP_TIMEZONE = 'Asia/Kolkata';

const pool = new Pool({ connectionString: inject('databaseUrl'), max: 4 });

let cachedHash: string | undefined;

const passwordHash = async (): Promise<string> => {
  cachedHash ??= await hashPassword(TEST_PASSWORD);
  return cachedHash;
};

export interface SeededUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: 'PATIENT' | 'THERAPIST';
  readonly therapistId?: string;
}

export interface Clinic {
  readonly therapist: SeededUser;
  readonly patient: SeededUser;
  readonly patient2: SeededUser;
}

export const seedClinic = async (patientCount = 2): Promise<Clinic & { patients: SeededUser[] }> => {
  const hash = await passwordHash();
  const suffix = randomUUID().slice(0, 8);

  const therapistUser = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, full_name)
     VALUES ($1, $2, 'THERAPIST', $3)
     RETURNING id`,
    [`therapist.${suffix}@careflow.test`, hash, 'Dr. Test Therapist'],
  );
  const therapistUserId = therapistUser.rows[0]!.id;

  const therapist = await pool.query<{ id: string }>(
    `INSERT INTO therapists (user_id, display_name, specialization)
     VALUES ($1::uuid, $2, $3)
     RETURNING id`,
    [therapistUserId, 'Dr. Test Therapist', 'Integration Testing'],
  );
  const therapistId = therapist.rows[0]!.id;

  // Every weekday, 08:00–18:00, effective from well before any test slot. Tests pick concrete
  // future Mondays; they should not have to know which day the suite happened to run.
  for (const day of [1, 2, 3, 4, 5]) {
    await pool.query(
      `INSERT INTO therapist_schedules
         (therapist_id, day_of_week, start_time, end_time, effective_from)
       VALUES ($1::uuid, $2, '08:00', '18:00', '2026-01-01')`,
      [therapistId, day],
    );
  }

  const patients: SeededUser[] = [];
  for (let index = 0; index < Math.max(2, patientCount); index += 1) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, full_name)
       VALUES ($1, $2, 'PATIENT', $3)
       RETURNING id`,
      [`patient.${suffix}.${index}@careflow.test`, hash, `Patient ${index + 1}`],
    );
    patients.push({
      id: inserted.rows[0]!.id,
      email: `patient.${suffix}.${index}@careflow.test`,
      fullName: `Patient ${index + 1}`,
      role: 'PATIENT',
    });
  }

  return {
    therapist: {
      id: therapistUserId,
      email: `therapist.${suffix}@careflow.test`,
      fullName: 'Dr. Test Therapist',
      role: 'THERAPIST',
      therapistId,
    },
    patient: patients[0]!,
    patient2: patients[1]!,
    patients,
  };
};

/**
 * A bookable instant: `weekday` is ISO (1 = Monday), `hour` is wall-clock in APP_TIMEZONE,
 * `weeksAhead` keeps it in the future so "already started" never fires on a slow suite.
 */
export const slotAt = ({
  weekday = 1,
  hour = 9,
  weeksAhead = 3,
}: {
  weekday?: number;
  hour?: number;
  weeksAhead?: number;
} = {}): string => {
  let cursor = DateTime.now().setZone(APP_TIMEZONE).plus({ weeks: weeksAhead }).startOf('day');
  const daysToAdd = (weekday - cursor.weekday + 7) % 7;
  cursor = cursor.plus({ days: daysToAdd }).set({
    hour,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  const iso = cursor.toUTC().toISO();
  if (iso === null) {
    throw new Error('Failed to construct a slot timestamp.');
  }
  return iso;
};

export const login = async (
  app: CareflowApp,
  email: string,
): Promise<{ token: string; cookies: string; userId: string; therapistId?: string }> => {
  const response = await request<{
    accessToken: string;
    user: { id: string; therapistId?: string };
  }>(app, {
    method: 'POST',
    url: '/v1/auth/login',
    body: { email, password: TEST_PASSWORD },
  });

  if (response.status !== 200) {
    throw new Error(`login failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return {
    token: response.body.accessToken,
    cookies: response.cookies,
    userId: response.body.user.id,
    ...(response.body.user.therapistId === undefined
      ? {}
      : { therapistId: response.body.user.therapistId }),
  };
};

export const idempotencyKey = (): string => randomUUID();

export const query = async <T extends Record<string, unknown>>(
  sqlText: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const result = await pool.query<T>(sqlText, params);
  return result.rows;
};
