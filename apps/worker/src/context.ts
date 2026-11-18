/** 由環境變數組裝管線相依（CLI 與排程共用） */
import { createDb, type DbHandle } from '@aeh/db';
import { PoliteClient, SnapshotStore } from '@aeh/http';
import { createRegistry } from '@aeh/scrapers';
import { createAlerter } from './alerts';
import type { Env } from './env';
import { logger } from './logger';
import type { PipelineConfig, PipelineDeps } from './pipeline';

export function pipelineConfig(env: Env, overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    scale: { kktixMinPriceMax: env.KKTIX_MIN_PRICE_MAX, kktixTagPasses: env.KKTIX_TAG_PASSES },
    dedup: { possibleMin: env.DEDUP_POSSIBLE_MIN, dateWindowDays: env.DEDUP_DATE_WINDOW_DAYS },
    allowUnverified: false,
    emptyRunThreshold: env.ALERT_EMPTY_RUN_THRESHOLD,
    missingRateJump: env.ALERT_MISSING_RATE_JUMP,
    ...overrides,
  };
}

export function createContext(
  env: Env,
  opts: { network: boolean; config?: Partial<PipelineConfig> },
): { deps: PipelineDeps; handle: DbHandle } {
  const handle = createDb(env.DATABASE_URL);
  const store = new SnapshotStore(env.SNAPSHOT_DIR_ABS);
  const client = opts.network
    ? new PoliteClient({
        userAgent: env.CRAWL_USER_AGENT,
        snapshots: store,
        minIntervalMs: env.CRAWL_MIN_INTERVAL_MS,
        logger: logger.child({ component: 'http' }),
      })
    : null;
  const alerter = createAlerter({
    mode: env.ALERT_MODE_RESOLVED,
    ...(env.SLACK_WEBHOOK_URL ? { webhookUrl: env.SLACK_WEBHOOK_URL } : {}),
    db: handle.db,
    throttleMs: env.ALERT_THROTTLE_MINUTES * 60_000,
    logger: logger.child({ component: 'alerts' }),
  });
  return {
    handle,
    deps: {
      db: handle.db,
      store,
      client,
      scrapers: createRegistry(env.KKTIX_KEYWORDS ? { kktixKeywords: env.KKTIX_KEYWORDS } : {}),
      alerter,
      logger,
      config: pipelineConfig(env, opts.config),
    },
  };
}
