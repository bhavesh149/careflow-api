import type { AppConfig } from '@/shared/config/index.js';
import type { Logger } from '@/shared/logging/index.js';
import type { Database } from '@/shared/database/index.js';
import { sql } from '@/shared/database/index.js';
import { Metric, type MetricsRegistry } from '@/shared/observability/index.js';
import type { QueuePublisher } from '@/shared/events/index.js';
import type { EventEnvelope } from '@/shared/events/domain-events.js';
import {
  notificationsFor,
  type NotificationSender,
} from '@/workers/notification-consumer/notification-sender.js';

/**
 * The queue consumer.
 *
 * Because the outbox publisher guarantees at-least-once delivery, and SQS itself can redeliver a
 * message whose visibility timeout lapses, this consumer WILL see duplicates. Sending a patient
 * two "appointment confirmed" emails for one booking is exactly the kind of small, visible defect
 * that erodes trust in a product, so deduplication is not optional.
 *
 * `processed_messages` is that guard, and it lives in Postgres rather than in memory: with three
 * consumer tasks, an in-process set would only deduplicate within whichever task happened to see
 * both copies. The row is inserted *after* the side effect succeeds — the ordering matters. The
 * other way round (mark first, then send) would drop the notification entirely if the send
 * failed, and a duplicate email is a far better failure than a missing one.
 *
 * Rows are given a TTL: after a couple of days a redelivery is not plausible, and an unbounded
 * dedupe table is a slow-motion disk problem.
 */

export interface NotificationConsumerDependencies {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Database;
  readonly metrics: MetricsRegistry;
  readonly queue: QueuePublisher;
  readonly sender: NotificationSender;
}

export interface NotificationConsumer {
  /** One receive-and-process cycle. Returns true when a full batch arrived. */
  consumeBatch(): Promise<boolean>;
}

const CONSUMER_NAME = 'notification-consumer';
const DEDUPE_RETENTION_HOURS = 48;
const BATCH_SIZE = 10;

export const createNotificationConsumer = (
  dependencies: NotificationConsumerDependencies,
): NotificationConsumer => {
  const { config, logger, db, metrics, queue, sender } = dependencies;

  /**
   * Claims the message for this consumer, returning false if someone already handled it.
   *
   * `ON CONFLICT DO NOTHING` plus a check of the affected row count makes the claim atomic
   * across all consumer tasks: exactly one insert can succeed for a given (eventId, consumer).
   */
  const claim = async (envelope: EventEnvelope): Promise<boolean> => {
    const result = await db.execute(sql`
      INSERT INTO processed_messages (event_id, consumer, expires_at)
      VALUES (
        ${envelope.eventId}::uuid,
        ${CONSUMER_NAME},
        now() + (${DEDUPE_RETENTION_HOURS} * interval '1 hour')
      )
      ON CONFLICT (event_id, consumer) DO NOTHING
    `);

    return (result.rowCount ?? 0) > 0;
  };

  const release = async (envelope: EventEnvelope): Promise<void> => {
    await db.execute(sql`
      DELETE FROM processed_messages
       WHERE event_id = ${envelope.eventId}::uuid
         AND consumer = ${CONSUMER_NAME}
    `);
  };

  const process = async (envelope: EventEnvelope): Promise<void> => {
    const notifications = notificationsFor(envelope);

    for (const notification of notifications) {
      await sender.send(notification);
    }

    logger.info(
      {
        event: 'consumer.processed',
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        notifications: notifications.length,
      },
      'queue message processed',
    );
  };

  return {
    consumeBatch: async () => {
      // Long polling, so an idle consumer holds one connection open instead of spinning through
      // empty receives. The worker loop's own interval is effectively a backstop.
      const messages = await queue.receive(BATCH_SIZE, config.SQS_WAIT_TIME_SECONDS);

      if (messages.length === 0) return false;

      for (const message of messages) {
        const { envelope } = message;

        const claimed = await claim(envelope);

        if (!claimed) {
          metrics.increment(Metric.CONSUMER_DUPLICATE, { eventType: envelope.eventType });
          logger.debug(
            { eventId: envelope.eventId, eventType: envelope.eventType },
            'duplicate delivery skipped',
          );
          // Acknowledged, not left in the queue: the work is done, so redelivering it would
          // only produce the same skip again until the message hits the DLQ.
          await queue.acknowledge(message.receiptHandle);
          continue;
        }

        try {
          await process(envelope);
          await queue.acknowledge(message.receiptHandle);
          metrics.increment(Metric.CONSUMER_PROCESSED, { eventType: envelope.eventType });
        } catch (error) {
          // The claim must not outlive a failed send, or the retry would be mistaken for a
          // duplicate and the notification would be lost. Release it and leave the message
          // unacknowledged so SQS redelivers, and eventually routes it to the DLQ.
          await release(envelope).catch((releaseError: unknown) => {
            logger.error(
              { err: releaseError, eventId: envelope.eventId },
              'failed to release dedupe claim; this event may be skipped on redelivery',
            );
          });

          logger.error(
            { err: error, eventId: envelope.eventId, eventType: envelope.eventType },
            'failed to process queue message; leaving it for redelivery',
          );
        }
      }

      return messages.length === BATCH_SIZE;
    },
  };
};

/** Removes expired dedupe rows. Cheap, and it keeps the table from growing without bound. */
export const pruneProcessedMessages = async (db: Database): Promise<number> => {
  const result = await db.execute(sql`DELETE FROM processed_messages WHERE expires_at < now()`);
  return result.rowCount ?? 0;
};
