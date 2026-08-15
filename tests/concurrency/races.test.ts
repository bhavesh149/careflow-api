import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app.js';
import { errorCode, request } from '../helpers/http.js';
import { idempotencyKey, login, query, seedClinic, slotAt } from '../helpers/fixtures.js';
import type { ComposedApp } from '@/composition.js';

/**
 * These tests exist because sequential tests cannot prove the property that matters: under
 * contention, Postgres admits exactly one winner. Fastify's `inject` is concurrent here on
 * purpose — each call is an independent request sharing the same pool, the same way three ECS
 * tasks share one RDS instance.
 */

describe('concurrent holds', () => {
  let ctx: ComposedApp;

  beforeAll(async () => {
    ctx = await startTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('admits exactly one ACTIVE hold when eight patients race for the same slot', async () => {
    const clinic = await seedClinic(8);
    const start = slotAt({ hour: 9 });
    const sessions = await Promise.all(clinic.patients.map((patient) => login(ctx.app, patient.email)));

    const results = await Promise.all(
      sessions.map((session) =>
        request(ctx.app, {
          method: 'POST',
          url: '/v1/holds',
          token: session.token,
          body: { therapistId: clinic.therapist.therapistId, startTime: start },
        }),
      ),
    );

    const winners = results.filter((result) => result.status === 201);
    const losers = results.filter((result) => result.status === 409);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    expect(losers.every((result) => errorCode(result) === 'SLOT_ALREADY_HELD')).toBe(true);

    const rows = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM holds WHERE status = 'ACTIVE' AND start_time = $1::timestamptz`,
      [start],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

describe('concurrent confirmation', () => {
  let ctx: ComposedApp;

  beforeAll(async () => {
    ctx = await startTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('consumes a hold once when the owner double-submits confirm', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const start = slotAt({ hour: 10 });

    const hold = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: patient.token,
      body: { therapistId: clinic.therapist.therapistId, startTime: start },
    });

    const results = await Promise.all(
      [idempotencyKey(), idempotencyKey()].map((key) =>
        request<{ id: string }>(ctx.app, {
          method: 'POST',
          url: '/v1/appointments/confirm',
          token: patient.token,
          headers: { 'idempotency-key': key },
          body: { holdId: hold.body.id },
        }),
      ),
    );

    const created = results.filter((result) => result.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);

    const appointments = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM appointments WHERE patient_id = $1::uuid`,
      [clinic.patient.id],
    );
    expect(Number(appointments[0]!.count)).toBe(1);
  });

  it('replays rather than double-booking when the same idempotency key races', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const start = slotAt({ hour: 11 });
    const key = idempotencyKey();

    const hold = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: patient.token,
      body: { therapistId: clinic.therapist.therapistId, startTime: start },
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request<{ id: string }>(ctx.app, {
          method: 'POST',
          url: '/v1/appointments/confirm',
          token: patient.token,
          headers: { 'idempotency-key': key },
          body: { holdId: hold.body.id },
        }),
      ),
    );

    const succeeded = results.filter(
      (result) => result.status === 201 || result.status === 409,
    );
    expect(succeeded.length).toBe(6);

    const createdIds = new Set(
      results.filter((result) => result.status === 201).map((result) => result.body.id),
    );
    expect(createdIds.size).toBeLessThanOrEqual(1);

    const appointments = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM appointments`,
    );
    expect(Number(appointments[0]!.count)).toBe(1);
  });
});

describe('concurrent recurring series', () => {
  let ctx: ComposedApp;

  beforeAll(async () => {
    ctx = await startTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('lets only one of two overlapping series for the same therapist commit', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const rival = await login(ctx.app, clinic.patient2.email);
    const start = slotAt({ hour: 12, weeksAhead: 3 });

    const results = await Promise.all([
      request(ctx.app, {
        method: 'POST',
        url: '/v1/recurring-series',
        token: patient.token,
        headers: { 'idempotency-key': idempotencyKey() },
        body: {
          therapistId: clinic.therapist.therapistId,
          startTime: start,
          frequency: 'WEEKLY',
          occurrences: 4,
        },
      }),
      request(ctx.app, {
        method: 'POST',
        url: '/v1/recurring-series',
        token: rival.token,
        headers: { 'idempotency-key': idempotencyKey() },
        body: {
          therapistId: clinic.therapist.therapistId,
          startTime: start,
          frequency: 'WEEKLY',
          occurrences: 4,
        },
      }),
    ]);

    const winners = results.filter((result) => result.status === 201);
    const losers = results.filter((result) => result.status === 409);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const series = await query<{ count: string }>(`SELECT count(*)::text AS count FROM recurring_series`);
    const appointments = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM appointments WHERE status = 'SCHEDULED'`,
    );
    expect(Number(series[0]!.count)).toBe(1);
    expect(Number(appointments[0]!.count)).toBe(4);
  });
});
