-- ===========================================================================
-- 0003_booking
--
-- Holds, recurring series and appointments: the tables that carry the concurrency
-- guarantees. This migration is the heart of the system's correctness.
--
-- The central idea: application-level conflict checks are an optimisation for fast, clear
-- rejection, but they cannot be the guarantee. Between "SELECT, no conflict" and "INSERT"
-- another of the three API tasks can commit the very row we just looked for. So the real
-- invariant lives in GiST exclusion constraints, which Postgres evaluates atomically at
-- write time. Two concurrent INSERTs for the same slot cannot both succeed regardless of
-- how the application behaves, and a future refactor cannot accidentally remove the
-- protection.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- recurring_series
-- Declared before appointments because appointments reference it.
-- ---------------------------------------------------------------------------
CREATE TABLE recurring_series (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_id  UUID        NOT NULL REFERENCES therapists (id) ON DELETE RESTRICT,
  patient_id    UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  frequency     TEXT        NOT NULL,

  -- The first occurrence. Every later occurrence is derived from this anchor plus the
  -- frequency, so the rule that generated the series is always auditable.
  anchor_start  TIMESTAMPTZ NOT NULL,
  anchor_end    TIMESTAMPTZ NOT NULL,

  occurrences   INTEGER     NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'ACTIVE',

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at  TIMESTAMPTZ,

  CONSTRAINT recurring_series_frequency_check
    CHECK (frequency IN ('DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY')),
  CONSTRAINT recurring_series_status_check
    CHECK (status IN ('ACTIVE', 'CANCELLED')),
  CONSTRAINT recurring_series_anchor_check CHECK (anchor_end > anchor_start),
  CONSTRAINT recurring_series_occurrences_check CHECK (occurrences > 0),
  -- A cancelled series must record when, and an active one must not pretend it was.
  CONSTRAINT recurring_series_cancelled_at_check
    CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);

CREATE INDEX recurring_series_patient_idx   ON recurring_series (patient_id, created_at DESC);
CREATE INDEX recurring_series_therapist_idx ON recurring_series (therapist_id, created_at DESC);

CREATE TRIGGER recurring_series_set_updated_at
  BEFORE UPDATE ON recurring_series
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------
CREATE TABLE appointments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_id     UUID        NOT NULL REFERENCES therapists (id) ON DELETE RESTRICT,
  patient_id       UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  -- NULL for a one-time booking. Set for every instance of a series, which is what makes
  -- "cancel this occurrence" and "cancel the whole series" both expressible without
  -- duplicating the appointment model.
  series_id        UUID REFERENCES recurring_series (id) ON DELETE RESTRICT,
  occurrence_index INTEGER,

  start_time       TIMESTAMPTZ NOT NULL,
  end_time         TIMESTAMPTZ NOT NULL,

  status           TEXT        NOT NULL DEFAULT 'SCHEDULED',

  cancelled_at     TIMESTAMPTZ,
  cancelled_by     UUID REFERENCES users (id) ON DELETE SET NULL,
  cancellation_scope TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT appointments_status_check
    CHECK (status IN ('SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED')),
  CONSTRAINT appointments_time_check CHECK (end_time > start_time),
  CONSTRAINT appointments_cancelled_at_check
    CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  CONSTRAINT appointments_cancellation_scope_check
    CHECK (cancellation_scope IS NULL OR cancellation_scope IN ('INSTANCE', 'SERIES')),
  -- occurrence_index is meaningful only within a series; keep the two in lockstep so a
  -- one-time appointment can never masquerade as occurrence 0 of nothing.
  CONSTRAINT appointments_series_occurrence_check
    CHECK ((series_id IS NULL) = (occurrence_index IS NULL)),

  -- ======================================================================
  -- INVARIANT I1: a therapist cannot have two overlapping live appointments.
  --
  -- tstzrange(..., '[)') makes the interval half-open, so 10:00-11:00 and 11:00-12:00 do
  -- NOT collide and back-to-back sessions remain bookable. This matches TimeInterval in
  -- the application layer exactly.
  --
  -- The WHERE clause is what makes cancellation useful: a CANCELLED row stops
  -- participating in the constraint, so the freed slot is immediately rebookable while the
  -- cancelled record is retained for history.
  -- ======================================================================
  CONSTRAINT appointments_no_overlap EXCLUDE USING gist (
    therapist_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status <> 'CANCELLED'),

  -- Product decision beyond the stated requirements: a patient cannot be booked with two
  -- therapists at once either. The requirement only names the therapist-side conflict, but
  -- a patient being in two places simultaneously is obviously wrong and cheap to prevent
  -- here. Documented in docs/01-implementation-guide.md.
  CONSTRAINT appointments_patient_no_overlap EXCLUDE USING gist (
    patient_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status <> 'CANCELLED')
);

-- "My upcoming appointments", newest first, for both dashboards.
CREATE INDEX appointments_patient_start_idx   ON appointments (patient_id, start_time DESC);
CREATE INDEX appointments_therapist_start_idx ON appointments (therapist_id, start_time DESC);

-- Availability subtracts booked time for one therapist over a date window. A GiST index on
-- the range makes that an index scan rather than a scan of the therapist's whole history.
CREATE INDEX appointments_therapist_range_idx
  ON appointments USING gist (therapist_id, tstzrange(start_time, end_time, '[)'))
  WHERE status <> 'CANCELLED';

-- Series operations ("cancel all future instances") touch one series at a time.
CREATE INDEX appointments_series_idx ON appointments (series_id, start_time)
  WHERE series_id IS NOT NULL;

CREATE TRIGGER appointments_set_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- holds
--
-- A hold is a one-minute ownership claim on a slot, and expiry is authoritative in the
-- database (`expires_at`), never a setTimeout. A timer in a Node process is worthless here:
-- the task can be replaced mid-hold by a deployment, and the other two tasks would know
-- nothing about it. Availability therefore asks "is there a row with status = 'ACTIVE' and
-- expires_at > now()", which every task answers identically.
-- ---------------------------------------------------------------------------
CREATE TABLE holds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_id UUID        NOT NULL REFERENCES therapists (id) ON DELETE CASCADE,
  patient_id   UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  start_time   TIMESTAMPTZ NOT NULL,
  end_time     TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,

  status       TEXT        NOT NULL DEFAULT 'ACTIVE',

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at  TIMESTAMPTZ,
  released_at  TIMESTAMPTZ,

  CONSTRAINT holds_status_check
    CHECK (status IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'RELEASED')),
  CONSTRAINT holds_time_check CHECK (end_time > start_time),
  CONSTRAINT holds_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT holds_consumed_at_check CHECK ((status = 'CONSUMED') = (consumed_at IS NOT NULL)),
  CONSTRAINT holds_released_at_check CHECK ((status = 'RELEASED') = (released_at IS NOT NULL)),

  -- ======================================================================
  -- INVARIANT I2: at most one ACTIVE hold per therapist slot.
  --
  -- Note carefully what the predicate does NOT say: it cannot include
  -- `expires_at > now()`, because a partial index predicate must be IMMUTABLE and now()
  -- is not. Postgres would reject the constraint outright.
  --
  -- The consequence is deliberate and handled in the application: a hold that has expired
  -- but not yet been swept still occupies this constraint. So the hold-creation
  -- transaction first flips any overlapping expired row to 'EXPIRED' and only then
  -- inserts, which both reclaims the slot immediately and keeps the constraint truthful.
  -- The sweeper worker is the backstop for rows nobody tries to reclaim.
  -- ======================================================================
  CONSTRAINT holds_no_overlap EXCLUDE USING gist (
    therapist_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status = 'ACTIVE')
);

-- Serves both "what is this patient currently holding" (survives a page refresh) and the
-- per-patient active-hold cap.
CREATE INDEX holds_patient_active_idx ON holds (patient_id, expires_at)
  WHERE status = 'ACTIVE';

-- The sweeper's only query: active rows whose time has passed.
CREATE INDEX holds_expiry_sweep_idx ON holds (expires_at) WHERE status = 'ACTIVE';

CREATE INDEX holds_therapist_range_idx
  ON holds USING gist (therapist_id, tstzrange(start_time, end_time, '[)'))
  WHERE status = 'ACTIVE';

CREATE TRIGGER holds_set_updated_at
  BEFORE UPDATE ON holds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
