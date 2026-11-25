/**
 * 前台篩選條件 ⇄ URL search params（純函式）。
 *
 * 篩選狀態全部放在 URL：可分享、可上一頁、伺服器端直接渲染，不需要 client state。
 * 無效值一律忽略（不報錯），讓舊連結或手改網址也能正常瀏覽。
 */
import {
  EVENT_TYPES,
  REGIONS,
  TAG_KINDS,
  taipeiIsoDate,
  type EventType,
  type Region,
  type TagKind,
} from '@aeh/core';

export const VIEWS = ['list', 'calendar'] as const;
export type View = (typeof VIEWS)[number];

export const SALE_OPTIONS = ['on_sale', 'upcoming'] as const;
export type SaleOption = (typeof SALE_OPTIONS)[number];

export const SALE_LABEL: Record<SaleOption, string> = {
  on_sale: '已開賣',
  upcoming: '尚未開賣',
};

export interface TagParam {
  kind: TagKind;
  slug: string;
}

export interface DiscoveryQuery {
  view: View;
  regions: Region[];
  types: EventType[];
  tags: TagParam[];
  q: string;
  /** 台灣日期 YYYY-MM-DD（含） */
  from: string | null;
  /** 台灣日期 YYYY-MM-DD（含） */
  to: string | null;
  sale: SaleOption | null;
  /** 月曆檢視的月份 YYYY-MM */
  month: string | null;
}

export type SearchParamsRecord = Record<string, string | string[] | undefined>;

const MAX_Q_LENGTH = 100;
const MAX_MULTI = 30;

function all(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  // 同時支援 ?region=north&region=south 與 ?region=north,south
  return (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(',')).map((s) => s.trim());
}
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
function pick<T extends string>(values: readonly T[], input: string[]): T[] {
  const set = new Set(input);
  // 依 enum 順序輸出，讓 URL 與畫面穩定
  return values.filter((v) => set.has(v));
}

/** YYYY-MM-DD 且為真實存在的日期 */
export function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

export function isValidMonth(s: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

const TAG_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function parseTagParam(s: string): TagParam | null {
  const i = s.indexOf(':');
  if (i < 0) return null;
  const kind = s.slice(0, i) as TagKind;
  const slug = s.slice(i + 1);
  if (!TAG_KINDS.includes(kind) || !TAG_SLUG_RE.test(slug)) return null;
  return { kind, slug };
}

export const tagParamKey = (t: TagParam) => `${t.kind}:${t.slug}`;

export function parseDiscoveryQuery(sp: SearchParamsRecord): DiscoveryQuery {
  const view = first(sp.view);
  const sale = first(sp.sale);
  const from = first(sp.from)?.trim() ?? '';
  const to = first(sp.to)?.trim() ?? '';
  const month = first(sp.month)?.trim() ?? '';

  const seen = new Set<string>();
  const tags: TagParam[] = [];
  for (const raw of all(sp.tag)) {
    const t = parseTagParam(raw);
    if (t && !seen.has(tagParamKey(t)) && tags.length < MAX_MULTI) {
      seen.add(tagParamKey(t));
      tags.push(t);
    }
  }

  let validFrom = isValidIsoDate(from) ? from : null;
  let validTo = isValidIsoDate(to) ? to : null;
  // 起訖顛倒時自動對調，而不是回傳 0 筆
  if (validFrom && validTo && validFrom > validTo) [validFrom, validTo] = [validTo, validFrom];

  return {
    view: VIEWS.includes(view as View) ? (view as View) : 'list',
    regions: pick(REGIONS, all(sp.region)),
    types: pick(EVENT_TYPES, all(sp.type)),
    tags,
    q: (first(sp.q) ?? '').trim().slice(0, MAX_Q_LENGTH),
    from: validFrom,
    to: validTo,
    sale: SALE_OPTIONS.includes(sale as SaleOption) ? (sale as SaleOption) : null,
    month: isValidMonth(month) ? month : null,
  };
}

/** DiscoveryQuery → 查詢字串（省略預設值），供連結與「移除此條件」使用 */
export function toSearchString(q: DiscoveryQuery, overrides: Partial<DiscoveryQuery> = {}): string {
  const m = { ...q, ...overrides };
  const u = new URLSearchParams();
  if (m.view !== 'list') u.set('view', m.view);
  if (m.q) u.set('q', m.q);
  for (const r of m.regions) u.append('region', r);
  for (const t of m.types) u.append('type', t);
  for (const t of m.tags) u.append('tag', tagParamKey(t));
  if (m.from) u.set('from', m.from);
  if (m.to) u.set('to', m.to);
  if (m.sale) u.set('sale', m.sale);
  if (m.view === 'calendar' && m.month) u.set('month', m.month);
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** 篩選條件數（不含檢視方式與月份），用於「篩選（3）」按鈕 */
export function activeFilterCount(q: DiscoveryQuery): number {
  return (
    q.regions.length +
    q.types.length +
    q.tags.length +
    (q.q ? 1 : 0) +
    (q.from || q.to ? 1 : 0) +
    (q.sale ? 1 : 0)
  );
}

// ── 台灣時間的日期邊界 ────────────────────────────────────

/** 台灣日期 YYYY-MM-DD 的 00:00（+08:00）。輸入須已通過 isValidIsoDate。 */
export function taipeiStartOfDay(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00+08:00`);
}

/** 加天數（以 UTC 日曆計算，不受執行環境時區影響） */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 某時間點的台灣日期 YYYY-MM-DD（共用 @aeh/core） */
export { taipeiIsoDate };

// ── 快速日期區間（「本週末」等捷徑） ─────────────────────────

export const DATE_PRESETS = ['today', 'weekend', 'next30'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const DATE_PRESET_LABEL: Record<DatePreset, string> = {
  today: '今天',
  weekend: '本週末',
  next30: '30 天內',
};

/**
 * 捷徑 → 台灣日期區間（含頭尾）。
 * 週末：週一～五 → 這週六日；週六 → 今明兩天；週日 → 只有今天。
 */
export function datePresetRange(preset: DatePreset, now: Date): { from: string; to: string } {
  const today = taipeiIsoDate(now);
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'next30') return { from: today, to: addDays(today, 29) };
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 0) return { from: today, to: today };
  const sat = addDays(today, 6 - wd);
  return { from: wd === 6 ? today : sat, to: addDays(sat, 1) };
}

/** 目前的 from/to 是否正好等於某個捷徑（用於標示「已選」） */
export function activeDatePreset(q: DiscoveryQuery, now: Date): DatePreset | null {
  if (!q.from || !q.to) return null;
  for (const p of DATE_PRESETS) {
    const r = datePresetRange(p, now);
    if (r.from === q.from && r.to === q.to) return p;
  }
  return null;
}

export function monthBounds(month: string): { start: string; endExclusive: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { start: `${month}-01`, endExclusive: next };
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/**
 * 將 URL 條件轉成查詢區間。
 * - 列表：未指定起日時從「現在」開始（只顯示未結束活動）。
 * - 月曆：月份範圍與使用者指定區間取交集，並包含本月已結束的活動。
 */
export function resolveRange(
  q: DiscoveryQuery,
  now: Date,
): { from: Date; to: Date | undefined; month: string | null; includeEnded: boolean } {
  const userFrom = q.from ? taipeiStartOfDay(q.from) : null;
  const userTo = q.to ? taipeiStartOfDay(addDays(q.to, 1)) : null;
  if (q.view === 'calendar') {
    const month = q.month ?? (q.from ? q.from.slice(0, 7) : taipeiIsoDate(now).slice(0, 7));
    const b = monthBounds(month);
    const mStart = taipeiStartOfDay(b.start);
    const mEnd = taipeiStartOfDay(b.endExclusive);
    return {
      from: userFrom && userFrom > mStart ? userFrom : mStart,
      to: userTo && userTo < mEnd ? userTo : mEnd,
      month,
      includeEnded: true,
    };
  }
  return { from: userFrom ?? now, to: userTo ?? undefined, month: null, includeEnded: false };
}
