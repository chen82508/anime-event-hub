import { describe, expect, it } from 'vitest';
import { agendaForMonth, buildMonthGrid, eventsByDay } from '../src/lib/public/calendar';
import {
  activeFilterCount,
  parseDiscoveryQuery,
  resolveRange,
  shiftMonth,
  toSearchString,
} from '../src/lib/public/filters';
import { formatEventWhen, formatPlace, formatPrice, saleState } from '../src/lib/public/format';

const NOW = new Date('2026-11-18T04:00:00Z'); // 台灣 2026-11-18 12:00

describe('parseDiscoveryQuery', () => {
  it('忽略無效值、依 enum 順序輸出、去除重複標籤', () => {
    const q = parseDiscoveryQuery({
      view: 'calendar',
      region: ['south', 'mars', 'north'],
      type: 'doujin,concert',
      tag: ['work:bocchi', 'work:bocchi', 'nope:x', 'agency:Muse!'],
      q: '  孤獨搖滾 ',
      from: '2026-02-30',
      to: '2026-12-31',
      sale: 'maybe',
      month: '2026-13',
    });
    expect(q).toEqual({
      view: 'calendar',
      regions: ['north', 'south'],
      types: ['concert', 'doujin'],
      tags: [{ kind: 'work', slug: 'bocchi' }],
      q: '孤獨搖滾',
      from: null,
      to: '2026-12-31',
      sale: null,
      month: null,
    });
  });

  it('起訖顛倒時對調', () => {
    const q = parseDiscoveryQuery({ from: '2026-12-31', to: '2026-12-01' });
    expect([q.from, q.to]).toEqual(['2026-12-01', '2026-12-31']);
  });

  it('toSearchString 與 parse 互為反函式，並省略預設值', () => {
    const sp = '?q=LIVE&region=north&type=concert&tag=work%3Abocchi&from=2026-12-01&sale=on_sale';
    const q = parseDiscoveryQuery(Object.fromEntries(new URLSearchParams(sp)));
    // URLSearchParams → Object 只保留最後一個同名參數，這裡每個鍵只有一個值
    expect(toSearchString(q)).toBe(sp);
    expect(toSearchString(parseDiscoveryQuery({}))).toBe('');
    expect(toSearchString(q, { regions: [], q: '' })).not.toContain('region');
    expect(activeFilterCount(q)).toBe(6);
  });

  it('month 只在月曆檢視保留', () => {
    const q = parseDiscoveryQuery({ view: 'calendar', month: '2026-12' });
    expect(toSearchString(q)).toBe('?view=calendar&month=2026-12');
    expect(toSearchString(q, { view: 'list' })).toBe('');
  });
});

describe('resolveRange', () => {
  it('列表預設從現在開始；迄日含當天（台灣時間）', () => {
    const r = resolveRange(parseDiscoveryQuery({ to: '2026-12-31' }), NOW);
    expect(r.from).toEqual(NOW);
    expect(r.to?.toISOString()).toBe('2026-12-31T16:00:00.000Z');
    expect(r.includeEnded).toBe(false);
  });

  it('月曆預設本月，與使用者區間取交集', () => {
    const r = resolveRange(parseDiscoveryQuery({ view: 'calendar' }), NOW);
    expect(r.month).toBe('2026-11');
    expect(r.from.toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(r.to?.toISOString()).toBe('2026-11-30T16:00:00.000Z');
    const r2 = resolveRange(
      parseDiscoveryQuery({ view: 'calendar', month: '2026-12', from: '2026-12-10' }),
      NOW,
    );
    expect(r2.from.toISOString()).toBe('2026-12-09T16:00:00.000Z');
  });

  it('shiftMonth 跨年', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });
});

describe('calendar', () => {
  it('格線以週日開始並補滿整週', () => {
    const g = buildMonthGrid('2026-11'); // 2026-11-01 為週日
    expect(g[0]![0]).toEqual({ date: '2026-11-01', day: 1, inMonth: true });
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g.at(-1)!.at(-1)!.date).toBe('2026-12-05');
    const dec = buildMonthGrid('2026-12'); // 12/1 為週二
    expect(dec[0]![0]!.date).toBe('2026-11-29');
  });

  const ev = (id: number, start: string, end: string | null = null) => ({
    id,
    startAt: new Date(start),
    endAt: end ? new Date(end) : null,
  });

  it('多日活動出現在每一天；以台灣日期計算', () => {
    const events = [
      ev(1, '2026-11-28T16:30:00Z'), // 台灣 11/29 00:30
      ev(2, '2026-10-20T02:00:00Z', '2026-11-02T15:59:59Z'), // 跨月長期展
    ];
    const map = eventsByDay(events, '2026-11');
    expect(map.get('2026-11-29')?.map((e) => e.id)).toEqual([1]);
    expect(map.get('2026-11-28')).toBeUndefined();
    expect(map.get('2026-11-01')?.map((e) => e.id)).toEqual([2]);
    expect(map.get('2026-11-02')?.map((e) => e.id)).toEqual([2]);
    expect(map.get('2026-11-03')).toBeUndefined();

    const agenda = agendaForMonth(events, '2026-11');
    expect(agenda.ongoing.map((e) => e.id)).toEqual([2]);
    expect(agenda.days).toEqual([{ date: '2026-11-29', events: [events[0]] }]);
  });
});

describe('format', () => {
  it('活動時間', () => {
    const s = new Date('2026-12-12T11:00:00Z');
    expect(formatEventWhen(s, null, false)).toBe('2026/12/12（六） 19:00');
    expect(formatEventWhen(s, null, false, { now: NOW, compact: true })).toBe('12/12（六） 19:00');
    expect(
      formatEventWhen(new Date('2026-12-11T16:00:00Z'), new Date('2026-12-13T15:59:59Z'), true),
    ).toBe('2026/12/12（六） – 12/13（日）');
    expect(
      formatEventWhen(new Date('2026-12-30T16:00:00Z'), new Date('2027-01-02T15:59:59Z'), true),
    ).toBe('2026/12/31（四） – 2027/1/2（六）');
    expect(formatEventWhen(null, null, false)).toBe('時間未定');
  });

  it('票價', () => {
    expect(formatPrice(2600, 6400, false)).toBe('NT$2,600 ～ 6,400');
    expect(formatPrice(200, 200, false)).toBe('NT$200');
    expect(formatPrice(0, 800, false)).toBe('免費 ～ NT$800');
    expect(formatPrice(null, null, true)).toBe('免費');
    expect(formatPrice(null, null, false)).toBe('票價未公布');
  });

  it('開賣狀態不猜測', () => {
    expect(saleState(null, NOW).state).toBe('unknown');
    expect(saleState(new Date('2026-11-01T00:00:00Z'), NOW).state).toBe('on_sale');
    expect(saleState(new Date('2026-11-20T04:00:00Z'), NOW)).toMatchObject({
      state: 'upcoming',
      label: '11/20（五） 12:00 開賣',
    });
  });

  it('地點', () => {
    expect(formatPlace({ isOnline: true, venueName: null, city: null })).toBe('線上活動');
    expect(formatPlace({ isOnline: false, venueName: '台北小巨蛋', city: '台北市' })).toBe(
      '台北小巨蛋（台北市）',
    );
    expect(formatPlace({ isOnline: false, venueName: '高雄展覽館', city: '高雄市' })).toBe(
      '高雄展覽館（高雄市）',
    );
  });
});
