import { describe, expect, it } from 'vitest';
import {
  assertAssignedToTherapist,
  assertCanViewAppointment,
  assertOwnedByPatient,
  assertPatient,
  assertTherapist,
  requireTherapistId,
  type Actor,
} from '@/modules/auth/domain/authorization.js';

/**
 * Broken access control is the most common serious web vulnerability, and it is almost always the
 * same mistake: checking the *role* and forgetting to check *ownership*. Every therapist passes
 * "is a therapist", so the interesting assertions below are the cross-tenant ones — one therapist
 * reaching another therapist's appointment, one patient reaching another patient's.
 */

const patient: Actor = { userId: 'patient-1', role: 'PATIENT' };
const otherPatient: Actor = { userId: 'patient-2', role: 'PATIENT' };
const therapist: Actor = {
  userId: 'therapist-user-1',
  role: 'THERAPIST',
  therapistId: 'therapist-1',
};
const otherTherapist: Actor = {
  userId: 'therapist-user-2',
  role: 'THERAPIST',
  therapistId: 'therapist-2',
};

const expectForbidden = (act: () => void): void => {
  try {
    act();
    expect.unreachable('the action should have been refused');
  } catch (error) {
    expect((error as { code?: string }).code).toBe('FORBIDDEN');
    expect((error as { httpStatus?: number }).httpStatus).toBe(403);
  }
};

describe('role checks', () => {
  it('lets a patient through a patient-only action', () => {
    expect(() => assertPatient(patient)).not.toThrow();
  });

  it('refuses a therapist on a patient-only action', () => {
    expectForbidden(() => assertPatient(therapist));
  });

  it('lets a therapist through a therapist-only action', () => {
    expect(() => assertTherapist(therapist)).not.toThrow();
  });

  it('refuses a patient on a therapist-only action', () => {
    expectForbidden(() => assertTherapist(patient));
  });
});

describe('requireTherapistId', () => {
  it('resolves the acting therapist profile', () => {
    expect(requireTherapistId(therapist)).toBe('therapist-1');
  });

  it('refuses a therapist account with no profile row', () => {
    // A data-integrity fault, but the safe behaviour is to deny rather than to guess an id.
    expectForbidden(() => requireTherapistId({ userId: 'u', role: 'THERAPIST' }));
  });

  it('refuses a patient outright', () => {
    expectForbidden(() => requireTherapistId(patient));
  });
});

describe('ownership checks', () => {
  it('allows a patient to reach their own record', () => {
    expect(() => assertOwnedByPatient(patient, 'patient-1')).not.toThrow();
  });

  it("refuses a patient reaching another patient's record", () => {
    expectForbidden(() => assertOwnedByPatient(patient, otherPatient.userId));
  });

  it('allows a therapist to reach a record assigned to them', () => {
    expect(() => assertAssignedToTherapist(therapist, 'therapist-1')).not.toThrow();
  });

  it("refuses a therapist reaching another therapist's record", () => {
    // The check a role guard alone would let through, which is the whole point of having it.
    expectForbidden(() => assertAssignedToTherapist(therapist, 'therapist-2'));
  });
});

describe('assertCanViewAppointment', () => {
  const appointment = { patientId: 'patient-1', therapistId: 'therapist-1' };

  it('allows the patient who booked it', () => {
    expect(() => assertCanViewAppointment(patient, appointment)).not.toThrow();
  });

  it('allows the therapist delivering it', () => {
    expect(() => assertCanViewAppointment(therapist, appointment)).not.toThrow();
  });

  it('refuses an unrelated patient', () => {
    expectForbidden(() => assertCanViewAppointment(otherPatient, appointment));
  });

  it('refuses an unrelated therapist', () => {
    expectForbidden(() => assertCanViewAppointment(otherTherapist, appointment));
  });

  it('does not confuse a patient id with a therapist id', () => {
    // A patient whose user id happens to equal the therapist id must not gain access; identity
    // and role are checked together, never one substituted for the other.
    expectForbidden(() =>
      assertCanViewAppointment({ userId: 'therapist-1', role: 'PATIENT' }, appointment),
    );
  });

  it('does not leak whether the appointment exists', () => {
    // Same code and message as a genuinely missing record produces at the route level, so the
    // difference cannot be used to confirm that an id is real.
    try {
      assertCanViewAppointment(otherPatient, appointment);
      expect.unreachable('the read should have been refused');
    } catch (error) {
      expect((error as Error).message).not.toContain(appointment.patientId);
      expect((error as Error).message).not.toContain(appointment.therapistId);
    }
  });
});
