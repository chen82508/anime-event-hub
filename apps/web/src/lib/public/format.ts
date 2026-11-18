/** 前台顯示格式（純函式；時區固定台灣） */
import { TIMEZONE } from '@aeh/core';
import { taipeiIsoDate } from './filters';

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'] as const;

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function parts(at: Date) {
  const iso = taipeiIsoDate(at);
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const wd = WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  return { iso, y, m, d, wd };
}

/** 12/12（六） */
export function formatMonthDay(at: Date): string {
  const p = parts(at);
  return `${p.m}/${p.d}（${p.wd}）`;
}

/** 2026/12/12（六） */
export function formatFullDate(at: Date): string {
  const p = parts(at);
  return `${p.y}/${p.m}/${p.d}（${p.wd}）`;
}

export function formatTime(at: Date): string {
  return timeFmt.format(at);
}

/**
 * 活動時間：
 * - 單日：2026/12/12（六）19:00；全天則不顯示時刻
 * - 多日：2026/12/12（六）– 12/13（日）；跨年時結束日也帶年份
 * `now` 用於決定是否省略當年年份（列表較精簡）。
 */
export function formatEventWhen(
  startAt: Date | null,
  endAt: Date | null,
  allDay: boolean,
  opts: { now?: Date; compact?: boolean } = {},
): string {
  if (!startAt) return '時間未定';
  const s = parts(startAt);
  const showYear = !opts.compact || !opts.now || s.y !== parts(opts.now).y;
  const startDate = showYear ? `${s.y}/${s.m}/${s.d}（${s.wd}）` : `${s.m}/${s.d}（${s.wd}）`;
  const e = endAt ? parts(endAt) : null;
  if (!e || e.iso === s.iso) {
    const time = allDay ? '' : ` ${formatTime(startAt)}`;
    const endTime = !allDay && endAt && e?.iso === s.iso ? `–${formatTime(endAt)}` : '';
    return `${startDate}${time}${endTime}`;
  }
  const endDate = e.y !== s.y ? `${e.y}/${e.m}/${e.d}（${e.wd}）` : `${e.m}/${e.d}（${e.wd}）`;
  return allDay
    ? `${startDate} – ${endDate}`
    : `${startDate} ${formatTime(startAt)} – ${endDate} ${formatTime(endAt!)}`;
}

const nt = new Intl.NumberFormat('zh-TW');

/**
 * 票價區間：
 * - 免費且無付費票種 → 免費
 * - 免費入場＋付費票種（min = 0、isFree = false）→ 免費 ～ NT$800
 * - 未提供 → 票價未公布
 */
export function formatPrice(
  priceMin: number | null,
  priceMax: number | null,
  isFree: boolean,
): string {
  if (isFree && !priceMax) return '免費';
  if (priceMin === null && priceMax === null) return '票價未公布';
  const lo = priceMin ?? priceMax!;
  const hi = priceMax ?? priceMin!;
  const fmt = (n: number) => (n === 0 ? '免費' : `NT$${nt.format(n)}`);
  if (lo === hi) return fmt(lo);
  return `${fmt(lo)} ～ ${lo === 0 ? `NT$${nt.format(hi)}` : nt.format(hi)}`;
}

export type SaleState =
  | { state: 'on_sale'; label: string }
  | { state: 'upcoming'; label: string; at: Date }
  | { state: 'unknown'; label: string };

/** 開賣狀態；開賣時間未提供時不猜測 */
export function saleState(saleStartAt: Date | null, now: Date): SaleState {
  if (!saleStartAt) return { state: 'unknown', label: '開賣時間請見官方公告' };
  if (saleStartAt.getTime() <= now.getTime()) return { state: 'on_sale', label: '已開賣' };
  return {
    state: 'upcoming',
    label: `${formatMonthDay(saleStartAt)} ${formatTime(saleStartAt)} 開賣`,
    at: saleStartAt,
  };
}

/** 活動是否已結束（同 DB markEndedEvents：無結束時間者以開始後一天計） */
export function hasEnded(startAt: Date | null, endAt: Date | null, now: Date): boolean {
  if (!startAt) return false;
  const end = endAt ?? new Date(startAt.getTime() + 86_400_000);
  return end.getTime() < now.getTime();
}

/** 地點顯示：場館（縣市）／線上 */
export function formatPlace(e: {
  isOnline: boolean;
  venueName: string | null;
  city: string | null;
}): string {
  if (e.isOnline && !e.venueName) return '線上活動';
  const place = [
    e.venueName,
    e.city && e.venueName && !e.venueName.includes(e.city) ? `（${e.city}）` : '',
  ]
    .filter(Boolean)
    .join('');
  return place || e.city || '地點未定';
}
