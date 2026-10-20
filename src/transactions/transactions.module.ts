import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Transaction } from './transaction.entity.js';
import { TransactionProcessor } from './transaction-processor.service.js';
import { TransactionsController, WebhooksController } from './transactions.controller.js';
import { TransactionsService } from './transactions.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction])],
  controllers: [WebhooksController, TransactionsController],
  providers: [TransactionsService, TransactionProcessor],
})
export class TransactionsModule {}
