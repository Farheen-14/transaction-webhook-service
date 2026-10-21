import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, Or, Repository } from 'typeorm';
import { errorMessage, sleep } from '../common/async.utils.js';
import { config } from '../config.js';
import { Transaction, TransactionStatus } from './transaction.entity.js';

/** Longest wait between retries, so a long run of failures still retries every few minutes. */
const MAX_BACKOFF_MS = 5 * 60_000;
/** First retry waits this long; every further retry doubles it (5s, 10s, 20s, ...). */
const BASE_BACKOFF_MS = 5_000;

/**
 * Background worker that processes received transactions.
 *
 * WHY the database is the queue (no Redis/SQS): the webhook and its job are the same row,
 * written by one INSERT, so "stored but never queued" cannot happen, and there is one less
 * service to run. How it stays correct:
 *
 * - DUE:        a row is due when status = PROCESSING and its lease (`locked_until`) is empty
 *               or in the past.
 * - CLAIM:      a worker takes a row with a conditional UPDATE that only succeeds while the row
 *               is still due. Only one UPDATE can win, so even several app instances never
 *               process the same transaction at the same time.
 * - CRASH-SAFE: if the process dies mid-processing, nobody clears the lease; it simply expires
 *               and the row is claimed again. No transaction is lost.
 * - ONCE:       the final write only applies `WHERE status = PROCESSING`, so a transaction is
 *               marked PROCESSED exactly once.
 * - RETRIES:    failures are retried with exponential backoff, and marked FAILED after
 *               WORKER_MAX_ATTEMPTS.
 */
@Injectable()
export class TransactionProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TransactionProcessor.name);
  private readonly cfg = config.processing;
  /** IDs this instance is processing right now; used for the concurrency limit and shutdown. */
  private readonly inFlight = new Set<number>();
  private timer?: NodeJS.Timeout;
  /** Guards against two polls running at once when wake() is called while a poll is active. */
  private polling = false;
  private stopping = false;

  constructor(@InjectRepository(Transaction) private readonly repo: Repository<Transaction>) {}

  /** Starts polling once the app (and its DB connection) is ready. */
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.wake(), this.cfg.pollIntervalMs);
    // Poll immediately too: this also resumes work left unfinished by a previous run.
    this.wake();
    this.logger.log(
      `Worker started (delay=${this.cfg.delayMs}ms, poll=${this.cfg.pollIntervalMs}ms, lease=${this.cfg.leaseMs}ms)`,
    );
  }

  /**
   * Graceful shutdown (SIGTERM, e.g. during a deploy): stop taking new work and hand our
   * unfinished transactions back right away, instead of making them wait for the lease to expire.
   */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    if (this.inFlight.size === 0) return;
    try {
      await this.repo.update(
        { id: In([...this.inFlight]), status: TransactionStatus.PROCESSING },
        { lockedUntil: null },
      );
    } catch (err) {
      // Not fatal: the leases still expire on their own.
      this.logger.warn(`Could not release leases on shutdown: ${errorMessage(err)}`);
    }
  }

  /**
   * Looks for due transactions now. Called by the poll timer and right after a webhook is
   * stored. Safe to call often: overlapping calls are coalesced into one poll.
   */
  wake(): void {
    if (this.polling || this.stopping) return;
    this.polling = true;
    this.claimDue()
      .catch((err: unknown) => this.logger.error(`Polling failed: ${errorMessage(err)}`))
      .finally(() => (this.polling = false));
  }

  /** Finds due rows (oldest first), claims as many as we have capacity for, and starts them. */
  private async claimDue(): Promise<void> {
    const capacity = this.cfg.maxConcurrent - this.inFlight.size;
    if (capacity <= 0) return;

    const now = new Date();
    const isDue = { status: TransactionStatus.PROCESSING, lockedUntil: Or(IsNull(), LessThanOrEqual(now)) };

    const due = await this.repo.find({
      select: { id: true, transactionId: true, attempts: true },
      where: isDue,
      order: { createdAt: 'ASC' }, // first come, first served
      take: capacity,
    });

    for (const tx of due) {
      if (this.inFlight.has(tx.id) || this.stopping) continue;

      // Atomic claim: succeeds only if the row is still due. `affected = 0` means another
      // worker claimed it between our SELECT and this UPDATE, so we skip it.
      const claim = await this.repo.update(
        { id: tx.id, ...isDue },
        {
          lockedUntil: new Date(Date.now() + this.cfg.leaseMs),
          attempts: () => 'attempts + 1', // computed in SQL so concurrent updates cannot lose a count
        },
      );
      if (!claim.affected) continue;

      this.inFlight.add(tx.id);
      // Not awaited on purpose: transactions are processed concurrently, each in its own promise.
      void this.process(tx.id, tx.transactionId, tx.attempts + 1).finally(() => this.inFlight.delete(tx.id));
    }
  }

  /** Runs one attempt for one claimed transaction and records the outcome. */
  private async process(id: number, transactionId: string, attempt: number): Promise<void> {
    this.logger.log(`Processing ${transactionId} (attempt ${attempt})`);
    try {
      await this.callExternalApi(transactionId);
      if (this.stopping) return; // shutting down: leave the row for the next run

      // Conditional write: only a row still in PROCESSING becomes PROCESSED, so this can
      // never mark a transaction processed twice.
      const result = await this.repo.update(
        { id, status: TransactionStatus.PROCESSING },
        { status: TransactionStatus.PROCESSED, processedAt: new Date(), lockedUntil: null, lastError: null },
      );
      if (result.affected) this.logger.log(`Processed ${transactionId}`);
    } catch (err) {
      if (this.stopping) return;
      await this.handleFailure(id, transactionId, attempt, err);
    }
  }

  /** Schedules a retry with exponential backoff, or marks the transaction FAILED after the last attempt. */
  private async handleFailure(id: number, transactionId: string, attempt: number, err: unknown): Promise<void> {
    const lastError = errorMessage(err).slice(0, 500); // column limit
    const giveUp = attempt >= this.cfg.maxAttempts;
    const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);

    this.logger.warn(
      `Attempt ${attempt} for ${transactionId} failed: ${lastError}` +
        (giveUp ? ' — giving up' : ` — retrying in ${backoffMs / 1000}s`),
    );

    try {
      await this.repo.update(
        { id, status: TransactionStatus.PROCESSING },
        giveUp
          ? { status: TransactionStatus.FAILED, lastError, lockedUntil: null }
          : // Retry = push the lease into the future; the row becomes due again after the backoff.
            { lastError, lockedUntil: new Date(Date.now() + backoffMs) },
      );
    } catch (dbErr) {
      // Even if this fails (e.g. DB down), the lease expires and the row is retried anyway.
      this.logger.error(`Could not record failure for ${transactionId}: ${errorMessage(dbErr)}`);
    }
  }

  /**
   * Stand-in for the real downstream call (bank, ledger, fraud check), which the spec simulates
   * with a 30-second delay. A real implementation should send `transactionId` as an idempotency
   * key, because a crash between "call succeeded" and "row marked PROCESSED" causes a retry.
   */
  private async callExternalApi(transactionId: string): Promise<void> {
    await sleep(this.cfg.delayMs);
    if (Math.random() < this.cfg.simulatedFailureRate) {
      throw new Error(`Simulated external API failure for ${transactionId}`);
    }
  }
}
