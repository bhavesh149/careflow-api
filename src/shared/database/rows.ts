/**
 * Row-value conversion for hand-written SQL.
 *
 * Drizzle installs its own type parsers on every query and returns `timestamp`, `timestamptz`,
 * `date` and `interval` columns as **raw Postgres strings**. When you go through its query
 * builder it maps them back to `Date` using the schema; a `sql`-template query has no schema to
 * map from, so the strings arrive untouched.
 *
 * This project writes raw SQL wherever correctness depends on it — `FOR UPDATE`, `SKIP LOCKED`,
 * CTEs, `ON CONFLICT`, exclusion constraints — so that behaviour is load-bearing, not incidental.
 * The rule that follows from it: a raw row type declares temporal columns as `string`, and
 * conversion is explicit through the helpers below. Typing them as `Date` and hoping would give
 * the compiler a false belief, and the failure mode is `x.toISOString is not a function` at
 * runtime — in a booking path, in production.
 *
 * `new Date(pgString)` happens to work in V8 today, because it accepts
 * `'2026-08-14 18:35:01.724+00'`. That is lenient, engine-specific behaviour outside the ECMAScript
 * grammar, so the value is normalised into real ISO-8601 first and rejected if it does not match
 * what Postgres actually emits.
 */

const PG_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * Converts a Postgres timestamp to a `Date`.
 *
 * Accepts a `Date` as well, so a value that came through Drizzle's query builder (already mapped)
 * passes through unchanged and callers do not have to care which path produced it.
 */
export const parseTimestamp = (value: string | Date): Date => {
  if (value instanceof Date) return value;

  const match = PG_TIMESTAMP.exec(value);

  if (!match) {
    throw new TypeError(`Not a Postgres timestamp: ${JSON.stringify(value)}`);
  }

  const [, date, time, offset] = match;

  // A `timestamptz` always carries an offset. A bare `timestamp` does not, and Postgres emits it
  // in UTC because the session timezone is UTC, so 'Z' is the correct interpretation here — the
  // schema stores instants as timestamptz precisely so this case stays theoretical.
  const normalisedOffset =
    offset === undefined || offset === 'Z'
      ? 'Z'
      : offset.length === 3
        ? `${offset}:00` // '+05' -> '+05:00'
        : offset.includes(':')
          ? offset
          : `${offset.slice(0, 3)}:${offset.slice(3)}`; // '+0530' -> '+05:30'

  const parsed = new Date(`${date}T${time}${normalisedOffset}`);

  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Unparseable Postgres timestamp: ${JSON.stringify(value)}`);
  }

  return parsed;
};

export const parseNullableTimestamp = (value: string | Date | null): Date | null =>
  value === null ? null : parseTimestamp(value);

/** Postgres `count(*)::text`, cast to text so a bigint cannot silently lose precision in JS. */
export const parseCount = (value: string | undefined): number => Number(value ?? '0');
