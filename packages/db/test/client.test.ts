import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb, parseDatabasePrepare } from '../src/client';
import { TEST_DB_URL } from './helpers';

describe('parseDatabasePrepare', () => {
  it('未設定／空字串／true → true（預設維持具名 prepared statement）', () => {
    expect(parseDatabasePrepare(undefined)).toBe(true);
    expect(parseDatabasePrepare('')).toBe(true);
    expect(parseDatabasePrepare('  ')).toBe(true);
    expect(parseDatabasePrepare('true')).toBe(true);
    expect(parseDatabasePrepare('TRUE')).toBe(true);
  });

  it('false → false', () => {
    expect(parseDatabasePrepare('false')).toBe(false);
    expect(parseDatabasePrepare(' False ')).toBe(false);
  });

  it('其它值拋錯，不默默套用預設', () => {
    expect(() => parseDatabasePrepare('0')).toThrow(/DATABASE_PREPARE/);
    expect(() => parseDatabasePrepare('no')).toThrow(/DATABASE_PREPARE/);
  });
});

/**
 * drizzle 一般查詢本來就以未具名 statement 送出；只有 `.prepare(name)` 才要求具名。
 * 這裡用 `.prepare()` 驗證：client 層 prepare: false 時，即使程式呼叫 `.prepare()` 也不會
 * 在後端建立具名 statement（transaction pooler 下具名 statement 可能落到別條連線而失敗）。
 */
async function preparedCountAfterQuery(prepare: boolean): Promise<number> {
  const handle = createDb(TEST_DB_URL!, { max: 1, prepare });
  try {
    const q = handle.db
      .select({ n: sql<number>`t.n` })
      .from(sql`(select ${sql.placeholder('v')}::int as n) as t`)
      .prepare('client_test_q');
    for (let i = 0; i < 3; i++) await q.execute({ v: i });
    const rows = await handle.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_prepared_statements`,
    );
    return rows[0]!.n;
  } finally {
    await handle.close();
  }
}

describe.skipIf(!TEST_DB_URL)('createDb prepare 選項（需要測試 DB）', () => {
  it('prepare: false → 即使 .prepare() 也不建立具名 prepared statement（pooler 相容）', async () => {
    expect(await preparedCountAfterQuery(false)).toBe(0);
  });

  it('預設（prepare: true）＋ .prepare() → 會建立具名 prepared statement', async () => {
    expect(await preparedCountAfterQuery(true)).toBeGreaterThan(0);
  });
});
