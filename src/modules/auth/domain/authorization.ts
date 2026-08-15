import { forbidden } from '@/shared/errors/app-error.js';
import type { UserRole } from '@/shared/domain/vocabulary.js';

/**
 * Authorization policies, kept as pure functions in the domain so they are unit-testable
 * without a request object and reusable from anywhere.
 *
 * The distinction these enforce is the one OWASP calls Broken Access Control, the most
 * common serious web vulnerability:
 *
 *   Role check      -- "are you a therapist?"                (coarse; a route can do this)
 *   Ownership check -- "is this appointment *yours*?"        (fine; only the row can answer)
 *
 * A role check alone is not authorization. Any therapist passes "is a therapist", so without
 * the ownership check a therapist could update another therapist's appointments. Every
 * handler that touches a specific record therefore performs both.
 */

export interface Actor {
  readonly userId: string;
  readonly role: UserRole;
  readonly therapistId?: string;
}

export const isPatient = (actor: Actor): boolean => actor.role === 'PATIENT';
export const isTherapist = (actor: Actor): boolean => actor.role === 'THERAPIST';

export const assertPatient = (actor: Actor): void => {
  if (!isPatient(actor)) {
    throw forbidden('This action is only available to patients.');
  }
};

export const assertTherapist = (actor: Actor): void => {
  if (!isTherapist(actor)) {
    throw forbidden('This action is only available to therapists.');
  }
};

/**
 * Resolves the acting therapist's own profile id.
 *
 * Routes are deliberately scoped as `/therapists/me/...` rather than
 * `/therapists/:id/...` so that there is no client-supplied id to confuse with identity.
 * This helper is the single place that answers "which therapist am I".
 */
export const requireTherapistId = (actor: Actor): string => {
  assertTherapist(actor);

  if (actor.therapistId === undefined) {
    // A therapist account with no profile row is a data-integrity fault, not a client error.
    throw forbidden('This therapist account has no profile associated with it.');
  }

  return actor.therapistId;
};

/** Object-level check for records owned by a patient (holds, appointments, series). */
export const assertOwnedByPatient = (actor: Actor, resourcePatientId: string): void => {
  if (actor.userId !== resourcePatientId) {
    // Same message and status as a genuinely missing resource would produce at the route
    // level, so an attacker cannot use the difference to confirm that an id exists.
    throw forbidden('You do not have access to this resource.');
  }
};

/** Object-level check for records assigned to a therapist. */
export const assertAssignedToTherapist = (actor: Actor, resourceTherapistId: string): void => {
  if (requireTherapistId(actor) !== resourceTherapistId) {
    throw forbidden('You do not have access to this resource.');
  }
};

/**
 * Read access to an appointment: the patient who booked it, or the therapist delivering it.
 * Used by the shared appointment-detail endpoint.
 */
export const assertCanViewAppointment = (
  actor: Actor,
  appointment: { patientId: string; therapistId: string },
): void => {
  if (isPatient(actor) && actor.userId === appointment.patientId) {
    return;
  }

  if (isTherapist(actor) && actor.therapistId === appointment.therapistId) {
    return;
  }

  throw forbidden('You do not have access to this appointment.');
};
