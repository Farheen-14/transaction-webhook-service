import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { errorMessage, withTimeout } from '../common/async.utils.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { config } from '../config.js';
import { TransactionView, toTransactionView } from './dto/transaction-view.dto.js';
import { TransactionWebhookDto } from './dto/transaction-webhook.dto.js';
import { TransactionProcessor } from './transaction-processor.service.js';
import { Transaction, TransactionStatus } from './transaction.entity.js';

/** Result of ingesting a webhook: `duplicate` is true when the transaction_id was seen before. */
export interface IngestResult {
  duplicate: boolean;
}

/**
 * Business logic for receiving webhooks and reading transactions.
 *
 * Processing itself lives in TransactionProcessor; this service only records work and reads state,
 * which is what keeps the webhook endpoint fast.
 */
@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @InjectRepository(Transaction) private readonly repo: Repository<Transaction>,
    private readonly processor: TransactionProcessor,
  ) {}

  /**
   * Durably records a webhook and returns immediately; the 30s processing happens later.
   *
   * Steps:
   *  1. INSERT the row with status PROCESSING (a single fast query, bounded by a timeout).
   *  2. If the INSERT hits the UNIQUE constraint, this transaction_id was already received:
   *     report it as a duplicate instead of an error (idempotency).
   *  3. Any other failure becomes 503 so the processor retries. We never acknowledge a webhook
   *     we have not stored, otherwise a transaction could be lost.
   *  4. Nudge the worker so it starts right away instead of waiting for its next poll.
   */
  async ingest(dto: TransactionWebhookDto): Promise<IngestResult> {
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
      this.logger.error(`Could not persist ${dto.transaction_id}: ${errorMessage(err)}`);
      throw new ServiceUnavailableException('Could not record webhook, please retry');
    }

    this.processor.wake();
    return { duplicate: false };
  }

  /**
   * Looks up one transaction. Returns an array (as the spec's example response does):
   * one element when found, empty when the ID is unknown.
   */
  async findByTransactionId(transactionId: string): Promise<TransactionView[]> {
    const tx = await this.repo.findOne({ where: { transactionId } });
    return tx ? [toTransactionView(tx)] : [];
  }

  /** Most recent transactions first; used by the dashboard. */
  async listRecent(limit: number): Promise<TransactionView[]> {
    const rows = await this.repo.find({ order: { createdAt: 'DESC', id: 'DESC' }, take: limit });
    return rows.map(toTransactionView);
  }
}
