import 'dotenv/config'; // must be first: config.ts reads process.env at import time
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { config } from './config.js';
import { ensureMysqlDatabase } from './database.js';

async function bootstrap() {
  await ensureMysqlDatabase();

  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });
  // whitelist: ignore unknown fields (processors often add extras) instead of rejecting them
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');
  new Logger('Bootstrap').log(`Listening on port ${config.port} (db=${config.db.type})`);
}

void bootstrap();
