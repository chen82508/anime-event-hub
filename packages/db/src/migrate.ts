import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './client';
import { MIGRATIONS_DIR } from './env';

/** 套用 packages/db/migrations 下尚未執行的 migration（可重複執行）。 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
