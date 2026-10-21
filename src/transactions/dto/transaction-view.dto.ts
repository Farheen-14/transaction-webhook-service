import { Transaction, TransactionStatus } from '../transaction.entity.js';

/**
 * Public JSON shape of a transaction returned by the query endpoints.
 *
 * WHY a separate type instead of returning the entity: the API contract (snake_case names,
 * ISO date strings) stays stable even if the table changes, and internal columns such as
 * `id` or `locked_until` are never exposed.
 */
export interface TransactionView {
  transaction_id: string;
  source_account: string;
  destination_account: string;
  amount: number;
  currency: string;
  status: TransactionStatus;
  /** ISO-8601 UTC, e.g. "2024-01-15T10:30:00.000Z". */
  created_at: string;
  /** ISO-8601 UTC, or null while the transaction is still processing. */
  processed_at: string | null;
  /** Extra (not in the spec): helps when testing retries. */
  attempts: number;
  /** Extra (not in the spec): reason of the last failed attempt, if any. */
  last_error: string | null;
}

/** Maps a database row to its public JSON representation. */
export function toTransactionView(tx: Transaction): TransactionView {
  return {
    transaction_id: tx.transactionId,
    source_account: tx.sourceAccount,
    destination_account: tx.destinationAccount,
    amount: tx.amount,
    currency: tx.currency,
    status: tx.status,
    created_at: tx.createdAt.toISOString(),
    processed_at: tx.processedAt ? tx.processedAt.toISOString() : null,
    attempts: tx.attempts,
    last_error: tx.lastError,
  };
}
