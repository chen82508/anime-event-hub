import type { LockableField, TaiwanCity } from '@aeh/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, textArray, tstz, updatedAt } from './_helpers';
import { sourceItem } from './crawl';
import { city, tag, venue } from './dictionary';
import {
  eventStatusEnum,
  eventTypeEnum,
  regionEnum,
  reviewReasonEnum,
  tagOriginEnum,
} from './enums';

/**
 * 活動。必要欄位可為 NULL（待審資料），但 published 時必須齊全（CHECK 約束，C4）。
 * 時間一律 timestamptz；all_day 活動以台灣日曆日 00:00 (+08:00) 儲存。
 */
export const event = pgTable(
  'event',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** 來源原文，不翻譯（C2） */
    title: text('title').notNull(),
    /** normalizeForMatch(title)，供去重與 trigram 比對 */
    titleNormalized: text('title_normalized').notNull(),
    type: eventTypeEnum('type'),
    startAt: tstz('start_at'),
    endAt: tstz('end_at'),
    allDay: boolean('all_day').notNull().default(false),
    yearInferred: boolean('year_inferred').notNull().default(false),
    venueId: integer('venue_id').references(() => venue.id, { onDelete: 'set null' }),
    /** 場館原文（字典未命中時供審核者參考） */
    venueRaw: text('venue_raw'),
    isOnline: boolean('is_online').notNull().default(false),
    city: text('city')
      .$type<TaiwanCity>()
      .references(() => city.name, { onUpdate: 'cascade' }),
    region: regionEnum('region'),
    /** 新台幣整數 */
    priceMin: integer('price_min'),
    priceMax: integer('price_max'),
    isFree: boolean('is_free').notNull().default(false),
    saleStartAt: tstz('sale_start_at'),
    status: eventStatusEnum('status').notNull().default('pending_review'),
    /**
     * 狀態由管理者手動設定（退回待審、隱藏、取消、結束）→ 管線不得自動改變狀態（C4）。
     * 手動發布時解除（之後來源出現新的審核原因仍會退回待審）。
     */
    statusLocked: boolean('status_locked').notNull().default(false),
    reviewReasons: reviewReasonEnum('review_reasons')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** 去重鍵（@aeh/dedup dedupKey）：正規化標題＋開始日期＋場館；缺必要欄位時為 NULL */
    dedupKey: text('dedup_key'),
    /** 正規化時留給審核者的說明（日期/票價無法判定的原因等） */
    reviewNotes: textArray('review_notes'),
    /** 管理者覆寫過的欄位，重新擷取不得覆蓋（R7） */
    lockedFields: textArray('locked_fields').$type<LockableField[]>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    publishedAt: tstz('published_at'),
  },
  (t) => [
    index('event_title_normalized_trgm_idx').using('gin', t.titleNormalized.op('gin_trgm_ops')),
    index('event_status_start_idx').on(t.status, t.startAt),
    index('event_start_idx').on(t.startAt),
    index('event_venue_idx').on(t.venueId),
    index('event_dedup_key_idx').on(t.dedupKey),
    check(
      'event_end_after_start',
      sql`${t.endAt} IS NULL OR ${t.startAt} IS NULL OR ${t.endAt} >= ${t.startAt}`,
    ),
    check(
      'event_price_nonnegative',
      sql`(${t.priceMin} IS NULL OR ${t.priceMin} >= 0) AND (${t.priceMax} IS NULL OR ${t.priceMax} >= 0)`,
    ),
    check(
      'event_price_range',
      sql`${t.priceMin} IS NULL OR ${t.priceMax} IS NULL OR ${t.priceMin} <= ${t.priceMax}`,
    ),
    check(
      'event_online_region',
      sql`(${t.isOnline} AND (${t.region} IS NULL OR ${t.region} = 'online')) OR (NOT ${t.isOnline} AND (${t.region} IS NULL OR ${t.region} <> 'online'))`,
    ),
    // C4：發布前必要欄位須齊全、且無未解決審核原因
    check(
      'event_published_requirements',
      sql`${t.status} <> 'published' OR (${t.startAt} IS NOT NULL AND ${t.type} IS NOT NULL AND (${t.venueId} IS NOT NULL OR ${t.isOnline}) AND cardinality(${t.reviewReasons}) = 0 AND ${t.publishedAt} IS NOT NULL)`,
    ),
  ],
);

/** 一活動多來源連結（跨來源去重後保留每個來源，T8） */
export const eventSource = pgTable(
  'event_source',
  {
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    sourceItemId: bigint('source_item_id', { mode: 'number' })
      .notNull()
      .references(() => sourceItem.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.sourceItemId] }),
    // 一個來源項目只能屬於一個活動
    unique('event_source_source_item_uq').on(t.sourceItemId),
    // 每個活動最多一個主要來源
    uniqueIndex('event_source_one_primary_uq')
      .on(t.eventId)
      .where(sql`${t.isPrimary}`),
  ],
);

export const eventTag = pgTable(
  'event_tag',
  {
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
    origin: tagOriginEnum('origin').notNull(),
    /** 命中哪條規則／別名（除錯用，T7） */
    matchedBy: text('matched_by'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.tagId] }), index('event_tag_tag_idx').on(t.tagId)],
);
