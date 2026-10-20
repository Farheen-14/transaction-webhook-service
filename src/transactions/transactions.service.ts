import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { config } from '../config.js';
import { TransactionWebhookDto } from './dto/transaction-webhook.dto.js';
import { Transaction, TransactionStatus } from './transaction.entity.js';
import { TransactionProcessor } from './transaction-processor.service.js';

export interface TransactionView {
  transaction_id: string;
  source_account: string;
  destination_account: string;
  amount: number;
  currency: string;
  status: TransactionStatus;
  created_at: string;
  processed_at: string | null;
  attempts: number;
  last_error: string | null;
}

const isUniqueViolation = (err: unknown): boolean => {
  if (!(err instanceof QueryFailedError)) return false;
  const code = (err.driverError as { code?: string } | undefined)?.code;
  return code === 'ER_DUP_ENTRY' /* MySQL */ || code === '23505' /* Postgres */;
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (err) => (clearTimeout(timer), reject(err)),
    );
  });

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @InjectRepository(Transaction) private readonly repo: Repository<Transaction>,
    private readonly processor: TransactionProcessor,
  ) {}

  /**
   * Durably records the webhook and returns immediately; processing happens in the background.
   * Idempotent: a repeated transaction_id hits the UNIQUE constraint and is reported as a duplicate.
   */
  async ingest(dto: TransactionWebhookDto): Promise<{ duplicate: boolean }> {
    try {
      await withTimeout(
        this.repo.insert({
          transactionId: dto.transaction_id,
          sourceAccount: dto.source_account,
          destinationAccount: dto.destination_account,
          amount: dto.amount,
          currency: dto.currency,
          status: TransactionStatus.PROCESSING,
        }),
        config.webhook.persistTimeoutMs,
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.logger.log(`Duplicate webhook ignored: ${dto.transaction_id}`);
        return { duplicate: true };
      }
      // We never acknowledge what we haven't stored: a 503 makes the processor retry,
      // and the retry is safe because ingestion is idempotent.
      this.logger.error(`Could not persist ${dto.transaction_id}: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Could not record webhook, please retry');
    }

    this.processor.wake();
    return { duplicate: false };
  }

  async findByTransactionId(transactionId: string): Promise<TransactionView[]> {
    const tx = await this.repo.findOne({ where: { transactionId } });
    return tx ? [toView(tx)] : [];
  }

  async listRecent(limit: number): Promise<TransactionView[]> {
    const rows = await this.repo.find({ order: { createdAt: 'DESC', id: 'DESC' }, take: limit });
    return rows.map(toView);
  }
}

function toView(tx: Transaction): TransactionView {
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
