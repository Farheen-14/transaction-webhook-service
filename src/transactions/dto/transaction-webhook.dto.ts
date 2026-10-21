import { Transform } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsPositive, IsString, Length, MaxLength } from 'class-validator';

/** Removes accidental leading/trailing spaces from string fields before validation. */
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Body of `POST /v1/webhooks/transactions`, as sent by the payment processor.
 *
 * Example:
 * {
 *   "transaction_id": "txn_abc123def456",
 *   "source_account": "acc_user_789",
 *   "destination_account": "acc_merchant_456",
 *   "amount": 1500,
 *   "currency": "INR"
 * }
 *
 * WHY validate: the payload is stored and processed later, so rejecting bad input up front
 * (400 Bad Request) is much cheaper than discovering it in the background worker.
 * Unknown extra fields are stripped, not rejected (see ValidationPipe in main.ts), because
 * real processors often add fields over time.
 * Field names are snake_case to match the processor's JSON exactly.
 */
export class TransactionWebhookDto {
  /** Processor's unique ID; also our idempotency key. Max length matches the DB column. */
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  transaction_id: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  source_account: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  destination_account: string;

  /** Positive amount with at most 2 decimals, matching the DECIMAL(18,2) column. */
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  /** 3-letter currency code; normalised to uppercase so "inr" and "INR" are stored the same. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @Length(3, 3)
  currency: string;
}
