export {
  claimIdempotencyKey,
  completeIdempotencyRecord,
  failIdempotencyRecord,
  purgeExpiredIdempotencyRecords,
  reopenIdempotencyRecord,
} from '@/shared/idempotency/idempotency-store.js';
export type { ClaimOutcome } from '@/shared/idempotency/idempotency-store.js';
export { withIdempotency } from '@/shared/idempotency/with-idempotency.js';
export type {
  IdempotentOperation,
  IdempotencyContext,
} from '@/shared/idempotency/with-idempotency.js';
