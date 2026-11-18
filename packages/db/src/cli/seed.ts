import { createDb } from '../client';
import { loadDictionaries, seedDictionaries, type Dictionaries } from '../dictionaries';
import { DEFAULT_DICTIONARY_DIR, loadRootEnv, requireEnv } from '../env';

loadRootEnv();
const dir = process.env.DICTIONARY_DIR ?? DEFAULT_DICTIONARY_DIR;

// 先驗證全部字典；任何錯誤都在碰 DB 之前中止（T3 DoD）
let dicts: Dictionaries;
try {
  dicts = await loadDictionaries(dir);
} catch (err) {
  console.error(`[db:seed] 字典驗證失敗，未寫入任何資料\n${(err as Error).message}`);
  process.exit(1);
}

const { db, close } = createDb(requireEnv('DATABASE_URL'), { max: 1 });
try {
  const result = await seedDictionaries(db, dicts);
  console.log('[db:seed] 完成', result);
} catch (err) {
  console.error('[db:seed] 寫入失敗（transaction 已回滾）', err);
  process.exitCode = 1;
} finally {
  await close();
}
