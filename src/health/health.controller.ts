import { Controller, Get } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller()
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  async health() {
    const database = await Promise.race([
      this.dataSource.query('SELECT 1').then(() => 'UP' as const),
      new Promise<'DOWN'>((resolve) => setTimeout(() => resolve('DOWN'), 1_000).unref()),
    ]).catch(() => 'DOWN' as const);

    return {
      status: database === 'UP' ? 'HEALTHY' : 'UNHEALTHY',
      current_time: new Date().toISOString(),
      database,
    };
  }
}
