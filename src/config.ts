const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const float = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined || value === '' ? fallback : ['1', 'true', 'yes'].includes(value.toLowerCase());

export type DbType = 'mysql' | 'postgres';

/**
 * All runtime configuration comes from environment variables (see .env.example).
 * `dotenv/config` is imported first in main.ts so these are populated before this module loads.
 */
export const config = {
  port: int(process.env.PORT, 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',

  db: {
    type: (process.env.DB_TYPE === 'postgres' ? 'postgres' : 'mysql') as DbType,
    // A full connection string wins over the individual fields (Supabase gives you one).
    url: process.env.DATABASE_URL || undefined,
    host: process.env.DB_HOST ?? 'localhost',
    port: int(process.env.DB_PORT, process.env.DB_TYPE === 'postgres' ? 5432 : 3306),
    username: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'txn_webhooks',
    ssl: bool(process.env.DB_SSL, false),
    // Auto-create/alter the schema from the entity. Fine for this assignment; use migrations in a real system.
    synchronize: bool(process.env.DB_SYNC, true),
  },

  webhook: {
    // If the DB insert takes longer than this we answer 503 so the sender retries,
    // keeping the endpoint well inside its 500ms budget.
    persistTimeoutMs: int(process.env.WEBHOOK_PERSIST_TIMEOUT_MS, 400),
  },

  processing: {
    delayMs: int(process.env.PROCESSING_DELAY_MS, 30_000),
    pollIntervalMs: int(process.env.WORKER_POLL_INTERVAL_MS, 1_000),
    // How long a worker owns a claimed transaction. Must exceed delayMs; if the worker dies,
    // the lease expires and the transaction is picked up again.
    leaseMs: int(process.env.WORKER_LEASE_MS, 120_000),
    maxConcurrent: int(process.env.WORKER_MAX_CONCURRENT, 100),
    maxAttempts: int(process.env.WORKER_MAX_ATTEMPTS, 5),
    // 0..1 – chance the simulated external call fails, to demo retries. Keep 0 for the real test.
    simulatedFailureRate: float(process.env.SIMULATED_FAILURE_RATE, 0),
  },
};
