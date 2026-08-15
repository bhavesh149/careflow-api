/**
 * The shared vocabulary of the system: the closed sets of values that every layer agrees on.
 *
 * These live here, and not in the Drizzle schema, because they are business facts rather than
 * storage details. An appointment being SCHEDULED or CANCELLED is meaningful with no database in
 * sight, and the domain layer must be able to reason about it without importing persistence code
 * (a rule the lint configuration enforces).
 *
 * Each union is mirrored by a CHECK constraint in `migrations/`, so an unknown value cannot enter
 * the database even if a future caller bypasses the application entirely. Adding a value means
 * changing three places on purpose: this file, the CHECK constraint, and the state machine that
 * decides which transitions are legal.
 *
 * This file must stay dependency-free — types only, no imports.
 */

export type UserRole = 'PATIENT' | 'THERAPIST';

export type UserStatus = 'ACTIVE' | 'DISABLED';

/**
 * ACTIVE holds block the slot. CONSUMED means it became an appointment, RELEASED that the patient
 * gave it up, EXPIRED that the TTL lapsed. The three terminal states are distinguished rather
 * than collapsed so that "how often do patients abandon a booking?" is answerable from the data.
 */
export type HoldStatus = 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'RELEASED';

export type AppointmentStatus = 'SCHEDULED' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED';

/** Records whether a cancellation was aimed at one occurrence or the whole series. */
export type CancellationScope = 'INSTANCE' | 'SERIES';

export type SeriesStatus = 'ACTIVE' | 'CANCELLED';

export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';

export type IdempotencyState = 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'DEAD';

/**
 * Why a refresh token stopped being usable. REUSE_DETECTED is the interesting one: it means a
 * token was presented twice, which implies theft, and it is the trigger for revoking the entire
 * token family.
 */
export type RefreshTokenRevokedReason =
  'ROTATED' | 'LOGOUT' | 'REUSE_DETECTED' | 'EXPIRED' | 'ADMIN';
