// 只在伺服器端（Server Component / Server Action）使用
import { createDb, parseDatabasePrepare, type Database } from '@aeh/db';

const globalForDb = globalThis as unknown as { aehDb?: Database };

/** dev 模式 HMR 會重新載入模組，以 globalThis 共用連線池 */
export function getDb(): Database {
  if (!globalForDb.aehDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL 未設定（請在 repo 根目錄 cp .env.example .env）');
    // Vercel 等 serverless 部署經 transaction pooler 連線時設 DATABASE_PREPARE=false
    const prepare = parseDatabasePrepare(process.env.DATABASE_PREPARE);
    globalForDb.aehDb = createDb(url, { max: 5, prepare }).db;
  }
  return globalForDb.aehDb;
}
