import { z } from 'zod';
import {
  CRAWL_SCHEDULES,
  EVENT_STATUSES,
  EVENT_TYPES,
  REGIONS,
  SOURCE_IDS,
  SOURCE_KINDS,
  TAG_KINDS,
  TAG_ORIGINS,
  TAIWAN_CITIES,
} from '../enums';
import { REVIEW_REASONS } from '../review-reasons';

export const EventTypeSchema = z.enum(EVENT_TYPES);
export const RegionSchema = z.enum(REGIONS);
export const TaiwanCitySchema = z.enum(TAIWAN_CITIES);
export const EventStatusSchema = z.enum(EVENT_STATUSES);
export const SourceIdSchema = z.enum(SOURCE_IDS);
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export const CrawlScheduleSchema = z.enum(CRAWL_SCHEDULES);
export const TagKindSchema = z.enum(TAG_KINDS);
export const TagOriginSchema = z.enum(TAG_ORIGINS);
export const ReviewReasonSchema = z.enum(REVIEW_REASONS);

/** 帶時區偏移的 ISO 8601 字串（禁止無時區時間，tech-spec R1） */
export const IsoDateTimeWithOffsetSchema = z.iso.datetime({ offset: true, local: false });
/** 純日期 YYYY-MM-DD（台灣時間的日曆日） */
export const IsoDateSchema = z.iso.date();

/** 新台幣整數金額 */
export const PriceSchema = z.number().int().nonnegative();
