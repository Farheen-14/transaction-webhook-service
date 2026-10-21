import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { typeOrmOptions } from './database.js';
import { HealthController } from './health/health.controller.js';
import { TransactionsModule } from './transactions/transactions.module.js';

/**
 * Root module: opens the database connection (shared by every module) and wires the features.
 * TypeORM retries the connection automatically if the database is not up yet at boot.
 */
@Module({
  imports: [TypeOrmModule.forRoot(typeOrmOptions()), TransactionsModule],
  controllers: [HealthController],
})
export class AppModule {}
