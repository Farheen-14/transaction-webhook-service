/**
 * Small promise helpers shared by the webhook ingest path and the background worker.
 */

/**
 * Waits for `ms` milliseconds.
 *
 * The timer is `unref()`-ed so a pending sleep never keeps the Node process alive on its own:
 * during shutdown the process can exit immediately, and the unfinished transaction is picked up
 * again later through its lease (see TransactionProcessor).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * Rejects if `promise` has not settled within `ms` milliseconds.
 *
 * Used to put a hard upper bound on how long the webhook endpoint waits for the database,
 * so a slow database turns into a fast 503 (sender retries) instead of a slow response.
 * Note: the original operation is not cancelled; if it still succeeds later, the sender's
 * retry is recognised as a duplicate, which is safe because ingestion is idempotent.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Turns any thrown value into a readable message for logs and the `last_error` column. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
