import { parseArgs } from 'node:util';
import { SOURCE_IDS, type SourceId } from '@aeh/core';
import { getSnapshot, listSources } from '@aeh/db';
import { createContext } from './context';
import { loadEnv } from './env';
import { logger } from './logger';
import { cleanup, dedupExisting } from './maintenance';
import { runSources, type RunMode, type RunSummary } from './pipeline';

const USAGE = `用法：
  pnpm crawl   --source <id> | --all  [--dry-run] [--allow-unverified]
  pnpm crawl   --from-snapshot <raw_snapshot.id>     （以該快照重跑解析，不打網路）
  pnpm reparse --source <id> | --all                （以最近一次成功擷取的快照重跑，不打網路）
  pnpm --filter @aeh/worker cli dedup [--dry-run]    （重算去重鍵並合併同鍵活動）
  pnpm --filter @aeh/worker cli cleanup              （刪除逾期快照、標記已結束活動）

來源 id：${SOURCE_IDS.join(', ')}
--all 只執行 DB 中 enabled = true 的來源。`;

const COMMANDS = ['crawl', 'reparse', 'dedup', 'cleanup'] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (v: string | undefined): v is Command => COMMANDS.includes(v as Command);
const isSourceId = (v: string | undefined): v is SourceId => SOURCE_IDS.includes(v as SourceId);

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

  const env = loadEnv();
  const network = command === 'crawl' && !values['from-snapshot'];
  const { deps, handle } = createContext(env, {
    network,
    config: { allowUnverified: values['allow-unverified'] },
  });
  try {
    if (command === 'cleanup') {
      const r = await cleanup(deps, { retentionDays: env.SNAPSHOT_RETENTION_DAYS });
      console.log(
        `刪除快照登記 ${r.snapshotRows} 筆、快照目錄 ${r.snapshotDirs.length} 個；標記已結束活動 ${r.endedEvents} 筆`,
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
      if (values.all) {
        sources = (await listSources(deps.db)).filter((s) => s.enabled).map((s) => s.id);
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
