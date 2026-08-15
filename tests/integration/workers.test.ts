import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app.js';
import { request } from '../helpers/http.js';
import { idempotencyKey, login, query, seedClinic, slotAt } from '../helpers/fixtures.js';
import { createHoldSweeper } from '@/workers/hold-sweeper/sweeper.js';
import { createOutboxPublisher } from '@/workers/outbox-publisher/publisher.js';
import { createNotificationConsumer } from '@/workers/notification-consumer/consumer.js';
import { createNoopPublisher } from '@/shared/events/queue-publisher.js';
import {
  AggregateType,
  EventType,
  type EventEnvelope,
  type QueuePublisher,
  type ReceivedMessage,
} from '@/shared/events/index.js';
import type { NotificationSender } from '@/workers/notification-consumer/notification-sender.js';
import type { ComposedApp } from '@/composition.js';

const createMemoryQueue = (): QueuePublisher & { inbox: ReceivedMessage[] } => {
  const inbox: ReceivedMessage[] = [];

  return {
    inbox,
    publish: async (events) => {
      for (const envelope of events) {
        inbox.push({ receiptHandle: envelope.eventId, envelope });
      }
      return { successfulIds: events.map((event) => event.eventId), failures: [] };
    },
    receive: async (maxMessages) => inbox.splice(0, maxMessages),
    acknowledge: async () => undefined,
    close: async () => undefined,
  };
};

describe('workers', () => {
  let ctx: ComposedApp;

  beforeAll(async () => {
    ctx = await startTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('sweeps lapsed ACTIVE holds to EXPIRED without touching live ones', async () => {
    const clinic = await seedClinic();
    const start = slotAt({ hour: 9 });

    await query(
      `INSERT INTO holds (therapist_id, patient_id, start_time, end_time, expires_at, created_at, status)
       VALUES ($1::uuid, $2::uuid, $3::timestamptz, $3::timestamptz + interval '1 hour',
               now() - interval '2 seconds', now() - interval '70 seconds', 'ACTIVE')`,
      [clinic.therapist.therapistId, clinic.patient.id, start],
    );
    await query(
      `INSERT INTO holds (therapist_id, patient_id, start_time, end_time, expires_at, status)
       VALUES ($1::uuid, $2::uuid, $3::timestamptz, $3::timestamptz + interval '1 hour',
               now() + interval '60 seconds', 'ACTIVE')`,
      [clinic.therapist.therapistId, clinic.patient2.id, slotAt({ hour: 11 })],
    );

    const sweeper = createHoldSweeper({
      logger: ctx.logger,
      db: ctx.database.db,
      metrics: ctx.metrics,
      batchSize: 50,
    });

    await sweeper.sweep();

    const rows = await query<{ status: string; patientId: string }>(
      `SELECT status, patient_id AS "patientId" FROM holds ORDER BY start_time`,
    );
    const expired = rows.filter((row) => row.patientId === clinic.patient.id);
    const live = rows.filter((row) => row.patientId === clinic.patient2.id);

    expect(expired[0]?.status).toBe('EXPIRED');
    expect(live[0]?.status).toBe('ACTIVE');
  });

  it('publishes a confirmation outbox row exactly once via the noop queue', async () => {
    const clinic = await seedClinic();
    const patient = await login(ctx.app, clinic.patient.email);
    const hold = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/holds',
      token: patient.token,
      body: { therapistId: clinic.therapist.therapistId, startTime: slotAt({ hour: 10 }) },
    });
    const confirm = await request<{ id: string }>(ctx.app, {
      method: 'POST',
      url: '/v1/appointments/confirm',
      token: patient.token,
      headers: { 'idempotency-key': idempotencyKey() },
      body: { holdId: hold.body.id },
    });
    expect(confirm.status).toBe(201);

    const queue = createNoopPublisher();
    const publisher = createOutboxPublisher({
      config: ctx.config,
      logger: ctx.logger,
      db: ctx.database.db,
      metrics: ctx.metrics,
      queue,
    });

    await publisher.publishBatch();
    await publisher.publishBatch();

    expect(queue.published).toHaveLength(1);
    expect(queue.published[0]?.eventType).toBe(EventType.APPOINTMENT_CONFIRMED);
    expect(queue.published[0]?.aggregateId).toBe(confirm.body.id);

    const rows = await query<{ status: string }>(
      `SELECT status FROM outbox_events WHERE aggregate_id = $1::uuid`,
      [confirm.body.id],
    );
    expect(rows[0]?.status).toBe('PUBLISHED');
  });

  it('deduplicates a redelivered queue message so the sender fires once', async () => {
    const clinic = await seedClinic();
    const sent: string[] = [];
    const sender: NotificationSender = {
      send: async (notification) => {
        sent.push(notification.template);
      },
    };

    const envelope: EventEnvelope = {
      eventId: randomUUID(),
      eventType: EventType.APPOINTMENT_CONFIRMED,
      aggregateType: AggregateType.APPOINTMENT,
      aggregateId: randomUUID(),
      occurredAt: new Date().toISOString(),
      payload: {
        appointmentId: randomUUID(),
        therapistId: clinic.therapist.therapistId!,
        patientId: clinic.patient.id,
        startTime: slotAt({ hour: 13 }),
        endTime: slotAt({ hour: 14 }),
      },
    };

    const queue = createMemoryQueue();
    await queue.publish([envelope]);
    await queue.publish([envelope]);

    const consumer = createNotificationConsumer({
      config: ctx.config,
      logger: ctx.logger,
      db: ctx.database.db,
      metrics: ctx.metrics,
      queue,
      sender,
    });

    await consumer.consumeBatch();
    await consumer.consumeBatch();

    expect(sent).toEqual([
      'appointment-confirmed-patient',
      'appointment-booked-therapist',
    ]);
  });
});
