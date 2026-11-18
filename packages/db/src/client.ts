import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  /** 底層 postgres.js client；用完務必 `close()` */
  close: () => Promise<void>;
}

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const client = postgres(url, {
    max: opts.max ?? 5,
    // 只在開發時顯示 NOTICE 太吵（如 CREATE EXTENSION IF NOT EXISTS）
    onnotice: () => {},
  });
  const db = drizzle(client, { schema, casing: 'snake_case' });
  return { db, close: () => client.end({ timeout: 5 }) };
}
