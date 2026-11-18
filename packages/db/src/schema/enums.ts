import {
  CRAWL_RUN_STATUSES,
  CRAWL_SCHEDULES,
  EVENT_STATUSES,
  EVENT_TYPES,
  REGIONS,
  REVIEW_REASONS,
  SOURCE_KINDS,
  TAG_KINDS,
  TAG_ORIGINS,
} from '@aeh/core';
import { pgEnum } from 'drizzle-orm/pg-core';

// 所有 enum 值來自 @aeh/core，DB 與程式碼共用單一事實來源。
// 新增 enum 值 → 改 core → `pnpm db:generate` 產生 ALTER TYPE migration。
export const eventTypeEnum = pgEnum('event_type', EVENT_TYPES);
export const regionEnum = pgEnum('region', REGIONS);
export const eventStatusEnum = pgEnum('event_status', EVENT_STATUSES);
export const reviewReasonEnum = pgEnum('review_reason', REVIEW_REASONS);
export const sourceKindEnum = pgEnum('source_kind', SOURCE_KINDS);
export const crawlScheduleEnum = pgEnum('crawl_schedule', CRAWL_SCHEDULES);
export const crawlRunStatusEnum = pgEnum('crawl_run_status', CRAWL_RUN_STATUSES);
export const tagKindEnum = pgEnum('tag_kind', TAG_KINDS);
export const tagOriginEnum = pgEnum('tag_origin', TAG_ORIGINS);
