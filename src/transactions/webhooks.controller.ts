import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { TransactionWebhookDto } from './dto/transaction-webhook.dto.js';
import { TransactionsService } from './transactions.service.js';

/** Body returned to the payment processor. The spec allows an empty body; this one helps debugging. */
export interface WebhookAck {
  acknowledged: true;
  transaction_id: string;
  /** True when this transaction_id was already received earlier (nothing new was stored). */
  duplicate: boolean;
}

/**
 * Entry point for payment-processor webhooks.
 *
 * Kept deliberately thin: validate (done by the global ValidationPipe), store, respond.
 * The 30s processing never runs inside this request, which is how the endpoint answers
 * in milliseconds regardless of processing complexity.
 */
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(private readonly transactions: TransactionsService) {}

  /**
   * POST /v1/webhooks/transactions
   *
   * Always 202 Accepted ("received, will be processed") for both new and duplicate webhooks,
   * because a non-2xx answer makes processors keep retrying. Errors:
   *   400 – invalid body, 503 – could not store it right now (safe to retry).
   */
  @Post('transactions')
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(@Body() dto: TransactionWebhookDto): Promise<WebhookAck> {
    const { duplicate } = await this.transactions.ingest(dto);
    return { acknowledged: true, transaction_id: dto.transaction_id, duplicate };
  }
}
