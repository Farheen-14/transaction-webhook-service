import { Body, Controller, DefaultValuePipe, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { TransactionWebhookDto } from './dto/transaction-webhook.dto.js';
import { TransactionsService, TransactionView } from './transactions.service.js';

@Controller('v1/webhooks')
export class WebhooksController {
  constructor(private readonly transactions: TransactionsService) {}

  @Post('transactions')
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(@Body() dto: TransactionWebhookDto) {
    const { duplicate } = await this.transactions.ingest(dto);
    return {
      acknowledged: true,
      transaction_id: dto.transaction_id,
      duplicate,
    };
  }
}

@Controller('v1/transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  /** Not part of the spec — lets the dashboard show recent activity. */
  @Get()
  list(@Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number): Promise<TransactionView[]> {
    return this.transactions.listRecent(Math.min(Math.max(limit, 1), 200));
  }

  @Get(':transaction_id')
  findOne(@Param('transaction_id') transactionId: string): Promise<TransactionView[]> {
    return this.transactions.findByTransactionId(transactionId);
  }
}
