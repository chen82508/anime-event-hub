/**
 * 前台（Phase 2 Discovery）唯讀查詢。
 *
 * 規則：
 * - 只回傳 published（月曆檢視可含 ended）活動；待審、隱藏、取消一律不出現在前台（C4）。
 * - 不回傳審核原因、鎖定欄位、來源解析結果等後台資料；也不回傳公告全文（C9）。
 * - 每筆活動附原始連結（C8），詳情頁以主要來源為「官方購票 / 原始公告」主按鈕。
 */
import type { EventStatus, EventType, Region, SourceId, SourceKind, TagKind } from '@aeh/core';
import { and, asc, desc, eq, gt, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { event, eventSource, eventTag, source, sourceItem, tag, venue } from '../schema';
import type { DbOrTx } from './types';

/** 「是否已開賣」：on_sale = 開賣時間已過；upcoming = 尚未開賣。未提供開賣時間者兩者皆不符合（不猜測）。 */
export const SALE_FILTERS = ['on_sale', 'upcoming'] as const;
export type SaleFilter = (typeof SALE_FILTERS)[number];

export interface TagRef {
  kind: TagKind;
  slug: string;
}

export interface PublicEventFilter {
  /** 多選，彼此為 OR */
  regions?: readonly Region[];
  /** 多選，彼此為 OR */
  types?: readonly EventType[];
  /** 多選，命中任一標籤即可 */
  tags?: readonly TagRef[];
  /** 關鍵字原文（比對標題、標籤名稱與別名） */
  q?: string;
  /** 關鍵字經 normalizeForMatch() 後的版本（比對 title_normalized） */
  qNormalized?: string;
  /** 活動期間與 [from, to) 有交集；未結束的判定與 markEndedEvents 一致 */
  from?: Date;
  to?: Date;
  sale?: SaleFilter;
  /** 月曆檢視需要顯示本月已結束的活動 */
  includeEnded?: boolean;
  /** 判定開賣狀態的基準時間（測試可注入） */
  now?: Date;
  limit?: number;
}

export interface PublicEventTag {
  kind: TagKind;
  slug: string;
  name: string;
}

export interface PublicEventListItem {
  id: number;
  title: string;
  type: EventType | null;
  status: EventStatus;
  startAt: Date | null;
  endAt: Date | null;
  allDay: boolean;
  isOnline: boolean;
  venueName: string | null;
  city: string | null;
  region: Region | null;
  priceMin: number | null;
  priceMax: number | null;
  isFree: boolean;
  saleStartAt: Date | null;
  tags: PublicEventTag[];
}

/** LIKE 樣式跳脫（關鍵字中的 % _ \ 視為一般字元） */
function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const DEFAULT_LIMIT = 300;

const tagsJson = sql<PublicEventTag[]>`coalesce((
  select json_agg(json_build_object('kind', t.kind, 'slug', t.slug, 'name', t.name)
                  order by t.kind, t.name)
  from ${eventTag} et join ${tag} t on t.id = et.tag_id
  where et.event_id = ${event.id}), '[]'::json)`;

/** 活動結束時間（無結束時間者以開始後一天計，同 markEndedEvents） */
const effectiveEnd = sql`coalesce(${event.endAt}, ${event.startAt} + interval '1 day')`;

function buildWhere(f: PublicEventFilter): SQL | undefined {
  const now = f.now ?? new Date();
  const statuses: EventStatus[] = f.includeEnded ? ['published', 'ended'] : ['published'];
  const q = f.q?.trim();
  const qn = f.qNormalized?.trim();
  const tagConds = (f.tags ?? []).map((t) => and(eq(tag.kind, t.kind), eq(tag.slug, t.slug)));

  const conds: (SQL | undefined)[] = [
    inArray(event.status, statuses),
    // published 必有 start_at（CHECK 約束）；ended 也保險加上
    sql`${event.startAt} is not null`,
    f.regions?.length ? inArray(event.region, [...f.regions]) : undefined,
    f.types?.length ? inArray(event.type, [...f.types]) : undefined,
    tagConds.length
      ? sql`exists (select 1 from ${eventTag} join ${tag} on ${tag.id} = ${eventTag.tagId}
             where ${eventTag.eventId} = ${event.id} and (${or(...tagConds)}))`
      : undefined,
    q
      ? or(
          sql`${event.title} ilike ${likePattern(q)}`,
          qn ? sql`${event.titleNormalized} ilike ${likePattern(qn)}` : undefined,
          sql`exists (select 1 from ${eventTag} et2 join ${tag} t2 on t2.id = et2.tag_id
               where et2.event_id = ${event.id}
                 and (t2.name ilike ${likePattern(q)}
                      or exists (select 1 from unnest(t2.aliases) a where a ilike ${likePattern(q)})))`,
        )
      : undefined,
    f.from ? sql`${effectiveEnd} > ${f.from.toISOString()}::timestamptz` : undefined,
    f.to ? sql`${event.startAt} < ${f.to.toISOString()}::timestamptz` : undefined,
    f.sale === 'on_sale' ? lte(event.saleStartAt, now) : undefined,
    f.sale === 'upcoming' ? gt(event.saleStartAt, now) : undefined,
  ];
  return and(...conds);
}

/** 前台活動列表（依開始時間排序）。數百筆/年量級，以 limit 保護即可，不做分頁。 */
export async function listPublicEvents(
  db: DbOrTx,
  f: PublicEventFilter = {},
): Promise<{ rows: PublicEventListItem[]; total: number }> {
  const where = buildWhere(f);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: event.id,
        title: event.title,
        type: event.type,
        status: event.status,
        startAt: event.startAt,
        endAt: event.endAt,
        allDay: event.allDay,
        isOnline: event.isOnline,
        venueName: venue.name,
        city: event.city,
        region: event.region,
        priceMin: event.priceMin,
        priceMax: event.priceMax,
        isFree: event.isFree,
        saleStartAt: event.saleStartAt,
        tags: tagsJson,
      })
      .from(event)
      .leftJoin(venue, eq(venue.id, event.venueId))
      .where(where)
      .orderBy(asc(event.startAt), asc(event.id))
      .limit(f.limit ?? DEFAULT_LIMIT),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(event)
      .where(where),
  ]);
  return { rows, total: count?.n ?? 0 };
}

export interface PublicTagFacet extends PublicEventTag {
  /** 未結束的已發布活動中，帶此標籤的筆數 */
  count: number;
}

/**
 * 篩選面板的標籤選項：只列出「未結束的已發布活動」實際用到的標籤（避免選了必定 0 筆）。
 * 不隨目前篩選條件變動，選項才不會在操作中跳動。
 */
export async function listPublicTagFacets(
  db: DbOrTx,
  now: Date = new Date(),
): Promise<PublicTagFacet[]> {
  return db
    .select({
      kind: tag.kind,
      slug: tag.slug,
      name: tag.name,
      count: sql<number>`count(distinct ${event.id})::int`,
    })
    .from(eventTag)
    .innerJoin(tag, eq(tag.id, eventTag.tagId))
    .innerJoin(event, eq(event.id, eventTag.eventId))
    .where(
      and(eq(event.status, 'published'), sql`${effectiveEnd} > ${now.toISOString()}::timestamptz`),
    )
    .groupBy(tag.kind, tag.slug, tag.name)
    .orderBy(asc(tag.kind), desc(sql`count(distinct ${event.id})`), asc(tag.name));
}

/** 依 kind/slug 取標籤名稱（篩選條件顯示用；含目前沒有活動的標籤） */
export async function findTagsByRef(
  db: DbOrTx,
  refs: readonly TagRef[],
): Promise<PublicEventTag[]> {
  if (!refs.length) return [];
  return db
    .select({ kind: tag.kind, slug: tag.slug, name: tag.name })
    .from(tag)
    .where(or(...refs.map((r) => and(eq(tag.kind, r.kind), eq(tag.slug, r.slug)))));
}

export interface PublicEventSourceLink {
  sourceId: SourceId;
  sourceName: string;
  sourceKind: SourceKind;
  url: string;
  isPrimary: boolean;
}

export interface PublicEventDetail extends Omit<PublicEventListItem, 'tags' | 'venueName'> {
  venue: { name: string; city: string; address: string | null } | null;
  tags: PublicEventTag[];
  /** 主要來源排第一 */
  sources: PublicEventSourceLink[];
  updatedAt: Date;
}

/** 前台詳情：只回傳已發布或已結束的活動；其它狀態視為不存在。 */
export async function getPublicEvent(db: DbOrTx, id: number): Promise<PublicEventDetail | null> {
  const [row] = await db
    .select({
      id: event.id,
      title: event.title,
      type: event.type,
      status: event.status,
      startAt: event.startAt,
      endAt: event.endAt,
      allDay: event.allDay,
      isOnline: event.isOnline,
      city: event.city,
      region: event.region,
      priceMin: event.priceMin,
      priceMax: event.priceMax,
      isFree: event.isFree,
      saleStartAt: event.saleStartAt,
      updatedAt: event.updatedAt,
      venueName: venue.name,
      venueCity: venue.city,
      venueAddress: venue.address,
      tags: tagsJson,
    })
    .from(event)
    .leftJoin(venue, eq(venue.id, event.venueId))
    .where(and(eq(event.id, id), inArray(event.status, ['published', 'ended'])));
  if (!row) return null;

  const sources = await db
    .select({
      sourceId: sourceItem.sourceId,
      sourceName: source.name,
      sourceKind: source.kind,
      url: eventSource.url,
      isPrimary: eventSource.isPrimary,
    })
    .from(eventSource)
    .innerJoin(sourceItem, eq(sourceItem.id, eventSource.sourceItemId))
    .innerJoin(source, eq(source.id, sourceItem.sourceId))
    .where(eq(eventSource.eventId, id))
    .orderBy(desc(eventSource.isPrimary), asc(sourceItem.id));

  const { venueName, venueCity, venueAddress, ...rest } = row;
  return {
    ...rest,
    venue:
      venueName && venueCity ? { name: venueName, city: venueCity, address: venueAddress } : null,
    sources,
  };
}
