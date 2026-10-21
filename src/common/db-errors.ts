import { QueryFailedError } from 'typeorm';

/**
 * Error codes the database drivers use for "duplicate key" (UNIQUE constraint) violations.
 * We support both drivers because the service runs on MySQL locally / on EC2 and on
 * Postgres when pointed at Supabase.
 */
const UNIQUE_VIOLATION_CODES = new Set([
  'ER_DUP_ENTRY', // MySQL / MariaDB
  '23505', // PostgreSQL
]);

/**
 * True when `err` is a database error caused by inserting a row whose unique key already exists.
 *
 * WHY: idempotency is enforced by the UNIQUE constraint on `transaction_id`, so a duplicate
 * webhook shows up as exactly this error. Detecting it lets us treat the duplicate as
 * "already accepted" instead of failing the request.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const code = (err.driverError as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && UNIQUE_VIOLATION_CODES.has(code);
}
