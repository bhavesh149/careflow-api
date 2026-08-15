import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { startTestApp } from '../helpers/app.js';
import { errorCode, request } from '../helpers/http.js';
import { APP_TIMEZONE, idempotencyKey, login, query, seedClinic, slotAt } from '../helpers/fixtures.js';
import type { ComposedApp } from '@/composition.js';

describe('holds, availability and one-time booking', () => {
  let ctx: ComposedApp;

  beforeAll(async () => {
    ctx = await startTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('holds a slot, confirms it, and removes it from availability', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const start = slotAt({ hour: 9 });
    const from = DateTime.fromISO(start).setZone(APP_TIMEZONE).toISODate()!;
    const to = DateTime.fromISO(start).setZone(APP_TIMEZONE).plus({ days: 1 }).toISODate()!;

    const before = await request<{ slots: { startTime: string }[] }>(ctx.app, {
      method: 'GET',
      url: `/v1/therapists/${clinic.therapist.therapistId}/availability?from=${from}&to=${to}`,
      token: patient.token,
    });
    expect(before.status).toBe(200);
    expect(before.body.slots.some((slot) => slot.startTime === start)).toBe(true);

    const hold = await request<{ id: string; expiresInSeconds: number }>(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: patient.token,
      body: { therapistId: clinic.therapist.therapistId, startTime: start },
    });
    expect(hold.status).toBe(201);
    expect(hold.body.expiresInSeconds).toBeGreaterThan(0);

    const active = await request<{ holds: { id: string }[] }>(ctx.app, {
      method: 'GET',
      url: '/v1/holds/active',
      token: patient.token,
    });
    expect(active.body.holds.map((row) => row.id)).toContain(hold.body.id);

    const confirm = await request<{ id: string; status: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/appointments/confirm',
      token: patient.token,
      headers: { 'idempotency-key': idempotencyKey() },
      body: { holdId: hold.body.id },
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.status).toBe('SCHEDULED');

    const after = await request<{ slots: { startTime: string }[] }>(ctx.app, {
      method: 'GET',
      url: `/v1/therapists/${clinic.therapist.therapistId}/availability?from=${from}&to=${to}`,
      token: patient.token,
    });
    expect(after.body.slots.some((slot) => slot.startTime === start)).toBe(false);

    const events = await query<{ eventType: string }>(
      `SELECT event_type AS "eventType" FROM outbox_events WHERE aggregate_id = $1::uuid`,
      [confirm.body.id],
    );
    expect(events.map((row) => row.eventType)).toContain('AppointmentConfirmed');
  });

  it('replays a confirm with the same key and rejects a different body on that key', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const start = slotAt({ hour: 10 });
    const key = idempotencyKey();

    const hold = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: patient.token,
      body: { therapistId: clinic.therapist.therapistId, startTime: start },
    });

    const first = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/appointments/confirm',
      token: patient.token,
      headers: { 'idempotency-key': key },
      body: { holdId: hold.body.id },
    });
    expect(first.status).toBe(201);

    const replay = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/appointments/confirm',
      token: patient.token,
      headers: { 'idempotency-key': key },
      body: { holdId: hold.body.id },
    });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.headers['idempotent-replay']).toBe('true');

    const mismatch = await request(ctx.app, {
      method: 'POST',
      url: '/v1/appointments/confirm',
      token: patient.token,
      headers: { 'idempotency-key': key },
      body: { holdId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(mismatch.status).toBe(422);
    expect(errorCode(mismatch)).toBe('IDEMPOTENCY_KEY_REUSED');

    const rows = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM appointments WHERE patient_id = $1::uuid`,
      [clinic.patient.id],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('refuses a competing hold on an already-held slot', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const rival = await login(ctx.app, clinic.patient2.email);
    const start = slotAt({ hour: 11 });

    const first = await request(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: patient.token,
      body: { therapistId: clinic.therapist.therapistId, startTime: start },
    });
    expect(first.status).toBe(201);

    const second = await request(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: rival.token,
      body: { therapistId: clinic.therapist.therapistId, startTime: start },
    });
    expect(second.status).toBe(409);
    expect(errorCode(second)).toBe('SLOT_ALREADY_HELD');
  });

  it('enforces the per-patient active-hold cap', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);

    for (const hour of [8, 9, 10]) {
      const created = await request(ctx.app, {
        method: 'POST',
        url: '/v1/holds',
        token: patient.token,
        body: {
          therapistId: clinic.therapist.therapistId,
          startTime: slotAt({ hour }),
        },
      });
      expect(created.status).toBe(201);
    }

    const fourth = await request(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: patient.token,
      body: {
        therapistId: clinic.therapist.therapistId,
        startTime: slotAt({ hour: 11 }),
      },
    });
    expect(fourth.status).toBe(429);
    expect(errorCode(fourth)).toBe('MAX_ACTIVE_HOLDS_EXCEEDED');
  });

  it('cancels an appointment and returns the slot to availability', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const start = slotAt({ hour: 14 });
    const from = DateTime.fromISO(start).setZone(APP_TIMEZONE).toISODate()!;
    const to = from;

    const hold = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: patient.token,
      body: { therapistId: clinic.therapist.therapistId, startTime: start },
    });
    const confirm = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/appointments/confirm',
      token: patient.token,
      headers: { 'idempotency-key': idempotencyKey() },
      body: { holdId: hold.body.id },
    });

    const cancelled = await request<{ status: string }>(ctx.app, {
      method: 'POST',
      url: `/v1/appointments/${confirm.body.id}/cancel`,
      token: patient.token,
      headers: { 'idempotency-key': idempotencyKey() },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    const availability = await request<{ slots: { startTime: string }[] }>(ctx.app, {
      method: 'GET',
      url: `/v1/therapists/${clinic.therapist.therapistId}/availability?from=${from}&to=${to}`,
      token: patient.token,
    });
    expect(availability.body.slots.some((slot) => slot.startTime === start)).toBe(true);
  });

  it('forbids an unrelated patient from reading someone else\'s appointment', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const stranger = await login(ctx.app, clinic.patient2.email);

    const hold = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: patient.token,
      body: { therapistId: clinic.therapist.therapistId, startTime: slotAt({ hour: 16 }) },
    });
    const confirm = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/appointments/confirm',
      token: patient.token,
      headers: { 'idempotency-key': idempotencyKey() },
      body: { holdId: hold.body.id },
    });

    const peek = await request(ctx.app, {
      method: 'GET',
      url: `/v1/appointments/${confirm.body.id}`,
      token: stranger.token,
    });
    expect(peek.status).toBe(403);
    expect(errorCode(peek)).toBe('FORBIDDEN');
  });
});
