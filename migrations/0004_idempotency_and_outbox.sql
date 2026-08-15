-- ===========================================================================
-- 0004_idempotency_and_outbox
--
-- The two mechanisms that make the API safe to retry and its side effects reliable.
-- Both live in Postgres precisely because three API tasks must share one view of them;
-- anything held in process memory would give each task its own private, wrong answer.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- idempotency_records
--
-- A client that times out mid-booking has no idea whether the appointment was created.
-- Retrying with the same Idempotency-Key must return the original outcome instead of
-- creating a second appointment.
--
-- Two-phase by design: the row is claimed as PROCESSING inside the same transaction that
-- performs the work, then completed with the stored response. A concurrent duplicate sees
-- PROCESSING and is told to retry, rather than being allowed to run the operation twice.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Client-supplied key. Scoped by actor and operation so that one tenant's key can never
  -- collide with another's, and so replaying a "cancel" key cannot satisfy a "confirm".
  key             TEXT        NOT NULL,
  actor_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  operation       TEXT        NOT NULL,

  -- SHA-256 of the canonicalised request. Same key + different body is a client bug we
  -- must surface loudly (422) rather than silently returning an unrelated result.
  request_hash    TEXT        NOT NULL,

  state           TEXT        NOT NULL DEFAULT 'PROCESSING',
  response_status INTEGER,
  response_body   JSONB,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,

  CONSTRAINT idempotency_records_state_check
    CHECK (state IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  -- A COMPLETED record without a stored response would replay as an empty success, which
  -- is worse than no idempotency at all.
  CONSTRAINT idempotency_records_completed_check
    CHECK (state <> 'COMPLETED' OR (response_status IS NOT NULL AND completed_at IS NOT NULL)),

  -- The whole mechanism rests on this one unique index: it is what makes "claim the key"
  -- an atomic INSERT ... ON CONFLICT DO NOTHING rather than a check-then-act race.
  CONSTRAINT idempotency_records_actor_operation_key_key UNIQUE (actor_id, operation, key)
);

-- Supports the TTL cleanup job.
CREATE INDEX idempotency_records_expires_at_idx ON idempotency_records (expires_at);

-- ---------------------------------------------------------------------------
-- outbox_events
--
-- Transactional outbox. The booking transaction writes the appointment AND the event to
-- publish in one atomic commit, so it is impossible to have a confirmed appointment whose
-- notification was never queued, or a notification for a booking that rolled back.
--
-- Publishing to SQS inside the request transaction would be the obvious alternative and is
-- wrong: the network call can succeed while the transaction later aborts.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  aggregate_type  TEXT        NOT NULL,
  aggregate_id    UUID        NOT NULL,
  event_type      TEXT        NOT NULL,
  payload         JSONB       NOT NULL,

  status          TEXT        NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER     NOT NULL DEFAULT 0,
  last_error      TEXT,

  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Drives exponential backoff without a scheduler: the publisher simply never selects a
  -- row whose next_attempt_at is still in the future.
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ,

  CONSTRAINT outbox_events_status_check
    CHECK (status IN ('PENDING', 'PUBLISHED', 'DEAD')),
  CONSTRAINT outbox_events_published_check
    CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL)),
  CONSTRAINT outbox_events_attempts_check CHECK (attempts >= 0)
);

-- The publisher's claim query, and the reason it scales: a partial index containing only
-- unpublished work. Once an event is published it leaves the index entirely, so the queue
-- scan cost is proportional to the backlog rather than to total history.
CREATE INDEX outbox_events_pending_idx
  ON outbox_events (next_attempt_at, occurred_at)
  WHERE status = 'PENDING';

-- For debugging "what happened to this appointment's notifications".
CREATE INDEX outbox_events_aggregate_idx ON outbox_events (aggregate_type, aggregate_id, occurred_at);

-- ---------------------------------------------------------------------------
-- processed_messages
--
-- SQS guarantees at-least-once delivery, so a consumer WILL occasionally see the same
-- message twice (visibility timeout elapsed, worker crashed after handling but before
-- deleting). This table is the consumer's idempotency ledger: inserting the event id is
-- the atomic "have I already handled this?" test.
-- ---------------------------------------------------------------------------
CREATE TABLE processed_messages (
  event_id     UUID        NOT NULL,
  -- Part of the key, not just metadata: when a second consumer is added later it must be
  -- able to process events the first one already handled.
  consumer     TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,

  CONSTRAINT processed_messages_pkey PRIMARY KEY (event_id, consumer)
);

CREATE INDEX processed_messages_expires_at_idx ON processed_messages (expires_at);
