import { z } from 'zod';
import { regionOfCity } from '../enums';
import type { ReviewReason } from '../review-reasons';
import {
  EventTypeSchema,
  PriceSchema,
  RegionSchema,
  ReviewReasonSchema,
  SourceIdSchema,
  TaiwanCitySchema,
} from './common';

/** 管理者可覆寫、需受 `locked_fields` 保護的欄位（R7） */
export const LOCKABLE_FIELDS = [
  'title',
  'type',
  'startAt',
  'endAt',
  'allDay',
  'venueId',
  'isOnline',
  'city',
  'region',
  'priceMin',
  'priceMax',
  'isFree',
  'saleStartAt',
] as const;
export type LockableField = (typeof LOCKABLE_FIELDS)[number];
export const LockableFieldSchema = z.enum(LOCKABLE_FIELDS);

/**
 * normalize 之後、寫入 DB 之前的活動資料。
 * 必要欄位可能缺漏（→ reviewReasons），因此此處皆允許 null；能否發布由 `requiredFieldReasons` 判定。
 */
export const NormalizedEventSchema = z
  .object({
    sourceId: SourceIdSchema,
    externalId: z.string().min(1),
    sourceUrl: z.url(),

    title: z.string().trim().min(1),
    titleNormalized: z.string().min(1),
    type: EventTypeSchema.nullable(),

    startAt: z.date().nullable(),
    endAt: z.date().nullable(),
    /** 只有日期、沒有時刻的活動（以台灣日曆日解讀，R1） */
    allDay: z.boolean(),
    /** 年份由公告日推論而非明載（R2） */
    yearInferred: z.boolean(),

    venueId: z.number().int().positive().nullable(),
    /** 場館原文（字典未命中時供審核者參考） */
    venueRaw: z.string().nullable(),
    isOnline: z.boolean(),
    city: TaiwanCitySchema.nullable(),
    region: RegionSchema.nullable(),

    priceMin: PriceSchema.nullable(),
    priceMax: PriceSchema.nullable(),
    isFree: z.boolean(),
    saleStartAt: z.date().nullable(),

    reviewReasons: z.array(ReviewReasonSchema),
  })
  .superRefine((e, ctx) => {
    if (e.startAt && e.endAt && e.endAt < e.startAt) {
      ctx.addIssue({ code: 'custom', path: ['endAt'], message: 'endAt 早於 startAt' });
    }
    if (e.priceMin !== null && e.priceMax !== null && e.priceMax < e.priceMin) {
      ctx.addIssue({ code: 'custom', path: ['priceMax'], message: 'priceMax 小於 priceMin' });
    }
    if (e.isFree && (e.priceMin ?? 0) > 0) {
      ctx.addIssue({ code: 'custom', path: ['isFree'], message: '免費活動不應有正票價' });
    }
    if (e.isOnline && e.region !== null && e.region !== 'online') {
      ctx.addIssue({ code: 'custom', path: ['region'], message: '線上活動的 region 應為 online' });
    }
    if (!e.isOnline && e.region === 'online') {
      ctx.addIssue({ code: 'custom', path: ['region'], message: '非線上活動不得標為 online' });
    }
    if (e.city !== null && e.region !== null && !e.isOnline && regionOfCity(e.city) !== e.region) {
      ctx.addIssue({ code: 'custom', path: ['region'], message: 'region 與 city 不一致（D3）' });
    }
  });

export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

/**
 * 必要欄位檢查（tech-spec §4.2）：title、start_at、venue 或 is_online、source_url。
 * title 與 source_url 已由 schema 保證；此處補上日期與場館。
 */
export function requiredFieldReasons(
  e: Pick<NormalizedEvent, 'startAt' | 'venueId' | 'isOnline'>,
): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (e.startAt === null) reasons.push('missing_date');
  if (e.venueId === null && !e.isOnline) reasons.push('missing_venue');
  return reasons;
}

/** 無任何審核原因且必要欄位齊全 → 可自動發布（C4） */
export function isAutoPublishable(e: NormalizedEvent): boolean {
  return e.reviewReasons.length === 0 && requiredFieldReasons(e).length === 0 && e.type !== null;
}

/** 與審核原因相關的欄位（判斷原因是否「因欄位變動而解決」） */
export type ReasonFieldState = Pick<
  NormalizedEvent,
  'startAt' | 'endAt' | 'venueId' | 'isOnline' | 'type'
>;

const REASON_FIELDS: Partial<Record<ReviewReason, readonly (keyof ReasonFieldState)[]>> = {
  missing_date: ['startAt', 'endAt'],
  ambiguous_date: ['startAt', 'endAt'],
  missing_venue: ['venueId', 'isOnline'],
  unknown_venue: ['venueId', 'isOnline'],
  outside_taiwan: ['venueId', 'isOnline'],
  below_scale_threshold: ['venueId', 'isOnline'],
  type_unresolved: ['type'],
};

function sameFieldValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** 該原因的相關欄位在 before → after 之間是否沒有變動（無相關欄位的原因視為未變） */
export function reasonFieldsUnchanged(
  reason: ReviewReason,
  before: ReasonFieldState,
  after: ReasonFieldState,
): boolean {
  return (REASON_FIELDS[reason] ?? []).every((f) => sameFieldValue(before[f], after[f]));
}

/**
 * 移除「因欄位變動而解決」的審核原因（人工補齊欄位、跨來源合併、重新擷取時使用）。
 *
 * `before` 是產生這些原因時的欄位、`after` 是套用變動後的欄位。原因只有在相關欄位**實際有變**、
 * 且變動後已滿足條件時才移除；欄位沒變就保留——例如「線上活動但來源無法確認台灣主辦」的
 * outside_taiwan、「結束早於開始」的 ambiguous_date，欄位本身看似齊全，卻不代表已解決（C4、C6）。
 * 與欄位無關的原因（possible_duplicate、source_changed、parse_error）需由人工明確解除，不在此移除。
 */
export function pruneResolvedReasons(
  reasons: readonly ReviewReason[],
  before: ReasonFieldState,
  after: ReasonFieldState,
): ReviewReason[] {
  const hasDate = after.startAt !== null;
  const hasPlace = after.venueId !== null || after.isOnline;
  return reasons.filter((r) => {
    if (reasonFieldsUnchanged(r, before, after)) return true;
    switch (r) {
      case 'missing_date':
      case 'ambiguous_date':
        return !hasDate;
      case 'missing_venue':
      case 'unknown_venue':
      case 'outside_taiwan':
        return !hasPlace;
      case 'below_scale_threshold':
        // 規模門檻只針對「場館不在字典」的 KKTIX 活動；補上字典場館即解除
        return after.venueId === null;
      case 'type_unresolved':
        return after.type === null;
      default:
        return true;
    }
  });
}
