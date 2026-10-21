import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionProcessor } from './transaction-processor.service.js';
import { Transaction } from './transaction.entity.js';
import { TransactionsController } from './transactions.controller.js';
import { TransactionsService } from './transactions.service.js';
import { WebhooksController } from './webhooks.controller.js';

/**
 * Everything about transactions in one feature module:
 * - WebhooksController     receives webhooks (write path)
 * - TransactionsController  query endpoints (read path)
 * - TransactionsService    idempotent ingest + queries
 * - TransactionProcessor   background worker
 */
@Module({
  // Registers Repository<Transaction> for injection in this module.
  imports: [TypeOrmModule.forFeature([Transaction])],
  controllers: [WebhooksController, TransactionsController],
  providers: [TransactionsService, TransactionProcessor],
})
export class TransactionsModule {}
