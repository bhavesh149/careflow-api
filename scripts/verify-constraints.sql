-- ===========================================================================
-- Proves the database-level booking invariants actually hold.
--
-- Run against a scratch database:
--   psql -U careflow_owner -d careflow -f scripts/verify-constraints.sql
--
-- Each statement expected to fail is wrapped in a SAVEPOINT so that one deliberate
-- violation does not abort the rest of the run. A "no error" result where an error is
-- expected means the protection is not real, which is the failure mode this script exists
-- to catch. The equivalent assertions also run automatically in tests/integration.
-- ===========================================================================

\set ON_ERROR_STOP off

BEGIN;

INSERT INTO users (id, email, password_hash, role, full_name)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'therapist@example.com', 'x', 'THERAPIST', 'T One'),
  ('44444444-4444-4444-4444-444444444444', 'therapist2@example.com', 'x', 'THERAPIST', 'T Two'),
  ('22222222-2222-2222-2222-222222222222', 'patient.a@example.com', 'x', 'PATIENT', 'Patient A'),
  ('33333333-3333-3333-3333-333333333333', 'patient.b@example.com', 'x', 'PATIENT', 'Patient B');

INSERT INTO therapists (id, user_id, display_name)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'T One'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '44444444-4444-4444-4444-444444444444', 'T Two');

\echo ''
\echo '### T1  first appointment inserts                              [expect INSERT 0 1]'
INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222',
        '2026-09-07 10:00:00+00', '2026-09-07 11:00:00+00');

\echo ''
\echo '### T2  overlapping appointment, other patient                 [expect 23P01 appointments_no_overlap]'
SAVEPOINT t2;
INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333',
        '2026-09-07 10:30:00+00', '2026-09-07 11:30:00+00');
ROLLBACK TO SAVEPOINT t2;

\echo ''
\echo '### T3  back-to-back 11:00-12:00 (half-open must not collide)   [expect INSERT 0 1]'
INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333',
        '2026-09-07 11:00:00+00', '2026-09-07 12:00:00+00');

\echo ''
\echo '### T4  cancelling frees the slot for rebooking                [expect UPDATE 1 then INSERT 0 1]'
UPDATE appointments
   SET status = 'CANCELLED', cancelled_at = now()
 WHERE start_time = '2026-09-07 10:00:00+00';
INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222',
        '2026-09-07 10:00:00+00', '2026-09-07 11:00:00+00');

\echo ''
\echo '### T5  COMPLETED appointments still block rebooking           [expect UPDATE 1 then 23P01]'
UPDATE appointments SET status = 'COMPLETED'
 WHERE start_time = '2026-09-07 11:00:00+00' AND status = 'SCHEDULED';
SAVEPOINT t5;
INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222',
        '2026-09-07 11:00:00+00', '2026-09-07 12:00:00+00');
ROLLBACK TO SAVEPOINT t5;

\echo ''
\echo '### T6  patient double-booked across two therapists            [expect 23P01 appointments_patient_no_overlap]'
SAVEPOINT t6;
INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222',
        '2026-09-07 10:15:00+00', '2026-09-07 11:15:00+00');
ROLLBACK TO SAVEPOINT t6;

\echo ''
\echo '### T7  series_id and occurrence_index must agree              [expect 23514]'
SAVEPOINT t7;
INSERT INTO appointments (therapist_id, patient_id, occurrence_index, start_time, end_time)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 3,
        '2026-10-01 10:00:00+00', '2026-10-01 11:00:00+00');
ROLLBACK TO SAVEPOINT t7;

\echo ''
\echo '### T8  two ACTIVE holds on one slot                           [expect INSERT 0 1 then 23P01 holds_no_overlap]'
INSERT INTO holds (therapist_id, patient_id, start_time, end_time, expires_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222',
        '2026-09-08 14:00:00+00', '2026-09-08 15:00:00+00', now() + interval '60 seconds');
SAVEPOINT t8;
INSERT INTO holds (therapist_id, patient_id, start_time, end_time, expires_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333',
        '2026-09-08 14:30:00+00', '2026-09-08 15:30:00+00', now() + interval '60 seconds');
ROLLBACK TO SAVEPOINT t8;

\echo ''
\echo '### T9  reclaiming an expired hold frees the slot              [expect UPDATE 1 then INSERT 0 1]'
UPDATE holds SET status = 'EXPIRED' WHERE start_time = '2026-09-08 14:00:00+00';
INSERT INTO holds (therapist_id, patient_id, start_time, end_time, expires_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333',
        '2026-09-08 14:30:00+00', '2026-09-08 15:30:00+00', now() + interval '60 seconds');

\echo ''
\echo '### T10 overlapping schedule rules, same therapist/weekday     [expect INSERT 0 1 then 23P01]'
INSERT INTO therapist_schedules (therapist_id, day_of_week, start_time, end_time, effective_from)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, '09:00', '17:00', '2026-01-01');
SAVEPOINT t10;
INSERT INTO therapist_schedules (therapist_id, day_of_week, start_time, end_time, effective_from)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, '16:00', '18:00', '2026-06-01');
ROLLBACK TO SAVEPOINT t10;

\echo ''
\echo '### T11 non-overlapping hours on the same weekday              [expect INSERT 0 1]'
INSERT INTO therapist_schedules (therapist_id, day_of_week, start_time, end_time, effective_from)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, '18:00', '20:00', '2026-01-01');

\echo ''
\echo '### T12 superseding a rule allows new overlapping hours later   [expect UPDATE 1 then INSERT 0 1]'
UPDATE therapist_schedules SET effective_until = '2026-05-31'
 WHERE day_of_week = 1 AND start_time = '09:00:00';
INSERT INTO therapist_schedules (therapist_id, day_of_week, start_time, end_time, effective_from)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, '10:00', '16:00', '2026-06-01');

\echo ''
\echo '### T13 idempotency key unique per actor+operation             [expect INSERT 0 1 then 23505]'
INSERT INTO idempotency_records (key, actor_id, operation, request_hash, expires_at)
VALUES ('key-1', '22222222-2222-2222-2222-222222222222', 'confirm', 'h1', now() + interval '1 day');
SAVEPOINT t13;
INSERT INTO idempotency_records (key, actor_id, operation, request_hash, expires_at)
VALUES ('key-1', '22222222-2222-2222-2222-222222222222', 'confirm', 'h2', now() + interval '1 day');
ROLLBACK TO SAVEPOINT t13;

\echo ''
\echo '### T14 same key, different operation, is allowed              [expect INSERT 0 1]'
INSERT INTO idempotency_records (key, actor_id, operation, request_hash, expires_at)
VALUES ('key-1', '22222222-2222-2222-2222-222222222222', 'cancel', 'h3', now() + interval '1 day');

\echo ''
\echo '### T15 email must be stored lowercased                        [expect 23514]'
SAVEPOINT t15;
INSERT INTO users (email, password_hash, role, full_name)
VALUES ('MixedCase@Example.com', 'x', 'PATIENT', 'Bad Email');
ROLLBACK TO SAVEPOINT t15;

\echo ''
\echo '### T16 a COMPLETED record must carry a stored response        [expect 23514]'
SAVEPOINT t16;
INSERT INTO idempotency_records (key, actor_id, operation, request_hash, state, expires_at)
VALUES ('key-2', '22222222-2222-2222-2222-222222222222', 'confirm', 'h4', 'COMPLETED',
        now() + interval '1 day');
ROLLBACK TO SAVEPOINT t16;

\echo ''
\echo '### T17 cancelled appointment must record cancelled_at         [expect 23514]'
SAVEPOINT t17;
INSERT INTO appointments (therapist_id, patient_id, start_time, end_time, status)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222',
        '2026-11-01 10:00:00+00', '2026-11-01 11:00:00+00', 'CANCELLED');
ROLLBACK TO SAVEPOINT t17;

\echo ''
\echo '### T18 zero-length and inverted intervals are rejected        [expect 23514 twice]'
SAVEPOINT t18a;
INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222',
        '2026-11-02 10:00:00+00', '2026-11-02 10:00:00+00');
ROLLBACK TO SAVEPOINT t18a;
SAVEPOINT t18b;
INSERT INTO appointments (therapist_id, patient_id, start_time, end_time)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222',
        '2026-11-02 11:00:00+00', '2026-11-02 10:00:00+00');
ROLLBACK TO SAVEPOINT t18b;

\echo ''
\echo '### Final state (nothing is committed; the run ends in ROLLBACK)'
SELECT status, count(*) AS appointments FROM appointments GROUP BY status ORDER BY status;
SELECT status, count(*) AS holds FROM holds GROUP BY status ORDER BY status;

ROLLBACK;
