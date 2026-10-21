/**
 * Central runtime configuration.
 *
 * WHAT: every setting the service needs (port, database, worker timings) is read here, once.
 * WHY:  settings come from environment variables so the same build runs locally, on EC2 or in a
 *       container without code changes (12-factor style). Secrets such as DB passwords therefore
 *       never live in the code or in git, only in the untracked `.env` file / server environment.
 *
 * `dotenv/config` is imported first in main.ts, so values from `.env` are already in
 * `process.env` when this module is evaluated.
 *
 * Invalid values throw at startup ("fail fast") instead of causing confusing behaviour later,
 * e.g. a typo like PROCESSING_DELAY_MS=30s would otherwise silently fall back to a default.
 */

export type DbType = 'mysql' | 'postgres';

/** Reads a string variable; empty strings count as "not set". */
function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/** Reads an integer variable, or throws if it is set but not a whole number. */
function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Config error: ${name} must be an integer, got "${raw}"`);
  }
  return value;
}

/** Reads a decimal number variable, or throws if it is set but not numeric. */
function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Config error: ${name} must be a number, got "${raw}"`);
  }
  return value;
}

/** Reads a boolean variable. Accepts true/false, 1/0, yes/no (case-insensitive). */
function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  throw new Error(`Config error: ${name} must be true or false, got "${raw}"`);
}

/** Only the two databases the code is tested against are allowed. */
function readDbType(): DbType {
  const value = readString('DB_TYPE', 'mysql').toLowerCase();
  if (value !== 'mysql' && value !== 'postgres') {
    throw new Error(`Config error: DB_TYPE must be "mysql" or "postgres", got "${value}"`);
  }
  return value;
}

const dbType = readDbType();

export const config = {
  /** HTTP port the API listens on. */
  port: readInt('PORT', 3000),
  /** Allowed browser origins for CORS: "*" for any, or a comma-separated list of URLs. */
  corsOrigin: readString('CORS_ORIGIN', '*'),

  db: {
    type: dbType,
    // A full connection string (what Supabase gives you) wins over the individual fields.
    url: readString('DATABASE_URL', '') || undefined,
    host: readString('DB_HOST', 'localhost'),
    port: readInt('DB_PORT', dbType === 'postgres' ? 5432 : 3306),
    username: readString('DB_USER', 'root'),
    password: process.env.DB_PASSWORD ?? '', // not trimmed: a password may legitimately contain spaces
    database: readString('DB_NAME', 'txn_webhooks'),
    /** Hosted databases (Supabase, RDS) require TLS; a local MySQL usually does not. */
    ssl: readBool('DB_SSL', false),
    /**
     * Create/alter tables from the entity on startup. Convenient for this assignment;
     * a production system would use versioned migrations instead.
     */
    synchronize: readBool('DB_SYNC', true),
  },

  webhook: {
    /**
     * Upper bound for storing an incoming webhook. If the DB is slower than this we answer 503
     * so the sender retries, which keeps the endpoint inside its 500ms response budget.
     */
    persistTimeoutMs: readInt('WEBHOOK_PERSIST_TIMEOUT_MS', 400),
  },

  processing: {
    /** Simulated duration of the external call made for every transaction (spec: 30 seconds). */
    delayMs: readInt('PROCESSING_DELAY_MS', 30_000),
    /** How often the worker looks for new work. */
    pollIntervalMs: readInt('WORKER_POLL_INTERVAL_MS', 1_000),
    /**
     * How long a worker "owns" a claimed transaction. Must be longer than delayMs; if the
     * worker crashes, the lease expires and another worker (or the restarted one) retries it.
     */
    leaseMs: readInt('WORKER_LEASE_MS', 120_000),
    /** Maximum transactions processed at the same time by one instance. */
    maxConcurrent: readInt('WORKER_MAX_CONCURRENT', 100),
    /** After this many failed attempts a transaction is marked FAILED instead of retried. */
    maxAttempts: readInt('WORKER_MAX_ATTEMPTS', 5),
    /** 0..1 chance that the simulated external call fails. Only for demoing retries; keep 0. */
    simulatedFailureRate: readNumber('SIMULATED_FAILURE_RATE', 0),
  },
} as const;

/** Cross-field checks that a single parser cannot express. */
function validate(): void {
  const p = config.processing;
  if (p.leaseMs <= p.delayMs) {
    throw new Error(
      `Config error: WORKER_LEASE_MS (${p.leaseMs}) must be greater than PROCESSING_DELAY_MS (${p.delayMs}), ` +
        'otherwise a lease could expire while the transaction is still being processed.',
    );
  }
  if (p.simulatedFailureRate < 0 || p.simulatedFailureRate > 1) {
    throw new Error('Config error: SIMULATED_FAILURE_RATE must be between 0 and 1');
  }
  if (p.maxAttempts < 1 || p.maxConcurrent < 1 || p.pollIntervalMs < 1) {
    throw new Error(
      'Config error: WORKER_MAX_ATTEMPTS, WORKER_MAX_CONCURRENT and WORKER_POLL_INTERVAL_MS must be at least 1',
    );
  }
}

validate();
