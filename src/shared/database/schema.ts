import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  date,
} from 'drizzle-orm/pg-core';

/**
 * Typed mirror of the SQL in `migrations/`.
 *
 * The SQL files are authoritative; this file exists to give the repositories compile-time
 * column names and row types. It deliberately does not describe the exclusion constraints,
 * custom range types or partial indexes, because Drizzle cannot express them and pretending
 * otherwise would invite someone to run a schema diff and drop them.
 *
 * Integration tests assert that this mirror and the real schema agree.
 */

// The value sets are owned by the shared domain vocabulary, not by this file: they are business
// facts that the domain layer must be able to name without importing persistence code. Re-exported
// here so repositories can pull a column's row type and its value set from one place.
import type {
  AppointmentStatus,
  CancellationScope,
  HoldStatus,
  IdempotencyState,
  OutboxStatus,
  RecurrenceFrequency,
  RefreshTokenRevokedReason,
  SeriesStatus,
  UserRole,
  UserStatus,
} from '@/shared/domain/vocabulary.js';

export type {
  AppointmentStatus,
  CancellationScope,
  HoldStatus,
  IdempotencyState,
  OutboxStatus,
  RecurrenceFrequency,
  RefreshTokenRevokedReason,
  SeriesStatus,
  UserRole,
  UserStatus,
};

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').$type<UserRole>().notNull(),
    fullName: text('full_name').notNull(),
    status: text('status').$type<UserStatus>().notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_key').on(table.email)],
);

export const therapists = pgTable(
  'therapists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    displayName: text('display_name').notNull(),
    specialization: text('specialization'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [unique('therapists_user_id_key').on(table.userId)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: text('revoked_reason').$type<RefreshTokenRevokedReason>(),
    replacedBy: uuid('replaced_by'),
  },
  (table) => [
    unique('refresh_tokens_token_hash_key').on(table.tokenHash),
    index('refresh_tokens_user_id_idx').on(table.userId),
    index('refresh_tokens_family_id_idx').on(table.familyId),
  ],
);

export const therapistSchedules = pgTable(
  'therapist_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    therapistId: uuid('therapist_id')
      .notNull()
      .references(() => therapists.id, { onDelete: 'cascade' }),
    // ISO weekday: 1 = Monday .. 7 = Sunday.
    dayOfWeek: smallint('day_of_week').notNull(),
    // 'HH:MM:SS' wall-clock in APP_TIMEZONE.
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    effectiveUntil: date('effective_until', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('therapist_schedules_lookup_idx').on(
      table.therapistId,
      table.dayOfWeek,
      table.effectiveFrom,
      table.effectiveUntil,
    ),
  ],
);

export const recurringSeries = pgTable(
  'recurring_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    therapistId: uuid('therapist_id')
      .notNull()
      .references(() => therapists.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => users.id),
    frequency: text('frequency').$type<RecurrenceFrequency>().notNull(),
    anchorStart: timestamp('anchor_start', { withTimezone: true, mode: 'date' }).notNull(),
    anchorEnd: timestamp('anchor_end', { withTimezone: true, mode: 'date' }).notNull(),
    occurrences: integer('occurrences').notNull(),
    status: text('status').$type<SeriesStatus>().notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('recurring_series_patient_idx').on(table.patientId, table.createdAt),
    index('recurring_series_therapist_idx').on(table.therapistId, table.createdAt),
  ],
);

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    therapistId: uuid('therapist_id')
      .notNull()
      .references(() => therapists.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => users.id),
    seriesId: uuid('series_id').references(() => recurringSeries.id),
    occurrenceIndex: integer('occurrence_index'),
    startTime: timestamp('start_time', { withTimezone: true, mode: 'date' }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true, mode: 'date' }).notNull(),
    status: text('status').$type<AppointmentStatus>().notNull().default('SCHEDULED'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancellationScope: text('cancellation_scope').$type<CancellationScope>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('appointments_patient_start_idx').on(table.patientId, table.startTime),
    index('appointments_therapist_start_idx').on(table.therapistId, table.startTime),
    index('appointments_series_idx').on(table.seriesId, table.startTime),
  ],
);

export const holds = pgTable(
  'holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    therapistId: uuid('therapist_id')
      .notNull()
      .references(() => therapists.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startTime: timestamp('start_time', { withTimezone: true, mode: 'date' }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: text('status').$type<HoldStatus>().notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [index('holds_patient_active_idx').on(table.patientId, table.expiresAt)],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    requestHash: text('request_hash').notNull(),
    state: text('state').$type<IdempotencyState>().notNull().default('PROCESSING'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    unique('idempotency_records_actor_operation_key_key').on(
      table.actorId,
      table.operation,
      table.key,
    ),
    index('idempotency_records_expires_at_idx').on(table.expiresAt),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').$type<OutboxStatus>().notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('outbox_events_aggregate_idx').on(
      table.aggregateType,
      table.aggregateId,
      table.occurredAt,
    ),
  ],
);

export const processedMessages = pgTable(
  'processed_messages',
  {
    eventId: uuid('event_id').notNull(),
    consumer: text('consumer').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.consumer] })],
);

export const schema = {
  users,
  therapists,
  refreshTokens,
  therapistSchedules,
  recurringSeries,
  appointments,
  holds,
  idempotencyRecords,
  outboxEvents,
  processedMessages,
};

export type UserRow = typeof users.$inferSelect;
export type TherapistRow = typeof therapists.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type TherapistScheduleRow = typeof therapistSchedules.$inferSelect;
export type RecurringSeriesRow = typeof recurringSeries.$inferSelect;
export type AppointmentRow = typeof appointments.$inferSelect;
export type HoldRow = typeof holds.$inferSelect;
export type IdempotencyRecordRow = typeof idempotencyRecords.$inferSelect;
export type OutboxEventRow = typeof outboxEvents.$inferSelect;
