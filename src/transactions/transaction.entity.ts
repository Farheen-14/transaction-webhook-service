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

export enum TransactionStatus {
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

// Millisecond-precision timestamps stored in UTC on both databases.
const isPostgres = config.db.type === 'postgres';
const timestampType = isPostgres ? 'timestamptz' : 'datetime';
const nowDefault = () => (isPostgres ? 'CURRENT_TIMESTAMP' : 'CURRENT_TIMESTAMP(3)');

// DECIMAL columns come back from the drivers as strings.
const decimalToNumber: ValueTransformer = {
  to: (value?: number) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('transactions')
@Index('idx_transactions_due', ['status', 'lockedUntil'])
export class Transaction {
  @PrimaryGeneratedColumn()
  id: number;

  // The UNIQUE constraint is what makes webhook ingestion idempotent.
  @Index('uq_transactions_transaction_id', { unique: true })
  @Column({ name: 'transaction_id', type: 'varchar', length: 128 })
  transactionId: string;

  @Column({ name: 'source_account', type: 'varchar', length: 128 })
  sourceAccount: string;

  @Column({ name: 'destination_account', type: 'varchar', length: 128 })
  destinationAccount: string;

  @Column({ type: 'decimal', precision: 18, scale: 2, transformer: decimalToNumber })
  amount: number;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 16, default: TransactionStatus.PROCESSING })
  status: TransactionStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  // Worker lease: while in the future, one worker owns this transaction.
  @Column({ name: 'locked_until', type: timestampType, precision: 3, nullable: true })
  lockedUntil: Date | null;

  @CreateDateColumn({ name: 'created_at', type: timestampType, precision: 3, default: nowDefault })
  createdAt: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: timestampType,
    precision: 3,
    default: nowDefault,
    onUpdate: isPostgres ? undefined : 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt: Date;

  @Column({ name: 'processed_at', type: timestampType, precision: 3, nullable: true })
  processedAt: Date | null;
}
