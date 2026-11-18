import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 以 path.join 組路徑（不用 `new URL('../x/', import.meta.url)`）：
// Next（Turbopack）會把後者當成要打包的資產而解析失敗。這些路徑只給 CLI/測試使用。
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(SRC_DIR, '..', '..', '..') + sep;
export const DEFAULT_DICTIONARY_DIR = join(REPO_ROOT, 'data', 'dictionaries') + sep;
export const MIGRATIONS_DIR = join(SRC_DIR, '..', 'migrations') + sep;

let loaded = false;
/** 讀取 repo 根目錄的 .env（若存在）。CLI 腳本使用；套件本身不在 import 時讀取環境。 */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = `${REPO_ROOT}.env`;
  if (existsSync(file)) process.loadEnvFile(file);
}

export function requireEnv(name: 'DATABASE_URL' | 'DATABASE_URL_TEST'): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} 未設定：請先 \`cp .env.example .env\``);
  return v;
}
