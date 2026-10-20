import { Logger } from '@nestjs/common';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { config } from './config.js';
import { Transaction } from './transactions/transaction.entity.js';

export function typeOrmOptions(): TypeOrmModuleOptions {
  const db = config.db;
  const connection = db.url
    ? { url: db.url }
    : { host: db.host, port: db.port, username: db.username, password: db.password, database: db.database };
  const common = { entities: [Transaction], synchronize: db.synchronize, logging: false as const };

  if (db.type === 'postgres') {
    return {
      type: 'postgres',
      ...connection,
      ...common,
      ssl: db.ssl ? { rejectUnauthorized: false } : false,
      extra: { max: 10 },
    };
  }

  return {
    type: 'mysql',
    ...connection,
    ...common,
    timezone: 'Z',
    ssl: db.ssl ? { rejectUnauthorized: false } : undefined,
    extra: { connectionLimit: 10 },
  };
}

/** Local-dev convenience: create the MySQL database if it doesn't exist yet. */
export async function ensureMysqlDatabase(): Promise<void> {
  const db = config.db;
  if (db.type !== 'mysql' || db.url) return;

  const mysql = await import('mysql2/promise');
  try {
    const conn = await mysql.createConnection({
      host: db.host,
      port: db.port,
      user: db.username,
      password: db.password,
    });
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${db.database.replace(/`/g, '``')}\``);
    await conn.end();
  } catch (err) {
    // TypeORM will surface a clearer error (and keep retrying) if the database really is unreachable.
    new Logger('Database').warn(`Could not ensure database exists: ${(err as Error).message}`);
  }
}
