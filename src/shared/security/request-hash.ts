import { createHash } from 'node:crypto';

/**
 * Canonical hash of a request body, used to detect an Idempotency-Key being replayed with
 * different content.
 *
 * Canonicalisation matters: `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same request, and a
 * naive `JSON.stringify` hash would call them different and reject a legitimate retry. So
 * object keys are sorted recursively before serialising. Array order is preserved, because
 * for a list of appointments the order genuinely is part of the meaning.
 */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    // A Date is data, not a structure to walk into.
    if (value instanceof Date) {
      return value.toISOString();
    }

    const entries = Object.entries(value as Record<string, unknown>)
      // `undefined` disappears through JSON transport anyway, so ignoring it here keeps the
      // hash stable between a field that was omitted and one that was sent as undefined.
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    return Object.fromEntries(entries.map(([key, entryValue]) => [key, canonicalize(entryValue)]));
  }

  return value;
};

export const hashRequestPayload = (payload: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(payload) ?? null))
    .digest('hex');
