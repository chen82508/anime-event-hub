import type { SourceId } from '@aeh/core';
import { bigint, boolean, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, tstz, updatedAt } from './_helpers';
import { crawlRunStatusEnum, crawlScheduleEnum, sourceKindEnum } from './enums';
import { event } from './event';

/** 擷取來源（sources.yaml）。consecutive_empty_runs 為告警依據（T9）。 */
export const source = pgTable('source', {
  id: text('id').$type<SourceId>().primaryKey(),
  name: text('name').notNull(),
  kind: sourceKindEnum('kind').notNull(),
  baseUrl: text('base_url'),
  schedule: crawlScheduleEnum('schedule').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  lastSuccessAt: tstz('last_success_at'),
  consecutiveEmptyRuns: integer('consecutive_empty_runs').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 每次擷取執行紀錄；待審比例、每來源筆數由此查詢（Phase 1 DoD 3） */
export const crawlRun = pgTable(
  'crawl_run',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: text('source_id')
      .$type<SourceId>()
      .notNull()
      .references(() => source.id),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    status: crawlRunStatusEnum('status').notNull().default('running'),
    dryRun: boolean('dry_run').notNull().default(false),
    itemsFound: integer('items_found').notNull().default(0),
    itemsNew: integer('items_new').notNull().default(0),
    itemsUpdated: integer('items_updated').notNull().default(0),
    itemsPendingReview: integer('items_pending_review').notNull().default(0),
    itemsSkipped: integer('items_skipped').notNull().default(0),
    /** 缺必要欄位（missing_date / missing_venue）的筆數，供「欄位缺漏率突增」告警 */
    itemsMissingFields: integer('items_missing_fields').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('crawl_run_source_started_idx').on(t.sourceId, t.startedAt)],
);

/**
 * 原始頁面快照登記。本體存於 SNAPSHOT_DIR/<source>/<yyyy-mm-dd>/<hash>.html（D4），
 * 保留 30 天，由排程連同檔案一起清理（C9）。
 */
export const rawSnapshot = pgTable(
  'raw_snapshot',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: text('source_id')
      .$type<SourceId>()
      .notNull()
      .references(() => source.id),
    crawlRunId: bigint('crawl_run_id', { mode: 'number' }).references(() => crawlRun.id, {
      onDelete: 'set null',
    }),
    url: text('url').notNull(),
    fetchedAt: tstz('fetched_at').notNull().defaultNow(),
    httpStatus: integer('http_status'),
    contentType: text('content_type'),
    /** sha256 hex */
    contentHash: text('content_hash').notNull(),
    /** 相對於 SNAPSHOT_DIR 的路徑 */
    storagePath: text('storage_path').notNull(),
    encoding: text('encoding'),
  },
  (t) => [
    index('raw_snapshot_source_fetched_idx').on(t.sourceId, t.fetchedAt),
    index('raw_snapshot_fetched_idx').on(t.fetchedAt),
  ],
);

/** 來源中的單一項目；以 (source_id, external_id) idempotent upsert */
export const sourceItem = pgTable(
  'source_item',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: text('source_id')
      .$type<SourceId>()
      .notNull()
      .references(() => source.id),
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    /** parsed 內容的 hash，用來偵測來源變動（source_changed） */
    contentHash: text('content_hash').notNull(),
    /** RawEventCandidate（@aeh/core）原樣保存，供 reparse／除錯 */
    parsed: jsonb('parsed').notNull(),
    eventId: bigint('event_id', { mode: 'number' }).references(() => event.id, {
      onDelete: 'set null',
    }),
    lastSnapshotId: bigint('last_snapshot_id', { mode: 'number' }).references(
      () => rawSnapshot.id,
      { onDelete: 'set null' },
    ),
    /** 被過濾而未建立活動的原因（例：商品公告、非活動，R11） */
    skipReason: text('skip_reason'),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('source_item_source_external_uq').on(t.sourceId, t.externalId),
    index('source_item_event_idx').on(t.eventId),
  ],
);
