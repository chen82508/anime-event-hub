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
  /** console：告警只寫 log（本機/測試）；slack：送 webhook。未設定時有 webhook 用 slack，否則 console */
  ALERT_MODE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['console', 'slack']).optional(),
  ),
  /** 連續 N 次 0 筆告警（預設 3，T9） */
  ALERT_EMPTY_RUN_THRESHOLD: z.coerce.number().int().min(1).default(3),
  /** 同一告警的節流時間（分鐘） */
  ALERT_THROTTLE_MINUTES: z.coerce.number().int().min(1).default(360),
  /** 缺漏率較近期平均增加超過此比例即告警（0–1） */
  ALERT_MISSING_RATE_JUMP: z.coerce.number().min(0).max(1).default(0.3),
  /** KKTIX 搜尋關鍵字（逗號分隔）；留空用預設 */
  KKTIX_KEYWORDS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean)
        : undefined,
    ),
  /** KKTIX 規模門檻：場館不在字典時，票價上限需達此值；設為空字串則不看票價 */
  KKTIX_MIN_PRICE_MAX: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 1000 : v.trim() === '' ? null : Number(v)))
    .pipe(z.number().int().nonnegative().nullable()),
  /** KKTIX 規模門檻：場館不在字典時，命中作品/聲優/歌手標籤也算達門檻 */
  KKTIX_TAG_PASSES: z
    .enum(['true', 'false', ''])
    .optional()
    .transform((v) => v !== 'false'),
  DEDUP_POSSIBLE_MIN: z.coerce.number().min(0).max(1).default(0.45),
  DEDUP_DATE_WINDOW_DAYS: z.coerce.number().int().min(0).default(1),
  /** 原始快照保留天數（C9：≤ 30） */
  SNAPSHOT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(30, '快照保留不得超過 30 天（C9）')
    .default(30),
  CRON_DAILY: z.string().default('0 4 * * *'),
  CRON_WEEKLY: z.string().default('0 5 * * 1'),
  CRON_CLEANUP: z.string().default('30 3 * * *'),
  TZ: z.literal('Asia/Taipei'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema> & {
  SNAPSHOT_DIR_ABS: string;
  ALERT_MODE_RESOLVED: 'console' | 'slack';
};

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`環境變數設定錯誤（請參考 .env.example）：\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  const alertMode = env.ALERT_MODE ?? (env.SLACK_WEBHOOK_URL ? 'slack' : 'console');
  if (alertMode === 'slack' && !env.SLACK_WEBHOOK_URL) {
    throw new Error('ALERT_MODE=slack 需要設定 SLACK_WEBHOOK_URL');
  }
  return {
    ...env,
    ALERT_MODE_RESOLVED: alertMode,
    // 相對路徑一律以 repo 根目錄為基準，避免因 pnpm --filter 改變 cwd 而寫錯位置
    SNAPSHOT_DIR_ABS: isAbsolute(env.SNAPSHOT_DIR)
      ? env.SNAPSHOT_DIR
      : resolve(REPO_ROOT, env.SNAPSHOT_DIR),
  };
}
