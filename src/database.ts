import { Logger } from '@nestjs/common';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { errorMessage } from './common/async.utils.js';
import { config } from './config.js';
import { Transaction } from './transactions/transaction.entity.js';

/**
 * Builds the TypeORM connection options for the database selected by DB_TYPE.
 *
 * WHY two databases: MySQL is used locally and on the EC2 server; Postgres is used when the
 * service points at Supabase. The application code is identical for both; only these options
 * differ.
 */
export function typeOrmOptions(): TypeOrmModuleOptions {
  const db = config.db;

  // A connection string (e.g. Supabase's "Session pooler" URI) wins over individual fields.
  const connection = db.url
    ? { url: db.url }
    : { host: db.host, port: db.port, username: db.username, password: db.password, database: db.database };

  const common = {
    entities: [Transaction],
    synchronize: db.synchronize,
    logging: false as const, // SQL logging is noisy; enable temporarily when debugging queries
  };

  if (db.type === 'postgres') {
    return {
      type: 'postgres',
      ...connection,
      ...common,
      // Supabase requires TLS. Its pooler certificate is not in Node's default CA bundle,
      // so certificate verification is relaxed while the connection itself stays encrypted.
      ssl: db.ssl ? { rejectUnauthorized: false } : false,
      extra: { max: 10 }, // connection pool size
    };
  }

  return {
    type: 'mysql',
    ...connection,
    ...common,
    // Store and read DATETIME values as UTC so timestamps never shift with the server's timezone.
    timezone: 'Z',
    ssl: db.ssl ? { rejectUnauthorized: false } : undefined,
    extra: { connectionLimit: 10 }, // connection pool size
  };
}

/**
 * Local-development convenience: creates the MySQL database if it does not exist yet, so a
 * fresh machine only needs a running MySQL server and the right credentials in `.env`.
 *
 * Skipped for Postgres and for connection strings, where the database is provisioned by the host.
 * Failures are only logged: TypeORM reports a clearer error (and keeps retrying) if the
 * database is genuinely unreachable.
 */
export async function ensureMysqlDatabase(): Promise<void> {
  const db = config.db;
  if (db.type !== 'mysql' || db.url) return;

  // Imported lazily so the Postgres setup never loads the MySQL driver.
  const mysql = await import('mysql2/promise');
  try {
    const conn = await mysql.createConnection({
      host: db.host,
      port: db.port,
      user: db.username,
      password: db.password,
    });
    // Backticks are escaped so an unusual DB_NAME cannot break out of the identifier.
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${db.database.replace(/`/g, '``')}\``);
    await conn.end();
  } catch (err) {
    new Logger('Database').warn(`Could not ensure database exists: ${errorMessage(err)}`);
  }
}
