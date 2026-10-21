import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { TransactionView } from './dto/transaction-view.dto.js';
import { TransactionsService } from './transactions.service.js';

/** Upper bound for `?limit=` so one request cannot ask for the whole table. */
const MAX_LIST_LIMIT = 200;

/** Read-only endpoints used for testing and by the dashboard. */
@Controller('v1/transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  /**
   * GET /v1/transactions?limit=50
   * Not part of the spec: lets the dashboard show recent activity. `limit` is clamped to 1..200.
   */
  @Get()
  list(@Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number): Promise<TransactionView[]> {
    return this.transactions.listRecent(Math.min(Math.max(limit, 1), MAX_LIST_LIMIT));
  }

  /**
   * GET /v1/transactions/:transaction_id
   * Returns `[transaction]`, or `[]` when the ID is unknown (array shape as in the spec).
   */
  @Get(':transaction_id')
  findOne(@Param('transaction_id') transactionId: string): Promise<TransactionView[]> {
    return this.transactions.findByTransactionId(transactionId);
  }
}
