import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { typeOrmOptions } from './database.js';
import { HealthController } from './health/health.controller.js';
import { TransactionsModule } from './transactions/transactions.module.js';

@Module({
  imports: [TypeOrmModule.forRoot(typeOrmOptions()), TransactionsModule],
  controllers: [HealthController],
})
export class AppModule {}
