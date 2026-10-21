import type { NextFunction, Request, Response } from 'express';

/**
 * Adds a `Server-Timing: app;dur=<ms>` header to every response.
 *
 * WHAT: the time between the request reaching this process and the response headers being
 *       written, i.e. the work done by the API itself (validation, DB insert, ...).
 * WHY:  callers far away from the server (e.g. India -> Sydney) see much larger end-to-end
 *       times because of network distance. This header shows how much of that is the server,
 *       so latency can be attributed correctly. Browsers display it in DevTools (Network tab ->
 *       Timing), and the dashboard shows it next to each webhook response.
 *
 * The header must be set before the headers are sent, so the measurement is taken in a
 * wrapper around `res.writeHead`, which every response passes through.
 */
export function serverTiming(_req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  const originalWriteHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;

  (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead = (...args: unknown[]) => {
    const ms = Number(process.hrtime.bigint() - started) / 1_000_000;
    res.setHeader('Server-Timing', `app;dur=${ms.toFixed(1)};desc="API processing"`);
    return originalWriteHead(...args);
  };

  next();
}
