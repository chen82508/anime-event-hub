import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const rootEnv = resolve(REPO_ROOT, '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  CRAWL_USER_AGENT: z.string().min(1),
  CRAWL_MIN_INTERVAL_MS: z.coerce.number().int().min(3000, '規格要求同 host 間隔 >= 3000ms'),
  SNAPSHOT_DIR: z.string().default('./var/snapshots'),
  SLACK_WEBHOOK_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(z.url().optional()),
  TZ: z.literal('Asia/Taipei'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema> & { SNAPSHOT_DIR_ABS: string };

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`環境變數設定錯誤（請參考 .env.example）：\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  return {
    ...env,
    // 相對路徑一律以 repo 根目錄為基準，避免因 pnpm --filter 改變 cwd 而寫錯位置
    SNAPSHOT_DIR_ABS: isAbsolute(env.SNAPSHOT_DIR)
      ? env.SNAPSHOT_DIR
      : resolve(REPO_ROOT, env.SNAPSHOT_DIR),
  };
}
