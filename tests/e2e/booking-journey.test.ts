import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { startTestApp } from '../helpers/app.js';
import { errorCode, request } from '../helpers/http.js';
import {
  APP_TIMEZONE,
  idempotencyKey,
  login,
  seedClinic,
  slotAt,
} from '../helpers/fixtures.js';
import type { ComposedApp } from '@/composition.js';

/**
 * Full HTTP journeys through the same `buildApp` the process serves in production.
 *
 * These are not a substitute for the Compose smoke script (which hits nginx in front of three
 * replicas). They are the suite CI can run against a throwaway Postgres without Docker Compose,
 * covering the same user-visible path: login, availability, hold, confirm, series, cancel.
 */

describe('booking journey', () => {
  let ctx: ComposedApp;

  beforeAll(async () => {
    ctx = await startTestApp({ SWAGGER_ENABLED: true });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('walks a patient from login through cancel and back to a free slot', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const therapist = await login(ctx.app, clinic.therapist.email);
    const start = slotAt({ hour: 9 });
    const from = DateTime.fromISO(start).setZone(APP_TIMEZONE).toISODate()!;
    const to = DateTime.fromISO(start).setZone(APP_TIMEZONE).plus({ days: 13 }).toISODate()!;

    const health = await request<{ status: string }>(ctx.app, { method: 'GET', url: '/health' });
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');

    const ready = await request<{ status: string }>(ctx.app, { method: 'GET', url: '/ready' });
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');

    const therapists = await request<{ therapists: { id: string }[] }>(ctx.app, {
      method: 'GET',
      url: '/v1/therapists',
      token: patient.token,
    });
    expect(therapists.body.therapists.map((row) => row.id)).toContain(clinic.therapist.therapistId);

    const availability = await request<{ slots: { startTime: string }[] }>(ctx.app, {
      method: 'GET',
      url: `/v1/therapists/${clinic.therapist.therapistId}/availability?from=${from}&to=${to}`,
      token: patient.token,
    });
    expect(availability.body.slots.some((slot) => slot.startTime === start)).toBe(true);

    const forbiddenSchedule = await request(ctx.app, {
      method: 'GET',
      url: '/v1/therapists/me/schedule',
      token: patient.token,
    });
    expect(forbiddenSchedule.status).toBe(403);

    const schedule = await request<{ rules: unknown[] }>(ctx.app, {
      method: 'GET',
      url: '/v1/therapists/me/schedule',
      token: therapist.token,
    });
    expect(schedule.status).toBe(200);
    expect(schedule.body.rules.length).toBeGreaterThan(0);

    const hold = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: patient.token,
      body: { therapistId: clinic.therapist.therapistId, startTime: start },
    });
    expect(hold.status).toBe(201);

    const confirmKey = idempotencyKey();
    const confirm = await request<{ id: string; status: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/appointments/confirm',
      token: patient.token,
      headers: { 'idempotency-key': confirmKey },
      body: { holdId: hold.body.id },
    });
    expect(confirm.status).toBe(201);

    const replay = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/appointments/confirm',
      token: patient.token,
      headers: { 'idempotency-key': confirmKey },
      body: { holdId: hold.body.id },
    });
    expect(replay.body.id).toBe(confirm.body.id);

    const mine = await request<{ appointments: { id: string }[] }>(ctx.app, {
      method: 'GET',
      url: '/v1/patients/me/appointments?status=UPCOMING',
      token: patient.token,
    });
    expect(mine.body.appointments.map((row) => row.id)).toContain(confirm.body.id);

    const theirs = await request<{ appointments: { id: string }[] }>(ctx.app, {
      method: 'GET',
      url: '/v1/therapists/me/appointments',
      token: therapist.token,
    });
    expect(theirs.body.appointments.map((row) => row.id)).toContain(confirm.body.id);

    const seriesStart = slotAt({ hour: 11, weeksAhead: 3 });
    const series = await request<{ id: string; appointments: { id: string }[] }>(ctx.app, {
      method: 'POST',
      url: '/v1/recurring-series',
      token: patient.token,
      headers: { 'idempotency-key': idempotencyKey() },
      body: {
        therapistId: clinic.therapist.therapistId,
        startTime: seriesStart,
        frequency: 'WEEKLY',
        occurrences: 4,
      },
    });
    expect(series.status).toBe(201);
    expect(series.body.appointments).toHaveLength(4);

    const instance = series.body.appointments[1]!;
    const instanceCancel = await request<{ status: string }>(ctx.app, {
      method: 'POST',
      url: `/v1/recurring-series/${series.body.id}/instances/${instance.id}/cancel`,
      token: patient.token,
      headers: { 'idempotency-key': idempotencyKey() },
    });
    expect(instanceCancel.body.status).toBe('CANCELLED');

    const seriesCancel = await request<{ series: { status: string } }>(ctx.app, {
      method: 'POST',
      url: `/v1/recurring-series/${series.body.id}/cancel`,
      token: patient.token,
      headers: { 'idempotency-key': idempotencyKey() },
    });
    expect(seriesCancel.body.series.status).toBe('CANCELLED');

    const cancel = await request<{ status: string }>(ctx.app, {
      method: 'POST',
      url: `/v1/appointments/${confirm.body.id}/cancel`,
      token: patient.token,
      headers: { 'idempotency-key': idempotencyKey() },
    });
    expect(cancel.body.status).toBe('CANCELLED');

    const reopened = await request<{ slots: { startTime: string }[] }>(ctx.app, {
      method: 'GET',
      url: `/v1/therapists/${clinic.therapist.therapistId}/availability?from=${from}&to=${to}`,
      token: patient.token,
    });
    expect(reopened.body.slots.some((slot) => slot.startTime === start)).toBe(true);

    const docs = await request<{ paths?: Record<string, unknown> }>(ctx.app, {
      method: 'GET',
      url: '/docs/json',
    });
    expect(docs.status).toBe(200);
    expect(Object.keys(docs.body.paths ?? {}).length).toBeGreaterThan(10);
  });

  it('rejects an unauthenticated booking attempt', async () => {
    const clinic = await seedClinic();
    const hold = await request(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      body: { therapistId: clinic.therapist.therapistId, startTime: slotAt({ hour: 9 }) },
    });
    expect(hold.status).toBe(401);
    expect(errorCode(hold)).toBe('AUTHENTICATION_REQUIRED');
  });
});
