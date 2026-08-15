/**
 * The event contract carried by the outbox and the queue.
 *
 * Events are past-tense facts, never commands: a consumer may decide to ignore
 * `AppointmentConfirmed`, but it cannot argue with the fact that it happened.
 *
 * Payloads carry identifiers and timestamps, not patient names, emails or notes. A queue
 * message is copied into SQS, CloudWatch and whatever the consumer logs, so treating the
 * payload as a place to pass PII around would spread it across three more systems. A
 * consumer that needs a name looks it up under its own access controls.
 */

export const EventType = {
  APPOINTMENT_CONFIRMED: 'AppointmentConfirmed',
  APPOINTMENT_CANCELLED: 'AppointmentCancelled',
  APPOINTMENT_STATUS_CHANGED: 'AppointmentStatusChanged',
  RECURRING_SERIES_CREATED: 'RecurringSeriesCreated',
  RECURRING_SERIES_CANCELLED: 'RecurringSeriesCancelled',
  HOLD_EXPIRED: 'HoldExpired',
  SCHEDULE_UPDATED: 'TherapistScheduleUpdated',
} as const;

export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

export const AggregateType = {
  APPOINTMENT: 'Appointment',
  RECURRING_SERIES: 'RecurringSeries',
  HOLD: 'Hold',
  THERAPIST_SCHEDULE: 'TherapistSchedule',
} as const;

export type AggregateTypeValue = (typeof AggregateType)[keyof typeof AggregateType];

const EVENT_TYPES = new Set<string>(Object.values(EventType));
const AGGREGATE_TYPES = new Set<string>(Object.values(AggregateType));

/**
 * Guards used where events re-enter the process as data rather than as typed calls: rows read
 * back from the outbox, and message bodies received from the queue.
 *
 * The check earns its place during a rolling deploy. Two versions run side by side for a few
 * minutes, so the newer one can write an event type the older one has never heard of. Validating
 * at this boundary turns that into a handled, logged case instead of a value that flows onward as
 * a lie about its own type.
 */
export const isKnownEventType = (value: string): value is EventTypeValue => EVENT_TYPES.has(value);

export const isKnownAggregateType = (value: string): value is AggregateTypeValue =>
  AGGREGATE_TYPES.has(value);

export interface DomainEventPayloadBase {
  readonly therapistId: string;
  readonly patientId?: string;
  /** Propagated from the originating HTTP request so async work stays traceable. */
  readonly requestId?: string;
}

export interface AppointmentConfirmedPayload extends DomainEventPayloadBase {
  readonly appointmentId: string;
  readonly patientId: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly seriesId?: string;
}

export interface AppointmentCancelledPayload extends DomainEventPayloadBase {
  readonly appointmentId: string;
  readonly patientId: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly scope: 'INSTANCE' | 'SERIES';
  readonly cancelledBy: string;
}

export interface AppointmentStatusChangedPayload extends DomainEventPayloadBase {
  readonly appointmentId: string;
  readonly patientId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly changedBy: string;
}

export interface RecurringSeriesCreatedPayload extends DomainEventPayloadBase {
  readonly seriesId: string;
  readonly patientId: string;
  readonly frequency: string;
  readonly occurrences: number;
  readonly firstStartTime: string;
}

export interface RecurringSeriesCancelledPayload extends DomainEventPayloadBase {
  readonly seriesId: string;
  readonly patientId: string;
  readonly cancelledInstances: number;
  readonly cancelledBy: string;
}

export interface HoldExpiredPayload extends DomainEventPayloadBase {
  readonly holdId: string;
  readonly patientId: string;
  readonly startTime: string;
  readonly endTime: string;
}

export interface ScheduleUpdatedPayload extends DomainEventPayloadBase {
  readonly effectiveFrom: string;
  readonly ruleCount: number;
}

export type DomainEventPayload =
  | AppointmentConfirmedPayload
  | AppointmentCancelledPayload
  | AppointmentStatusChangedPayload
  | RecurringSeriesCreatedPayload
  | RecurringSeriesCancelledPayload
  | HoldExpiredPayload
  | ScheduleUpdatedPayload;

/** What a use case hands to the outbox, inside its own transaction. */
export interface NewDomainEvent {
  readonly aggregateType: AggregateTypeValue;
  readonly aggregateId: string;
  readonly eventType: EventTypeValue;
  readonly payload: DomainEventPayload;
}

/** The envelope actually placed on the queue. */
export interface EventEnvelope {
  readonly eventId: string;
  readonly eventType: EventTypeValue;
  readonly aggregateType: AggregateTypeValue;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly payload: DomainEventPayload;
}
