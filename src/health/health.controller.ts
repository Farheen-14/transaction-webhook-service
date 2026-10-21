import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DataSource } from 'typeorm';

/** How long the health check waits for the database before calling it DOWN. */
const DB_CHECK_TIMEOUT_MS = 1_000;

export interface HealthResponse {
  status: 'HEALTHY' | 'UNHEALTHY';
  current_time: string;
  /** Extra (not in the spec): shows whether the database answered. */
  database: 'UP' | 'DOWN';
}

/**
 * GET /  – health check.
 *
 * Returns `{ status: "HEALTHY", current_time }` as in the spec, plus a database check.
 * WHY check the DB: the service is useless if it cannot store webhooks, so "process is
 * running" alone would be a misleading health signal.
 * When the database is down the status is UNHEALTHY with HTTP 503, so load balancers and
 * uptime monitors that only look at the status code also notice the problem.
 */
@Controller()
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  async health(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const database = await this.checkDatabase();
    if (database === 'DOWN') res.status(HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: database === 'UP' ? 'HEALTHY' : 'UNHEALTHY',
      current_time: new Date().toISOString(),
      database,
    };
  }

  /** Runs `SELECT 1`, giving up after DB_CHECK_TIMEOUT_MS so the health check itself stays fast. */
  private async checkDatabase(): Promise<'UP' | 'DOWN'> {
    const timeout = new Promise<'DOWN'>((resolve) => setTimeout(() => resolve('DOWN'), DB_CHECK_TIMEOUT_MS).unref());
    const query = this.dataSource.query('SELECT 1').then(
      () => 'UP' as const,
      () => 'DOWN' as const,
    );
    return Promise.race([query, timeout]);
  }
}
