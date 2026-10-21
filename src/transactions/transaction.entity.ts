import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ValueTransformer,
} from 'typeorm';
import { config } from '../config.js';

/**
 * Lifecycle of a transaction:
 *   PROCESSING -> PROCESSED        (normal path, ~30s after the webhook)
 *   PROCESSING -> FAILED           (only after WORKER_MAX_ATTEMPTS failed attempts)
 */
export enum TransactionStatus {
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

// Column types differ slightly between the two supported databases. Both store
// millisecond-precision timestamps in UTC, so `processed_at - created_at` is exact.
const isPostgres = config.db.type === 'postgres';
const timestampType = isPostgres ? 'timestamptz' : 'datetime';
// MySQL needs the precision repeated in the default, otherwise DATETIME(3) rejects it.
const nowDefault = () => (isPostgres ? 'CURRENT_TIMESTAMP' : 'CURRENT_TIMESTAMP(3)');

/**
 * Money is stored as DECIMAL (exact) rather than FLOAT (rounding errors). Database drivers
 * return DECIMAL as a string to avoid precision loss; we convert it to a number for the API.
 */
const decimalToNumber: ValueTransformer = {
  to: (value?: number) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/**
 * One row per unique transaction_id.
 *
 * The same table is also the worker's job queue: rows with status PROCESSING and an expired
 * (or empty) `locked_until` are waiting to be processed. Keeping the webhook and its job in one
 * row means they are written in a single INSERT and can never get out of sync.
 */
@Entity('transactions')
// Speeds up the worker's "find due rows" query (WHERE status = ? AND locked_until <= ?).
@Index('idx_transactions_due', ['status', 'lockedUntil'])
export class Transaction {
  /** Internal surrogate key; the public identifier is `transactionId`. */
  @PrimaryGeneratedColumn()
  id: number;

  /** Payment processor's ID. The UNIQUE index is what makes webhook ingestion idempotent. */
  @Index('uq_transactions_transaction_id', { unique: true })
  @Column({ name: 'transaction_id', type: 'varchar', length: 128 })
  transactionId: string;

  @Column({ name: 'source_account', type: 'varchar', length: 128 })
  sourceAccount: string;

  @Column({ name: 'destination_account', type: 'varchar', length: 128 })
  destinationAccount: string;

  /** Exact decimal with 2 fractional digits (e.g. 150.50). */
  @Column({ type: 'decimal', precision: 18, scale: 2, transformer: decimalToNumber })
  amount: number;

  /** ISO 4217 currency code, stored uppercase (e.g. "INR"). */
  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 16, default: TransactionStatus.PROCESSING })
  status: TransactionStatus;

  /** How many times a worker has started processing this row (1 on the normal path). */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** Message of the most recent failure, kept for debugging; null once processed. */
  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  /**
   * Worker lease. While this is in the future, one worker owns the row and others skip it.
   * If that worker dies, the time passes and the row becomes claimable again.
   */
  @Column({ name: 'locked_until', type: timestampType, precision: 3, nullable: true })
  lockedUntil: Date | null;

  /** When the webhook was received. */
  @CreateDateColumn({ name: 'created_at', type: timestampType, precision: 3, default: nowDefault })
  createdAt: Date;

  /** Last time any column changed (useful when debugging retries). */
  @UpdateDateColumn({
    name: 'updated_at',
    type: timestampType,
    precision: 3,
    default: nowDefault,
    onUpdate: isPostgres ? undefined : 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt: Date;

  /** When processing finished successfully; null while PROCESSING or FAILED. */
  @Column({ name: 'processed_at', type: timestampType, precision: 3, nullable: true })
  processedAt: Date | null;
}
