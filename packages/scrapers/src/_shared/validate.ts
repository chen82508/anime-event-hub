/**
 * 候選資料 → 正規化活動 ＋ 必要欄位驗證（tech-spec §4 normalize / validate、§4.2、§4.3）。純函式。
 *
 * - 日期：來源結構化資料優先，否則解析 dateText/timeText；missing → missing_date、無法唯一判定 → ambiguous_date
 * - 場館：字典比對；missing_venue / unknown_venue / outside_taiwan
 * - 類型：tagger（擷取器提示 → 來源 → 關鍵字）；無法判定 → type_unresolved
 * - KKTIX 規模門檻：場館不在字典、且票價上限未達門檻 → below_scale_threshold（門檻值為設定，R15）
 * - 任一審核原因存在 → pending_review，絕不自動上架（C4）
 */
import {
  NormalizedEventSchema,
  REVIEW_REASONS,
  isAutoPublishable,
  type EventStatus,
  type NormalizedEvent,
  type RawEventCandidate,
  type ReviewReason,
} from '@aeh/core';
import {
  normalizeTitle,
  parseEventDate,
  parsePrice,
  parseSaleStart,
  taipeiDateTime,
  venueReviewReasons,
  type VenueRecord,
  type VenueResolver,
} from '@aeh/normalize';
import type { TagHit, TagRecord, Tagger } from '@aeh/tagger';

export interface ScaleThresholds {
  /** KKTIX：場館不在字典時，票價上限需 ≥ 此值才不標 below_scale_threshold；null = 不看票價 */
  kktixMinPriceMax: number | null;
}

export const DEFAULT_SCALE_THRESHOLDS: ScaleThresholds = { kktixMinPriceMax: 1000 };

export interface NormalizeContext<V extends VenueRecord & { id: number }, T extends TagRecord> {
  venues: VenueResolver<V>;
  tagger: Tagger<T>;
  /** 擷取日（台灣日曆日）；候選沒有 publishedOn 時作為缺年份推論的基準 */
  fetchedOn: string;
  scale?: ScaleThresholds;
}

export interface NormalizeResult<T extends TagRecord> {
  event: NormalizedEvent;
  status: Extract<EventStatus, 'published' | 'pending_review'>;
  tags: TagHit<T>[];
  /** 給審核者看的說明（日期/票價無法判定的原因、命中的規則等） */
  notes: string[];
}

function sortReasons(reasons: Iterable<ReviewReason>): ReviewReason[] {
  const set = new Set(reasons);
  return REVIEW_REASONS.filter((r) => set.has(r));
}

export function normalizeCandidate<V extends VenueRecord & { id: number }, T extends TagRecord>(
  c: RawEventCandidate,
  ctx: NormalizeContext<V, T>,
): NormalizeResult<T> {
  const reasons: ReviewReason[] = [];
  const notes: string[] = [...(c.notes ?? [])];
  const referenceDate = c.publishedOn ?? ctx.fetchedOn;
  const s = c.structured ?? {};

  // ── 日期 ──
  let startAt: Date | null = null;
  let endAt: Date | null = null;
  let allDay = false;
  let yearInferred = false;
  if (s.startAt) {
    // 結構化資料已帶時區（schema 保證），可安全解析
    startAt = new Date(s.startAt);
    endAt = s.endAt ? new Date(s.endAt) : null;
  } else if (s.startDate) {
    allDay = true;
    startAt = taipeiDateTime(s.startDate);
    endAt = s.endDate ? taipeiDateTime(s.endDate, '23:59', 59) : null;
  } else {
    const d = parseEventDate(c.dateText, c.timeText, { referenceDate });
    if (d.kind === 'ok') {
      ({ startAt, endAt, allDay, yearInferred } = d.value);
      if (d.value.openStart) notes.push('「即日起」活動：開始日以公告日/擷取日代入');
    } else if (d.kind === 'ambiguous') {
      reasons.push('ambiguous_date');
      notes.push(`日期：${d.reason}`);
    } else {
      reasons.push('missing_date');
    }
  }
  if (startAt && endAt && endAt < startAt) {
    reasons.push('ambiguous_date');
    notes.push('日期：結束早於開始');
    endAt = null;
  }

  // ── 場館 / 地區 ──
  const venue = ctx.venues.resolve({
    venueText: c.venueText,
    addressText: c.addressText,
    isOnline: c.isOnline,
  });
  reasons.push(...venueReviewReasons(venue));
  const isOnline = venue.kind === 'online';
  let venueId: number | null = null;
  let city: NormalizedEvent['city'] = null;
  let region: NormalizedEvent['region'] = null;
  switch (venue.kind) {
    case 'matched':
      venueId = venue.venue.id;
      city = venue.city;
      region = venue.region;
      break;
    case 'online':
      region = 'online';
      break;
    case 'unknown':
      city = venue.city;
      region = venue.region;
      break;
    case 'outside_taiwan':
      notes.push(`場館：疑似海外（${venue.place}）`);
      break;
    case 'ambiguous':
      notes.push(`場館：命中多個場館（${venue.venues.map((v) => v.name).join('、')}），可能需拆分`);
      break;
    case 'missing':
      break;
  }

  // ── 票價（選填，無法判定只記錄說明） ──
  let priceMin: number | null = s.priceMin ?? null;
  let priceMax: number | null = s.priceMax ?? null;
  let isFree = s.isFree ?? false;
  if (priceMin === null && priceMax === null && s.isFree === undefined) {
    const p = parsePrice(c.priceText);
    if (p.kind === 'ok') {
      ({ min: priceMin, max: priceMax, isFree } = p.value);
    } else if (p.kind === 'ambiguous') {
      notes.push(`票價：${p.reason}`);
    }
  }
  if (priceMin !== null && priceMax === null) priceMax = priceMin;
  if (priceMax !== null && priceMin === null) priceMin = priceMax;

  // ── 開賣時間（選填） ──
  let saleStartAt: Date | null = s.saleStartAt ? new Date(s.saleStartAt) : null;
  if (!saleStartAt && c.saleText) {
    const sale = parseSaleStart(c.saleText, { referenceDate });
    if (sale.kind === 'ok') saleStartAt = sale.at;
    else if (sale.kind === 'ambiguous') notes.push(`開賣：${sale.reason}`);
  }

  // ── 類型 / 標籤 ──
  const tagged = ctx.tagger.tag({ title: c.title, sourceId: c.sourceId, typeHint: c.typeHint });
  reasons.push(...tagged.reviewReasons);

  // ── 規模門檻（KKTIX，PoC 後校正，R15） ──
  const scale = ctx.scale ?? DEFAULT_SCALE_THRESHOLDS;
  if (c.sourceId === 'kktix' && venue.kind !== 'matched' && !isOnline) {
    const bigEnough =
      scale.kktixMinPriceMax !== null && priceMax !== null && priceMax >= scale.kktixMinPriceMax;
    if (!bigEnough) reasons.push('below_scale_threshold');
  }

  const event = NormalizedEventSchema.parse({
    sourceId: c.sourceId,
    externalId: c.externalId,
    sourceUrl: c.url,
    title: c.title,
    titleNormalized: normalizeTitle(c.title),
    type: tagged.type.type,
    startAt,
    endAt,
    allDay,
    yearInferred,
    venueId,
    venueRaw: [c.venueText, c.addressText].filter(Boolean).join(' / ') || null,
    isOnline,
    city,
    region,
    priceMin,
    priceMax,
    isFree,
    saleStartAt,
    reviewReasons: sortReasons(reasons),
  } satisfies NormalizedEvent);

  return {
    event,
    status: isAutoPublishable(event) ? 'published' : 'pending_review',
    tags: tagged.tags,
    notes,
  };
}
