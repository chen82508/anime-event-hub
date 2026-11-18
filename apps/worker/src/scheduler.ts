/**
 * 排程（T9、C9、C11）：單一 process、序列執行，不使用佇列。
 * - 每日：schedule = daily 且 enabled 的來源
 * - 每週：schedule = weekly 且 enabled 的來源（年度大展）
 * - 每日：快照清理（≤ 30 天）與已結束活動標記
 * 所有工作透過同一條 promise 鏈排隊，彼此不會重疊。
 */
import { listSources } from '@aeh/db';
import cron from 'node-cron';
import { TIMEZONE, type CrawlSchedule } from '@aeh/core';
import { createContext } from './context';
import { loadEnv } from './env';
import { logger } from './logger';
import { cleanup } from './maintenance';
import { runSources } from './pipeline';

const env = loadEnv();
const { deps, handle } = createContext(env, { network: true });

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
    () => enqueue('cleanup', () => cleanup(deps, { retentionDays: env.SNAPSHOT_RETENTION_DAYS })),
    { timezone: TIMEZONE, name: 'cleanup' },
  ),
];
logger.info(
  { daily: env.CRON_DAILY, weekly: env.CRON_WEEKLY, cleanup: env.CRON_CLEANUP, tz: TIMEZONE },
  'scheduler 已啟動',
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'scheduler 停止中，等待執行中的工作完成');
  for (const t of tasks) await t.stop();
  await chain;
  await handle.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
