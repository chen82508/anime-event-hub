/**
 * 月曆檢視（純函式）：月份格線與「活動 → 台灣日期」對應。
 * 週日為一週第一天（台灣常見月曆排法）。
 */
import { addDays, monthBounds, taipeiIsoDate } from './filters';

export interface CalendarCell {
  date: string;
  day: number;
  inMonth: boolean;
}

export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const;

function weekday(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 回傳整週對齊的格線（含前後月份補位），每列 7 格 */
export function buildMonthGrid(month: string): CalendarCell[][] {
  const { start, endExclusive } = monthBounds(month);
  let cursor = addDays(start, -weekday(start));
  const weeks: CalendarCell[][] = [];
  while (cursor < endExclusive) {
    const week: CalendarCell[] = [];
    for (let i = 0; i < 7; i++) {
      week.push({ date: cursor, day: Number(cursor.slice(8)), inMonth: cursor.startsWith(month) });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

interface Timed {
  startAt: Date | null;
  endAt: Date | null;
}

/** 活動涵蓋的台灣日期 [first, last]（含）；結束早於開始時視為單日 */
export function eventDateSpan(e: Timed): { first: string; last: string } | null {
  if (!e.startAt) return null;
  const first = taipeiIsoDate(e.startAt);
  const last = e.endAt ? taipeiIsoDate(e.endAt) : first;
  return { first, last: last < first ? first : last };
}

/** 每個本月日期 → 當天進行中的活動（保留輸入順序） */
export function eventsByDay<E extends Timed>(
  events: readonly E[],
  month: string,
): Map<string, E[]> {
  const { start, endExclusive } = monthBounds(month);
  const map = new Map<string, E[]>();
  for (const e of events) {
    const span = eventDateSpan(e);
    if (!span) continue;
    let d = span.first < start ? start : span.first;
    while (d <= span.last && d < endExclusive) {
      const list = map.get(d);
      if (list) list.push(e);
      else map.set(d, [e]);
      d = addDays(d, 1);
    }
  }
  return map;
}

/**
 * 行動版議程：本月開始的活動依開始日分組；本月以前開始、仍跨入本月者另列「進行中」。
 * 避免長期展覽在議程中每天重複出現。
 */
export function agendaForMonth<E extends Timed>(
  events: readonly E[],
  month: string,
): { ongoing: E[]; days: { date: string; events: E[] }[] } {
  const { start } = monthBounds(month);
  const ongoing: E[] = [];
  const byDay = new Map<string, E[]>();
  for (const e of events) {
    const span = eventDateSpan(e);
    if (!span) continue;
    if (span.first < start) {
      ongoing.push(e);
      continue;
    }
    const list = byDay.get(span.first);
    if (list) list.push(e);
    else byDay.set(span.first, [e]);
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, evs]) => ({ date, events: evs }));
  return { ongoing, days };
}
