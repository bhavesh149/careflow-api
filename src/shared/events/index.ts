export { AggregateType, EventType } from '@/shared/events/domain-events.js';
export type {
  AggregateTypeValue,
  AppointmentCancelledPayload,
  AppointmentConfirmedPayload,
  AppointmentStatusChangedPayload,
  DomainEventPayload,
  EventEnvelope,
  EventTypeValue,
  HoldExpiredPayload,
  NewDomainEvent,
  RecurringSeriesCancelledPayload,
  RecurringSeriesCreatedPayload,
  ScheduleUpdatedPayload,
} from '@/shared/events/domain-events.js';
export {
  appendOutboxEvent,
  appendOutboxEvents,
  claimOutboxBatch,
  countPendingOutboxEvents,
  markOutboxFailed,
  markOutboxPublished,
} from '@/shared/events/outbox-repository.js';
export type { ClaimedOutboxEvent } from '@/shared/events/outbox-repository.js';
export {
  createNoopPublisher,
  createQueuePublisher,
  createSqsPublisher,
} from '@/shared/events/queue-publisher.js';
export type {
  PublishResult,
  QueuePublisher,
  ReceivedMessage,
} from '@/shared/events/queue-publisher.js';
