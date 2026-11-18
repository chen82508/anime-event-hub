import { sql } from 'drizzle-orm';
import { createDb, type DbHandle } from '../src/client';
import { loadRootEnv } from '../src/env';

loadRootEnv();

/** 整合測試用 DB URL；未設定時整合測試會被略過（並在輸出中註明）。 */
export const TEST_DB_URL = process.env.DATABASE_URL_TEST;

/**
 * 連到測試 DB，並清空成全新狀態（drop schema）。
 * 安全閥：DB 名稱必須以 _test 結尾，且不得等於 DATABASE_URL。
 */
export async function freshTestDb(): Promise<DbHandle> {
  if (!TEST_DB_URL) throw new Error('DATABASE_URL_TEST 未設定');
  const dbName = new URL(TEST_DB_URL).pathname.slice(1);
  if (!dbName.endsWith('_test') || TEST_DB_URL === process.env.DATABASE_URL) {
    throw new Error(`拒絕清空非測試資料庫：${dbName}`);
  }
  const handle = createDb(TEST_DB_URL, { max: 2 });
  try {
    await handle.db.execute(sql`select 1`);
  } catch (err) {
    await handle.close();
    throw new Error(`無法連線測試 DB（是否已 \`pnpm db:up\`？）：${(err as Error).message}`, {
      cause: err,
    });
  }
  await handle.db.execute(sql`drop schema if exists drizzle cascade`);
  await handle.db.execute(sql`drop schema public cascade`);
  await handle.db.execute(sql`create schema public`);
  return handle;
}
