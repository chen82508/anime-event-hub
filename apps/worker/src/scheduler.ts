/**
 * 排程（T9、C9、C11）：單一 process、序列執行，不使用佇列。
 * - 每日：schedule = daily 且 enabled 的來源
 * - 每週：schedule = weekly 且 enabled 的來源（年度大展）
 * - 每日：快照清理（≤ 30 天）、已結束活動標記、過舊通知清理
 * - 每 5 分鐘：notify（新活動上架比對、收藏提醒、推播投遞；Phase 3）
 * 擷取／清理透過同一條 promise 鏈排隊，彼此不會重疊；notify 只讀寫通知相關表、
 * 每次只需數秒，另走自己的鏈（不必等數十分鐘的擷取跑完），上一輪未結束時略過本輪。
 */
import { listSources } from '@aeh/db';
import cron from 'node-cron';
import { TIMEZONE, type CrawlSchedule } from '@aeh/core';
import { createContext, createNotifyDeps } from './context';
import { loadEnv } from './env';
import { logger } from './logger';
import { cleanup } from './maintenance';
import { runNotify } from './notify/job';
import { runSources } from './pipeline';

const env = loadEnv();
const { deps, handle } = createContext(env, { network: true });
const notifyDeps = createNotifyDeps(env, deps.db);

let chain: Promise<unknown> = Promise.resolve();
function enqueue(name: string, job: () => Promise<unknown>): void {
  chain = chain
    .then(async () => {
      logger.info({ job: name }, '排程工作開始');
      await job();
      logger.info({ job: name }, '排程工作完成');
    })
    .catch((err: unknown) => logger.error({ err, job: name }, '排程工作失敗'));
}

let notifyRunning: Promise<unknown> | null = null;
function runNotifyTick(): void {
  if (notifyRunning) {
    logger.warn('上一輪 notify 尚未結束，略過本輪');
    return;
  }
  notifyRunning = runNotify(notifyDeps)
    .catch((err: unknown) => logger.error({ err, job: 'notify' }, '排程工作失敗'))
    .finally(() => {
      notifyRunning = null;
    });
}

async function crawlBySchedule(schedule: CrawlSchedule): Promise<void> {
  const sources = (await listSources(deps.db))
    .filter((s) => s.enabled && s.schedule === schedule)
    .map((s) => s.id);
  await runSources(deps, sources, { kind: 'crawl', dryRun: false });
}

for (const [expr, name] of [
  [env.CRON_DAILY, 'CRON_DAILY'],
  [env.CRON_WEEKLY, 'CRON_WEEKLY'],
  [env.CRON_CLEANUP, 'CRON_CLEANUP'],
  [env.CRON_NOTIFY, 'CRON_NOTIFY'],
] as const) {
  if (!cron.validate(expr)) throw new Error(`${name} 不是合法的 cron 表示式：${expr}`);
}

const tasks = [
  cron.schedule(env.CRON_DAILY, () => enqueue('crawl:daily', () => crawlBySchedule('daily')), {
    timezone: TIMEZONE,
    name: 'crawl-daily',
  }),
  cron.schedule(env.CRON_WEEKLY, () => enqueue('crawl:weekly', () => crawlBySchedule('weekly')), {
    timezone: TIMEZONE,
    name: 'crawl-weekly',
  }),
  cron.schedule(
    env.CRON_CLEANUP,
    () =>
      enqueue('cleanup', () =>
        cleanup(deps, {
          retentionDays: env.SNAPSHOT_RETENTION_DAYS,
          notificationRetentionDays: env.NOTIFICATION_RETENTION_DAYS,
        }),
      ),
    { timezone: TIMEZONE, name: 'cleanup' },
  ),
  cron.schedule(env.CRON_NOTIFY, runNotifyTick, { timezone: TIMEZONE, name: 'notify' }),
];
logger.info(
  {
    daily: env.CRON_DAILY,
    weekly: env.CRON_WEEKLY,
    cleanup: env.CRON_CLEANUP,
    notify: env.CRON_NOTIFY,
    notifyMode: env.NOTIFY_MODE,
    tz: TIMEZONE,
  },
  'scheduler 已啟動',
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'scheduler 停止中，等待執行中的工作完成');
  for (const t of tasks) await t.stop();
  await chain;
  await notifyRunning;
  await handle.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
