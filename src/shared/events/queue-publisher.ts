import {
  SQSClient,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '@/shared/config/index.js';
import type { Logger } from '@/shared/logging/index.js';
import {
  isKnownAggregateType,
  isKnownEventType,
  type EventEnvelope,
} from '@/shared/events/domain-events.js';

/**
 * Queue port plus its SQS adapter.
 *
 * The port exists so the domain and workers never import an AWS SDK type, which is what
 * keeps the hexagon intact and lets tests run without LocalStack. Locally the same adapter
 * talks to LocalStack via SQS_ENDPOINT, so the code path under test is the production one
 * rather than a mock that agrees with our assumptions.
 */

export interface PublishResult {
  readonly successfulIds: string[];
  readonly failures: { id: string; reason: string }[];
}

export interface ReceivedMessage {
  readonly receiptHandle: string;
  readonly envelope: EventEnvelope;
}

export interface QueuePublisher {
  publish(events: readonly EventEnvelope[]): Promise<PublishResult>;
  receive(maxMessages: number, waitTimeSeconds: number): Promise<ReceivedMessage[]>;
  acknowledge(receiptHandle: string): Promise<void>;
  close(): Promise<void>;
}

// SQS caps a batch at 10 entries; exceeding it fails the whole request.
const SQS_MAX_BATCH = 10;

/**
 * Turns a message body back into a typed envelope.
 *
 * A message body is data from outside this process, so it is checked rather than asserted. The
 * cheap shape validation here is what stops a malformed or version-skewed message from flowing
 * into a consumer as a value that lies about its own type; anything that fails lands on the DLQ
 * where it can be inspected instead of silently disappearing.
 */
const parseEnvelope = (body: string): EventEnvelope => {
  const parsed: unknown = JSON.parse(body);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('message body is not an object');
  }

  const candidate = parsed as Partial<EventEnvelope>;

  if (
    typeof candidate.eventId !== 'string' ||
    typeof candidate.aggregateId !== 'string' ||
    typeof candidate.occurredAt !== 'string' ||
    typeof candidate.eventType !== 'string' ||
    !isKnownEventType(candidate.eventType) ||
    typeof candidate.aggregateType !== 'string' ||
    !isKnownAggregateType(candidate.aggregateType)
  ) {
    throw new Error(`message body is not a recognised event envelope`);
  }

  return candidate as EventEnvelope;
};

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

export const createSqsPublisher = (config: AppConfig, logger: Logger): QueuePublisher => {
  const client = new SQSClient({
    region: config.AWS_REGION,
    // Only set for LocalStack. In AWS the SDK resolves the real endpoint and picks up
    // credentials from the ECS task role, so no keys are ever configured.
    ...(config.SQS_ENDPOINT.length > 0 ? { endpoint: config.SQS_ENDPOINT } : {}),
    maxAttempts: 3,
  });

  return {
    publish: async (events) => {
      const successfulIds: string[] = [];
      const failures: { id: string; reason: string }[] = [];

      for (const batch of chunk(events, SQS_MAX_BATCH)) {
        const entries: SendMessageBatchRequestEntry[] = batch.map((event) => ({
          Id: event.eventId,
          MessageBody: JSON.stringify(event),
          MessageAttributes: {
            eventType: { DataType: 'String', StringValue: event.eventType },
            aggregateType: { DataType: 'String', StringValue: event.aggregateType },
          },
        }));

        try {
          const response = await client.send(
            new SendMessageBatchCommand({ QueueUrl: config.SQS_QUEUE_URL, Entries: entries }),
          );

          // A batch send can partially succeed, so per-entry results must be honoured;
          // treating the call as all-or-nothing would republish already-delivered events.
          for (const success of response.Successful ?? []) {
            if (success.Id) successfulIds.push(success.Id);
          }

          for (const failure of response.Failed ?? []) {
            if (failure.Id) {
              failures.push({
                id: failure.Id,
                reason: failure.Message ?? failure.Code ?? 'unknown',
              });
            }
          }
        } catch (error) {
          logger.error({ err: error, batchSize: batch.length }, 'sqs batch send failed');
          for (const event of batch) {
            failures.push({
              id: event.eventId,
              reason: error instanceof Error ? error.message : 'send failed',
            });
          }
        }
      }

      return { successfulIds, failures };
    },

    receive: async (maxMessages, waitTimeSeconds) => {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: config.SQS_QUEUE_URL,
          MaxNumberOfMessages: Math.min(maxMessages, SQS_MAX_BATCH),
          // Long polling: one held connection instead of a tight empty-receive loop, which
          // both reduces cost and cuts delivery latency.
          WaitTimeSeconds: waitTimeSeconds,
          MessageAttributeNames: ['All'],
        }),
      );

      const messages: ReceivedMessage[] = [];

      for (const message of response.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) continue;

        try {
          const envelope = parseEnvelope(message.Body);
          messages.push({ receiptHandle: message.ReceiptHandle, envelope });
        } catch (error) {
          // Unparseable message: acknowledging it would silently discard data, so leave it
          // to exhaust maxReceiveCount and land on the DLQ where it can be inspected.
          logger.error(
            { err: error, messageId: message.MessageId },
            'unusable queue message; leaving it to expire onto the DLQ',
          );
        }
      }

      return messages;
    },

    acknowledge: async (receiptHandle) => {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: config.SQS_QUEUE_URL, ReceiptHandle: receiptHandle }),
      );
    },

    close: async () => {
      client.destroy();
    },
  };
};

/** Used in unit tests and when QUEUE_DRIVER=noop. Records what would have been published. */
export const createNoopPublisher = (): QueuePublisher & { published: EventEnvelope[] } => {
  const published: EventEnvelope[] = [];

  return {
    published,
    publish: async (events) => {
      published.push(...events);
      return { successfulIds: events.map((event) => event.eventId), failures: [] };
    },
    receive: async () => [],
    acknowledge: async () => undefined,
    close: async () => undefined,
  };
};

export const createQueuePublisher = (config: AppConfig, logger: Logger): QueuePublisher =>
  config.QUEUE_DRIVER === 'sqs' ? createSqsPublisher(config, logger) : createNoopPublisher();
