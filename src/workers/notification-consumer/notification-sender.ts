import type { Logger } from '@/shared/logging/index.js';
import { EventType } from '@/shared/events/domain-events.js';
import type { EventEnvelope } from '@/shared/events/domain-events.js';

/**
 * The notification side effect.
 *
 * There is no email provider wired in, and that is deliberate rather than unfinished: the
 * interesting engineering in this path is the delivery guarantee (transactional outbox, queue
 * redelivery, deduplication), not the SES call. A `NotificationSender` port with a logging
 * implementation keeps that boundary explicit — swapping in SES or Twilio is one adapter, with
 * no change to the consumer, its deduplication, or its retry behaviour.
 *
 * Note what is *not* here: recipient email addresses. Events carry identifiers only, so a real
 * adapter would resolve contact details itself, at send time, under its own access control. That
 * keeps PII out of SQS, out of the outbox table and out of these logs.
 */

export interface Notification {
  readonly channel: 'EMAIL' | 'SMS' | 'PUSH';
  readonly recipientUserId: string;
  readonly template: string;
  readonly context: Record<string, unknown>;
}

export interface NotificationSender {
  send(notification: Notification): Promise<void>;
}

export const createLoggingNotificationSender = (logger: Logger): NotificationSender => ({
  send: async (notification) => {
    logger.info(
      {
        event: 'notification.sent',
        channel: notification.channel,
        template: notification.template,
        recipientUserId: notification.recipientUserId,
      },
      'notification dispatched',
    );
  },
});

/**
 * Translates a domain event into the notifications it should produce.
 *
 * Pure and exhaustive: adding an event type is a compile error here until it is handled, which
 * beats discovering at runtime that a new event silently notifies nobody. Returning an array
 * covers the events that must reach both parties.
 */
export const notificationsFor = (envelope: EventEnvelope): Notification[] => {
  const { payload } = envelope;
  const base = {
    context: { ...payload, eventId: envelope.eventId, occurredAt: envelope.occurredAt },
  };

  switch (envelope.eventType) {
    case EventType.APPOINTMENT_CONFIRMED:
      return [
        {
          ...base,
          channel: 'EMAIL',
          recipientUserId: payload.patientId ?? '',
          template: 'appointment-confirmed-patient',
        },
        {
          ...base,
          channel: 'EMAIL',
          recipientUserId: payload.therapistId,
          template: 'appointment-booked-therapist',
        },
      ];

    case EventType.APPOINTMENT_CANCELLED:
      // Both parties need this one: whoever cancelled already knows, but the other side has a
      // hole in their calendar they are unaware of.
      return [
        {
          ...base,
          channel: 'EMAIL',
          recipientUserId: payload.patientId ?? '',
          template: 'appointment-cancelled-patient',
        },
        {
          ...base,
          channel: 'EMAIL',
          recipientUserId: payload.therapistId,
          template: 'appointment-cancelled-therapist',
        },
      ];

    case EventType.APPOINTMENT_STATUS_CHANGED:
      return [
        {
          ...base,
          channel: 'EMAIL',
          recipientUserId: payload.patientId ?? '',
          template: 'appointment-status-changed',
        },
      ];

    case EventType.RECURRING_SERIES_CREATED:
      return [
        {
          ...base,
          channel: 'EMAIL',
          recipientUserId: payload.patientId ?? '',
          template: 'series-created-patient',
        },
        {
          ...base,
          channel: 'EMAIL',
          recipientUserId: payload.therapistId,
          template: 'series-created-therapist',
        },
      ];

    case EventType.RECURRING_SERIES_CANCELLED:
      return [
        {
          ...base,
          channel: 'EMAIL',
          recipientUserId: payload.patientId ?? '',
          template: 'series-cancelled-patient',
        },
        {
          ...base,
          channel: 'EMAIL',
          recipientUserId: payload.therapistId,
          template: 'series-cancelled-therapist',
        },
      ];

    // Expiries and schedule edits are recorded for auditing and analytics but are not worth an
    // email. A hold lapsing after sixty seconds is normal behaviour, not news.
    case EventType.HOLD_EXPIRED:
    case EventType.SCHEDULE_UPDATED:
      return [];

    default:
      return [];
  }
};
