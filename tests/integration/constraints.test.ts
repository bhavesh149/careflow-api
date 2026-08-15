import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app.js';
import { errorCode, request } from '../helpers/http.js';
import { login, query, seedClinic, slotAt } from '../helpers/fixtures.js';
import type { ComposedApp } from '@/composition.js';

/**
 * These tests talk to Postgres as the application does, and they are the reason the exclusion
 * constraints exist. If they fail, two patients can occupy the same chair; if they pass, the
 * database — not the application — is the final arbiter.
 */

describe('exclusion constraints', () => {
  let ctx: ComposedApp;

  beforeAll(async () => {
    ctx = await startTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('rejects two overlapping SCHEDULED appointments for the same therapist', async () => {
    const clinic = await seedClinic();
    const start = slotAt({ hour: 9 });
    const end = slotAt({ hour: 10 });
    const overlapStart = slotAt({ hour: 9, weeksAhead: 3 });
    const overlapEnd = slotAt({ hour: 11 });

    await query(
      `INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
       VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)`,
      [clinic.therapist.therapistId, clinic.patient.id, start, end],
    );

    await expect(
      query(
        `INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
         VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)`,
        [clinic.therapist.therapistId, clinic.patient2.id, overlapStart, overlapEnd],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('allows back-to-back appointments that share only the boundary instant', async () => {
    const clinic = await seedClinic();
    const firstStart = slotAt({ hour: 9 });
    const firstEnd = slotAt({ hour: 10 });
    const secondStart = slotAt({ hour: 10 });
    const secondEnd = slotAt({ hour: 11 });

    await query(
      `INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
       VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)`,
      [clinic.therapist.therapistId, clinic.patient.id, firstStart, firstEnd],
    );

    await expect(
      query(
        `INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
         VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)`,
        [clinic.therapist.therapistId, clinic.patient2.id, secondStart, secondEnd],
      ),
    ).resolves.toBeTruthy();
  });

  it('frees a slot for rebooking the moment the original appointment is CANCELLED', async () => {
    const clinic = await seedClinic();
    const start = slotAt({ hour: 11 });
    const end = slotAt({ hour: 12 });

    const inserted = await query<{ id: string }>(
      `INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
       VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)
       RETURNING id`,
      [clinic.therapist.therapistId, clinic.patient.id, start, end],
    );

    await query(
      `UPDATE appointments
          SET status = 'CANCELLED', cancelled_at = now(), cancellation_scope = 'INSTANCE'
        WHERE id = $1::uuid`,
      [inserted[0]!.id],
    );

    await expect(
      query(
        `INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
         VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)`,
        [clinic.therapist.therapistId, clinic.patient2.id, start, end],
      ),
    ).resolves.toBeTruthy();
  });

  it('rejects two ACTIVE holds on the same therapist slot', async () => {
    const clinic = await seedClinic();
    const start = slotAt({ hour: 13 });
    const end = slotAt({ hour: 14 });

    await query(
      `INSERT INTO holds (therapist_id, patient_id, start_time, end_time, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, now() + interval '60 seconds')`,
      [clinic.therapist.therapistId, clinic.patient.id, start, end],
    );

    await expect(
      query(
        `INSERT INTO holds (therapist_id, patient_id, start_time, end_time, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, now() + interval '60 seconds')`,
        [clinic.therapist.therapistId, clinic.patient2.id, start, end],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('reclaims an expired-but-still-ACTIVE hold so the next patient can take the slot', async () => {
    const clinic = await seedClinic();
    const session = await login(ctx.app, clinic.patient2.email);
    const start = slotAt({ hour: 15 });

    // The constraint cannot test expires_at (now() is not IMMUTABLE), so a lapsed row still
    // occupies it until something flips the status. Hold-create does that in the same
    // transaction as the insert, which is the property under test.
    await query(
      `INSERT INTO holds (therapist_id, patient_id, start_time, end_time, expires_at, created_at, status)
       VALUES ($1::uuid, $2::uuid, $3::timestamptz, $3::timestamptz + interval '1 hour',
               now() - interval '5 seconds', now() - interval '70 seconds', 'ACTIVE')`,
      [clinic.therapist.therapistId, clinic.patient.id, start],
    );

    const hold = await request(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: session.token,
      body: { therapistId: clinic.therapist.therapistId, startTime: start },
    });

    expect(hold.status).toBe(201);
    expect(errorCode(hold)).toBeUndefined();
  });
});
