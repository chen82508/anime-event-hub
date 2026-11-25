// @aeh/db — Drizzle schema、migrations、seed、repository
// 只允許 apps/* 與 pipeline 編排層使用（tech-spec §3）。
export * from './schema';
export {
  createDb,
  parseDatabasePrepare,
  type CreateDbOptions,
  type Database,
  type DbHandle,
} from './client';
export { runMigrations } from './migrate';
export * from './dictionaries';
export { DEFAULT_DICTIONARY_DIR, MIGRATIONS_DIR } from './env';
export * from './repositories';
