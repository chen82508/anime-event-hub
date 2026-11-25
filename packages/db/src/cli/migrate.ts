import { createDb, parseDatabasePrepare } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { runMigrations } from '../migrate';

loadRootEnv();
const { db, close } = createDb(requireEnv('DATABASE_URL'), {
  max: 1,
  prepare: parseDatabasePrepare(process.env.DATABASE_PREPARE),
});
try {
  await runMigrations(db);
  console.log('[db:migrate] 完成');
} catch (err) {
  console.error('[db:migrate] 失敗', err);
  process.exitCode = 1;
} finally {
  await close();
}
