import { parseArgs } from 'node:util';
import { CRAWL_SCHEDULES, SOURCE_IDS, type CrawlSchedule, type SourceId } from '@aeh/core';
import { getSnapshot, listSources } from '@aeh/db';
import { generateVAPIDKeys } from 'web-push';
import { createContext, createNotifyDeps } from './context';
import { loadEnv } from './env';
import { logger } from './logger';
import { cleanup, dedupExisting } from './maintenance';
import { runNotify } from './notify/job';
import { runSources, type RunMode, type RunSummary } from './pipeline';
import { selectSources } from './sources';

const USAGE = `用法：
  pnpm crawl   --source <id> | --all | --schedule <daily|weekly>  [--dry-run] [--allow-unverified]
  pnpm crawl   --from-snapshot <raw_snapshot.id>     （以該快照重跑解析，不打網路）
  pnpm reparse --source <id> | --all                （以最近一次成功擷取的快照重跑，不打網路）
  pnpm --filter @aeh/worker cli dedup [--dry-run]    （重算去重鍵並合併同鍵活動）
  pnpm --filter @aeh/worker cli cleanup              （刪除逾期快照與通知、標記已結束活動）
  pnpm --filter @aeh/worker notify [--dry-run]       （新活動上架比對、收藏提醒、送出推播）
  pnpm --filter @aeh/worker cli vapid                （產生 Web Push 用的 VAPID 金鑰）

來源 id：${SOURCE_IDS.join(', ')}
--all 只執行 DB 中 enabled = true 的來源；--schedule 再限定擷取頻率（與排程程序相同，供 GitHub Actions 使用）。`;

const COMMANDS = ['crawl', 'reparse', 'dedup', 'cleanup', 'notify', 'vapid'] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (v: string | undefined): v is Command => COMMANDS.includes(v as Command);
const isSourceId = (v: string | undefined): v is SourceId => SOURCE_IDS.includes(v as SourceId);
const isSchedule = (v: string | undefined): v is CrawlSchedule =>
  CRAWL_SCHEDULES.includes(v as CrawlSchedule);

function printSummary(summaries: RunSummary[], verbose: boolean): void {
  for (const s of summaries) {
    console.log(`\n■ ${s.sourceId}：${s.status}${s.error ? `（${s.error}）` : ''}`);
    const c = s.counters;
    console.log(
      `  找到 ${c.itemsFound}｜新增 ${c.itemsNew}｜更新 ${c.itemsUpdated}｜待審 ${c.itemsPendingReview}｜略過 ${c.itemsSkipped}｜缺必要欄位 ${c.itemsMissingFields}`,
    );
    if (!verbose) continue;
    for (const it of s.items) {
      const reasons = it.reviewReasons.length > 0 ? ` [${it.reviewReasons.join(', ')}]` : '';
      console.log(
        `  - ${it.action.padEnd(18)} ${it.status ?? '-'}${reasons}  ${it.title ?? it.externalId}`,
      );
      for (const n of it.notes) console.log(`      ${n}`);
    }
  }
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      all: { type: 'boolean', default: false },
      schedule: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'from-snapshot': { type: 'string' },
      'allow-unverified': { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command] = positionals;
  if (values.help || !isCommand(command)) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  if (command === 'vapid') {
    const keys = generateVAPIDKeys();
    console.log('把下列內容貼到 .env（私鑰不要進版控）：\n');
    console.log(`WEB_PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}`);
    console.log(`WEB_PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}`);
    console.log('WEB_PUSH_SUBJECT=mailto:你的聯絡信箱');
    return 0;
  }

  const env = loadEnv();
  const network = command === 'crawl' && !values['from-snapshot'];
  const { deps, handle } = createContext(env, {
    network,
    config: { allowUnverified: values['allow-unverified'] },
  });
  try {
    if (command === 'cleanup') {
      const r = await cleanup(deps, {
        retentionDays: env.SNAPSHOT_RETENTION_DAYS,
        notificationRetentionDays: env.NOTIFICATION_RETENTION_DAYS,
      });
      console.log(
        `刪除快照登記 ${r.snapshotRows} 筆、快照目錄 ${r.snapshotDirs.length} 個；標記已結束活動 ${r.endedEvents} 筆；刪除過舊通知 ${r.notifications} 筆`,
      );
      return 0;
    }
    if (command === 'notify') {
      const s = await runNotify(createNotifyDeps(env, deps.db), { dryRun: values['dry-run'] });
      const d = s.delivered;
      console.log(
        `檢查新活動 ${s.eventsChecked} 筆｜新活動通知 ${s.newEventNotifications}｜提醒 ${s.reminderNotifications}｜建立投遞 ${s.deliveriesCreated}`,
      );
      console.log(
        `投遞：送出 ${d.sent}｜模擬 ${d.simulated}｜待重試 ${d.retry}｜端點失效 ${d.gone}（NOTIFY_MODE=${env.NOTIFY_MODE}）`,
      );
      return 0;
    }
    if (command === 'dedup') {
      const r = await dedupExisting(deps, { dryRun: values['dry-run'] });
      console.log(
        `重算去重鍵 ${r.rekeyed} 筆；${values['dry-run'] ? '將' : '已'}合併 ${r.merged.length} 筆`,
      );
      for (const m of r.merged) console.log(`  #${m.from} → #${m.into}`);
      return 0;
    }

    // crawl / reparse
    let mode: RunMode;
    let sources: SourceId[];
    if (values['from-snapshot']) {
      const id = Number(values['from-snapshot']);
      const snap = Number.isInteger(id) ? await getSnapshot(deps.db, id) : null;
      if (!snap) throw new Error(`找不到快照：${values['from-snapshot']}`);
      mode = { kind: 'reparse', snapshotIds: [id] };
      sources = [snap.sourceId];
    } else {
      mode =
        command === 'crawl' ? { kind: 'crawl', dryRun: values['dry-run'] } : { kind: 'reparse' };
      const selectors = [values.all, values.source !== undefined, values.schedule !== undefined];
      if (selectors.filter(Boolean).length !== 1) {
        console.log(USAGE);
        return 1;
      }
      if (values.schedule !== undefined) {
        if (!isSchedule(values.schedule)) {
          console.log(`--schedule 只能是 ${CRAWL_SCHEDULES.join(' / ')}：${values.schedule}`);
          return 1;
        }
        sources = selectSources(await listSources(deps.db), values.schedule);
      } else if (values.all) {
        sources = selectSources(await listSources(deps.db));
      } else if (isSourceId(values.source)) {
        sources = [values.source];
      } else {
        console.log(USAGE);
        return 1;
      }
    }
    const summaries = await runSources(deps, sources, mode);
    printSummary(summaries, values.verbose || values['dry-run']);
    return summaries.some((s) => s.status === 'failed') ? 2 : 0;
  } finally {
    await handle.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    logger.error({ err }, 'CLI 執行失敗');
    process.exitCode = 1;
  },
);
