// Must be the first import: config.ts reads process.env when it is loaded, so `.env` has to be
// applied before anything imports it.
import 'dotenv/config';
// Required by TypeORM and Nest's dependency injection to read decorator type metadata.
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { serverTiming } from './common/server-timing.middleware.js';
import { config } from './config.js';
import { ensureMysqlDatabase } from './database.js';

/** Creates, configures and starts the HTTP server. */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // Local convenience: create the MySQL database before TypeORM tries to connect to it.
  await ensureMysqlDatabase();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Don't advertise the framework in responses ("X-Powered-By: Express"); it only helps attackers.
  app.disable('x-powered-by');

  // Registered first so the measured time covers all later middleware and the handler.
  app.use(serverTiming);

  // The React dashboard runs on a different origin, so the browser needs CORS headers.
  // `exposedHeaders` lets the dashboard's JavaScript read Server-Timing (browsers hide
  // response headers from cross-origin scripts unless the server allows it).
  app.enableCors({
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((o) => o.trim()),
    exposedHeaders: ['Server-Timing'],
  });

  // Validates every request body against its DTO:
  //  - whitelist: strip unknown fields instead of rejecting them (processors often add extras)
  //  - transform: apply the DTO's @Transform rules (trim, uppercase currency)
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Run onApplicationShutdown hooks on SIGTERM/SIGINT so the worker can hand back its leases.
  app.enableShutdownHooks();

  // 0.0.0.0 so the API is reachable from outside the machine/container, not only from localhost.
  await app.listen(config.port, '0.0.0.0');

  // Keep idle connections open longer than CloudFront does (its origin keep-alive is up to
  // 60s). With Node's default of 5s the server closes connections CloudFront wants to reuse,
  // so many requests would pay for a new TCP connection all the way to Sydney.
  // headersTimeout must be larger than keepAliveTimeout.
  const server = app.getHttpServer();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  logger.log(`Listening on port ${config.port} (db=${config.db.type})`);
}

bootstrap().catch((err: unknown) => {
  // Configuration errors and the like: print them clearly and exit with a failure code,
  // so the process manager (pm2/systemd) reports a crash instead of a silent hang.
  new Logger('Bootstrap').error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
