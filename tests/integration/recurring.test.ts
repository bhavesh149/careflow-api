import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app.js';
import { errorCode, request } from '../helpers/http.js';
import { idempotencyKey, login, seedClinic, slotAt } from '../helpers/fixtures.js';
import type { ComposedApp } from '@/composition.js';

describe('recurring series', () => {
  let ctx: ComposedApp;

  beforeAll(async () => {
    ctx = await startTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates a weekly series all-or-nothing and lists every occurrence', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const start = slotAt({ hour: 9, weeksAhead: 3 });

    const created = await request<{
      id: string;
      status: string;
      appointments: { status: string; occurrenceIndex: number }[];
    }>(ctx.app, {
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
    });

    expect(created.status).toBe(201);
    expect(created.body.status).toBe('ACTIVE');
    expect(created.body.appointments).toHaveLength(4);
    expect(created.body.appointments.every((row) => row.status === 'SCHEDULED')).toBe(true);
  });

  it('refuses the entire series when any occurrence collides, and books nothing', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const rival = await login(ctx.app, clinic.patient2.email);
    const start = slotAt({ hour: 10, weeksAhead: 3 });

    const hold = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: rival.token,
      body: { therapistId: clinic.therapist.therapistId, startTime: start },
    });
    const booked = await request(ctx.app, {
      method: 'POST',
      url: '/v1/appointments/confirm',
      token: rival.token,
      headers: { 'idempotency-key': idempotencyKey() },
      body: { holdId: hold.body.id },
    });
    expect(booked.status).toBe(201);

    const series = await request<{ error?: { details?: { conflicts?: unknown[] } } }>(ctx.app, {
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
    });

    expect(series.status).toBe(409);
    expect(errorCode(series)).toBe('RECURRING_CONFLICT');

    const listed = await request<{ appointments: unknown[] }>(ctx.app, {
      method: 'GET',
      url: '/v1/patients/me/appointments',
      token: patient.token,
    });
    expect(listed.body.appointments).toHaveLength(0);
  });

  it('cancels one occurrence without touching the series or its siblings', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const start = slotAt({ hour: 11, weeksAhead: 3 });

    const created = await request<{
      id: string;
      appointments: { id: string; occurrenceIndex: number }[];
    }>(ctx.app, {
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
    });

    const instance = created.body.appointments.find((row) => row.occurrenceIndex === 1);
    expect(instance).toBeDefined();

    const cancelled = await request<{ status: string }>(ctx.app, {
      method: 'POST',
      url: `/v1/recurring-series/${created.body.id}/instances/${instance!.id}/cancel`,
      token: patient.token,
      headers: { 'idempotency-key': idempotencyKey() },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    const remaining = await request<{
      status: string;
      appointments: { status: string }[];
    }>(ctx.app, {
      method: 'GET',
      url: `/v1/recurring-series/${created.body.id}`,
      token: patient.token,
    });
    expect(remaining.body.status).toBe('ACTIVE');
    expect(remaining.body.appointments.filter((row) => row.status === 'SCHEDULED')).toHaveLength(3);
  });

  it('cancels the series and only future SCHEDULED instances', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const start = slotAt({ hour: 12, weeksAhead: 3 });

    const created = await request<{ id: string; appointments: { id: string }[] }>(ctx.app, {
      method: 'POST',
      url: '/v1/recurring-series',
      token: patient.token,
      headers: { 'idempotency-key': idempotencyKey() },
      body: {
        therapistId: clinic.therapist.therapistId,
        startTime: start,
        frequency: 'WEEKLY',
        occurrences: 3,
      },
    });

    const cancelled = await request<{ series: { status: string }; cancelledCount: number }>(
      ctx.app,
      {
        method: 'POST',
        url: `/v1/recurring-series/${created.body.id}/cancel`,
        token: patient.token,
        headers: { 'idempotency-key': idempotencyKey() },
      },
    );

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.series.status).toBe('CANCELLED');
    expect(cancelled.body.cancelledCount).toBe(3);
  });
});
