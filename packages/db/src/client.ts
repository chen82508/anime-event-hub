import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  /** 底層 postgres.js client；用完務必 `close()` */
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  /** 連線池大小（預設 5） */
  max?: number;
  /**
   * 是否允許具名 prepared statement（預設 true）。
   * drizzle 一般查詢本來就以未具名 statement 送出，只有 `.prepare(name)` 會要求具名；
   * 經 PgBouncer 等 transaction 模式的 pooler 連線時（如 Neon 的 `-pooler` 連線字串、
   * serverless 部署），具名 statement 可能落到另一條後端連線而失敗，設為 false 可全面停用。
   */
  prepare?: boolean;
}

export function createDb(url: string, opts: CreateDbOptions = {}): DbHandle {
  const client = postgres(url, {
    max: opts.max ?? 5,
    prepare: opts.prepare ?? true,
    // 只在開發時顯示 NOTICE 太吵（如 CREATE EXTENSION IF NOT EXISTS）
    onnotice: () => {},
  });
  const db = drizzle(client, { schema, casing: 'snake_case' });
  return { db, close: () => client.end({ timeout: 5 }) };
}

/**
 * 解析環境變數 `DATABASE_PREPARE`：未設定／空字串／`true` → true；`false` → false；其它值拋錯。
 * 呼叫端負責讀取環境變數（本套件不在 import 時讀取環境）。
 */
export function parseDatabasePrepare(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase() ?? '';
  if (v === '' || v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`DATABASE_PREPARE 只能是 true 或 false：${raw}`);
}
