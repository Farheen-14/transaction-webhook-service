import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, Or, Repository } from 'typeorm';
import { config } from '../config.js';
import { Transaction, TransactionStatus } from './transaction.entity.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Background worker that uses the transactions table itself as a durable job queue.
 *
 * - Every PROCESSING row with an expired (or no) lease is "due".
 * - A worker claims a row with a conditional UPDATE; only one claimer can win, so this is safe
 *   across multiple app instances.
 * - If the process crashes mid-way, the lease simply expires and the row is picked up again,
 *   so no transaction is lost.
 * - The final write is conditional on status = PROCESSING, so a transaction is marked
 *   PROCESSED exactly once.
 */
@Injectable()
export class TransactionProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TransactionProcessor.name);
  private readonly cfg = config.processing;
  private readonly inFlight = new Set<number>();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopping = false;

  constructor(@InjectRepository(Transaction) private readonly repo: Repository<Transaction>) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.wake(), this.cfg.pollIntervalMs);
    this.wake(); // also resumes anything left unfinished by a previous run
    this.logger.log(
      `Worker started (delay=${this.cfg.delayMs}ms, poll=${this.cfg.pollIntervalMs}ms, lease=${this.cfg.leaseMs}ms)`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    if (this.inFlight.size === 0) return;
    // Hand unfinished work back right away instead of waiting for the lease to expire.
    await this.repo
      .update({ id: In([...this.inFlight]), status: TransactionStatus.PROCESSING }, { lockedUntil: null })
      .catch((err: Error) => this.logger.warn(`Could not release leases on shutdown: ${err.message}`));
  }

  /** Look for due transactions now. Safe to call often; overlapping calls are coalesced. */
  wake(): void {
    if (this.polling || this.stopping) return;
    this.polling = true;
    this.claimDue()
      .catch((err: Error) => this.logger.error(`Polling failed: ${err.message}`))
      .finally(() => (this.polling = false));
  }

  private async claimDue(): Promise<void> {
    const capacity = this.cfg.maxConcurrent - this.inFlight.size;
    if (capacity <= 0) return;

    const now = new Date();
    const due = await this.repo.find({
      select: { id: true, transactionId: true, attempts: true },
      where: { status: TransactionStatus.PROCESSING, lockedUntil: Or(IsNull(), LessThanOrEqual(now)) },
      order: { createdAt: 'ASC' },
      take: capacity,
    });

    for (const tx of due) {
      if (this.inFlight.has(tx.id) || this.stopping) continue;

      const claim = await this.repo.update(
        { id: tx.id, status: TransactionStatus.PROCESSING, lockedUntil: Or(IsNull(), LessThanOrEqual(now)) },
        { lockedUntil: new Date(Date.now() + this.cfg.leaseMs), attempts: () => 'attempts + 1' },
      );
      if (!claim.affected) continue; // another worker got it first

      this.inFlight.add(tx.id);
      void this.process(tx.id, tx.transactionId, tx.attempts + 1).finally(() => this.inFlight.delete(tx.id));
    }
  }

  private async process(id: number, transactionId: string, attempt: number): Promise<void> {
    this.logger.log(`Processing ${transactionId} (attempt ${attempt})`);
    try {
      await this.callExternalApi(transactionId);
      if (this.stopping) return;

      const result = await this.repo.update(
        { id, status: TransactionStatus.PROCESSING },
        { status: TransactionStatus.PROCESSED, processedAt: new Date(), lockedUntil: null, lastError: null },
      );
      if (result.affected) this.logger.log(`Processed ${transactionId}`);
    } catch (err) {
      if (this.stopping) return;
      await this.handleFailure(id, transactionId, attempt, err as Error);
    }
  }

  private async handleFailure(id: number, transactionId: string, attempt: number, err: Error): Promise<void> {
    const lastError = err.message.slice(0, 500);
    const giveUp = attempt >= this.cfg.maxAttempts;
    const backoffMs = Math.min(5_000 * 2 ** (attempt - 1), 5 * 60_000);

    this.logger.warn(
      `Attempt ${attempt} for ${transactionId} failed: ${lastError}` +
        (giveUp ? ' — giving up' : ` — retrying in ${backoffMs / 1000}s`),
    );

    // If this update fails too (e.g. DB down), the lease expires and the row is retried anyway.
    await this.repo
      .update(
        { id, status: TransactionStatus.PROCESSING },
        giveUp
          ? { status: TransactionStatus.FAILED, lastError, lockedUntil: null }
          : { lastError, lockedUntil: new Date(Date.now() + backoffMs) },
      )
      .catch((e: Error) => this.logger.error(`Could not record failure for ${transactionId}: ${e.message}`));
  }

  /** Stand-in for the real downstream call (bank / ledger / fraud check). */
  private async callExternalApi(transactionId: string): Promise<void> {
    await sleep(this.cfg.delayMs);
    if (Math.random() < this.cfg.simulatedFailureRate) {
      throw new Error(`Simulated external API failure for ${transactionId}`);
    }
  }
}
