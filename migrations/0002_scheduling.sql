-- ===========================================================================
-- 0002_scheduling
--
-- Therapist recurring availability.
--
-- Availability is stored as a weekly pattern with an effective date range, never as
-- pre-generated future slots. Two reasons:
--   1. The assignment requires slots to be derived, not seeded.
--   2. Persisting every future slot for every therapist is unbounded storage growth for
--      data that is fully computable from a handful of rows.
--
-- Effective dating is what lets a therapist change next month's hours without touching a
-- single existing appointment: we close the old row (effective_until) and open a new one.
-- Historical availability therefore stays reconstructible, which matters when a patient
-- asks why they were able to book a slot that is no longer offered.
-- ===========================================================================

-- Postgres ships int4range/tstzrange/daterange but no range over TIME, and we need one to
-- express "these two weekly rules cover overlapping hours" as a declarative constraint
-- instead of a procedural trigger. Range types get GiST support automatically.
CREATE TYPE timerange AS RANGE (subtype = time);

CREATE TABLE therapist_schedules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_id    UUID        NOT NULL REFERENCES therapists (id) ON DELETE CASCADE,

  -- ISO-8601 day numbering (1 = Monday .. 7 = Sunday) to match Luxon's `weekday` and
  -- Postgres `extract(isodow)`, avoiding the classic off-by-one against JS getDay().
  day_of_week     SMALLINT    NOT NULL,

  -- Wall-clock times in the therapist's working timezone (APP_TIMEZONE). Stored as TIME
  -- because "Monday 09:00-17:00" is a rule, not an instant; it becomes a TIMESTAMPTZ only
  -- when expanded against a concrete date.
  start_time      TIME        NOT NULL,
  end_time        TIME        NOT NULL,

  effective_from  DATE        NOT NULL,
  -- NULL means "still in effect", which daterange interprets as an unbounded upper bound.
  effective_until DATE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT therapist_schedules_day_check   CHECK (day_of_week BETWEEN 1 AND 7),
  CONSTRAINT therapist_schedules_time_check  CHECK (end_time > start_time),
  CONSTRAINT therapist_schedules_range_check CHECK (effective_until IS NULL OR effective_until >= effective_from),

  -- Two rules for the same therapist and weekday may not cover overlapping hours during
  -- overlapping effective periods; otherwise slot expansion would emit duplicate slots.
  -- '[]' on the daterange makes effective_until inclusive ("effective through that day").
  CONSTRAINT therapist_schedules_no_overlap EXCLUDE USING gist (
    therapist_id WITH =,
    day_of_week WITH =,
    daterange(effective_from, effective_until, '[]') WITH &&,
    timerange(start_time, end_time, '[)') WITH &&
  )
);

-- The one query this table exists to serve: "give me therapist X's rules covering date
-- range Y". Postgres uses the leading columns for the equality lookup, then range-filters.
CREATE INDEX therapist_schedules_lookup_idx
  ON therapist_schedules (therapist_id, day_of_week, effective_from, effective_until);

CREATE TRIGGER therapist_schedules_set_updated_at
  BEFORE UPDATE ON therapist_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
