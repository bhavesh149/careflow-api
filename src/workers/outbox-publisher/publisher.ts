import type { AppConfig } from '@/shared/config/index.js';
import type { Logger } from '@/shared/logging/index.js';
import type { Database } from '@/shared/database/index.js';
import { parseTimestamp, withTransaction } from '@/shared/database/index.js';
import { Metric, type MetricsRegistry } from '@/shared/observability/index.js';
import {
  claimOutboxBatch,
  markOutboxFailed,
  markOutboxPublished,
  type QueuePublisher,
} from '@/shared/events/index.js';
import {
  isKnownAggregateType,
  isKnownEventType,
  type EventEnvelope,
} from '@/shared/events/domain-events.js';

/**
 * The outbox publisher: the half of the transactional-outbox pattern that lives outside the
 * request path.
 *
 * The API writes business state and its events in one transaction, so an event is never lost and
 * never describes something that did not happen. This worker moves those rows to SQS. The
 * division matters: publishing inside the request transaction would mean either committing before
 * the queue accepts the message (losing events on failure) or holding a database transaction open
 * across a network call to AWS (turning an SQS slowdown into database connection exhaustion).
 *
 * Delivery is therefore at-least-once, not exactly-once. That is a deliberate choice — the
 * alternative requires distributed transactions — and it is why consumers deduplicate.
 */

export interface OutboxPublisherDependencies {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Database;
  readonly metrics: MetricsRegistry;
  readonly queue: QueuePublisher;
}

export interface OutboxPublisher {
  /** One batch. Returns true when the batch was full, meaning more work is waiting. */
  publishBatch(): Promise<boolean>;
}

export const createOutboxPublisher = (
  dependencies: OutboxPublisherDependencies,
): OutboxPublisher => {
  const { config, logger, db, metrics, queue } = dependencies;

  return {
    publishBatch: async () => {
      // Claim and publish are separate transactions on purpose. The claim commits the incremented
      // attempt count immediately, so a crash between claim and publish costs one retry rather
      // than leaving the row locked and the batch invisible until a connection timeout.
      const events = await withTransaction(db, async (tx) =>
        claimOutboxBatch(tx, config.OUTBOX_BATCH_SIZE),
      );

      if (events.length === 0) return false;

      const envelopes: EventEnvelope[] = [];

      for (const event of events) {
        // The row's type columns are plain text, and this worker is the point where they become
        // a typed contract again. An unrecognised type cannot be published to a consumer that
        // does not know how to handle it, and retrying will never make it recognisable, so it
        // goes straight to DEAD for a human to look at.
        if (!isKnownEventType(event.eventType) || !isKnownAggregateType(event.aggregateType)) {
          await markOutboxFailed(
            db,
            event.id,
            config.OUTBOX_MAX_ATTEMPTS,
            config.OUTBOX_MAX_ATTEMPTS,
            `unrecognised event type '${event.eventType}'/'${event.aggregateType}'`,
          );
          metrics.increment(Metric.OUTBOX_DEAD, { eventType: 'unknown' });
          logger.error(
            { eventId: event.id, eventType: event.eventType, aggregateType: event.aggregateType },
            'outbox row has an unrecognised event type; marked dead without publishing',
          );
          continue;
        }

        envelopes.push({
          eventId: event.id,
          eventType: event.eventType,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          occurredAt: parseTimestamp(event.occurredAt).toISOString(),
          payload: event.payload as EventEnvelope['payload'],
        });
      }

      if (envelopes.length === 0) return events.length === config.OUTBOX_BATCH_SIZE;

      const result = await queue.publish(envelopes);

      if (result.successfulIds.length > 0) {
        await markOutboxPublished(db, result.successfulIds);
        metrics.increment(Metric.OUTBOX_PUBLISHED, {}, result.successfulIds.length);
      }

      for (const failure of result.failures) {
        const event = events.find((candidate) => candidate.id === failure.id);
        if (!event) continue;

        const outcome = await markOutboxFailed(
          db,
          failure.id,
          event.attempts,
          config.OUTBOX_MAX_ATTEMPTS,
          failure.reason,
        );

        metrics.increment(Metric.OUTBOX_FAILED, { eventType: event.eventType });

        if (outcome === 'DEAD') {
          metrics.increment(Metric.OUTBOX_DEAD, { eventType: event.eventType });
          // Loud on purpose: a dead event means a notification will never be sent, which is a
          // user-visible failure even though no request failed. This is alarm-worthy.
          logger.error(
            {
              eventId: failure.id,
              eventType: event.eventType,
              attempts: event.attempts,
              reason: failure.reason,
            },
            'outbox event abandoned after exhausting retries; manual intervention required',
          );
        } else {
          logger.warn(
            { eventId: failure.id, eventType: event.eventType, attempts: event.attempts },
            'outbox publish failed; scheduled for retry',
          );
        }
      }

      logger.debug(
        {
          claimed: events.length,
          published: result.successfulIds.length,
          failed: result.failures.length,
        },
        'outbox batch processed',
      );

      // A full batch almost certainly means a backlog; skip the idle wait and keep draining.
      return events.length === config.OUTBOX_BATCH_SIZE;
    },
  };
};
