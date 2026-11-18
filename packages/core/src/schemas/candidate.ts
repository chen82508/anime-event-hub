import { z } from 'zod';
import {
  EventTypeSchema,
  IsoDateSchema,
  IsoDateTimeWithOffsetSchema,
  PriceSchema,
  SourceIdSchema,
} from './common';

/**
 * 擷取器 parse 階段的輸出（純函式產物，尚未正規化）。
 *
 * - `*Text` 欄位保留來源原始字串，交給 @aeh/normalize 解析（日期、票價、場館）。
 * - 若來源本身有結構化資料（如 JSON-LD），可直接填入 `structured`，normalize 會優先採用。
 * - 只保存詮釋性資料，不放公告全文（C9）。
 */
export const RawEventCandidateSchema = z.object({
  sourceId: SourceIdSchema,
  /** 來源內穩定 ID；優先用 URL 中的 ID，退而求其次用正規化 URL（R8） */
  externalId: z.string().trim().min(1),
  /** 原始公告／購票頁（必填，導流回原平台） */
  url: z.url({ protocol: /^https?$/ }),
  /** 標題原文，不翻譯（C2） */
  title: z.string().trim().min(1),

  dateText: z.string().trim().min(1).optional(),
  timeText: z.string().trim().min(1).optional(),
  venueText: z.string().trim().min(1).optional(),
  addressText: z.string().trim().min(1).optional(),
  priceText: z.string().trim().min(1).optional(),
  saleText: z.string().trim().min(1).optional(),
  isOnline: z.boolean().optional(),

  /** 公告發布日（台灣日曆日），供缺年份推論（R2） */
  publishedOn: IsoDateSchema.optional(),

  structured: z
    .object({
      startAt: IsoDateTimeWithOffsetSchema.optional(),
      endAt: IsoDateTimeWithOffsetSchema.optional(),
      startDate: IsoDateSchema.optional(),
      endDate: IsoDateSchema.optional(),
      priceMin: PriceSchema.optional(),
      priceMax: PriceSchema.optional(),
      isFree: z.boolean().optional(),
      saleStartAt: IsoDateTimeWithOffsetSchema.optional(),
    })
    .strict()
    .optional(),

  /** 來源推論的類型（如 CWT → doujin），優先於關鍵字字典（C5） */
  typeHint: EventTypeSchema.optional(),
  /** 擷取器想留給審核者看的備註（例：一則公告多場次 → 已拆分） */
  notes: z.array(z.string()).optional(),
});

export type RawEventCandidate = z.infer<typeof RawEventCandidateSchema>;
