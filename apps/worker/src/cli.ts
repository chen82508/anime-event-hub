import { parseArgs } from 'node:util';
import { loadEnv } from './env';
import { logger } from './logger';

const USAGE = `用法：
  pnpm crawl   --source <id> | --all  [--dry-run] [--from-snapshot <id>]
  pnpm reparse --source <id>          （以既存快照重跑解析，不打網路）
  pnpm --filter @aeh/worker cli dedup | cleanup`;

const COMMANDS = ['crawl', 'reparse', 'dedup', 'cleanup'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(v: string | undefined): v is Command {
  return COMMANDS.includes(v as Command);
}

function main(): void {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      all: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'from-snapshot': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command] = positionals;
  if (values.help || !isCommand(command)) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const env = loadEnv();
  logger.info({ command, options: values, snapshotDir: env.SNAPSHOT_DIR_ABS }, 'cli invoked');

  // TODO(T9): 接上 pipeline.ts（fetch → snapshot → parse → normalize → validate → tag → dedup → upsert）
  logger.warn({ command }, '尚未實作（tech-spec T9）');
}

main();
