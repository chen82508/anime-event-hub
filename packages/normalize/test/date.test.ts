import { describe, expect, it } from 'vitest';
import {
  chineseNumeralToInt,
  parseEventDate,
  parseSaleStart,
  taipeiDateString,
  taipeiDateTime,
  type DateParseResult,
} from '../src';
import { loadFixture } from './fixture-loader';

/** 把結果轉成與樣本檔相同的字串格式 */
function render(r: DateParseResult): string {
  if (r.kind !== 'ok') return r.kind;
  const v = r.value;
  let s = v.startDate + (v.startTime ? ` ${v.startTime}` : '');
  if (v.endDate || v.endTime) {
    s += ` ~ ${v.endDate ?? v.startDate}${v.endTime ? ` ${v.endTime}` : ''}`;
  }
  if (v.yearInferred) s += ' *';
  if (v.openStart) s += ' open';
  return s;
}

const { meta, cases } = loadFixture('dates.txt');
const referenceDate = meta.ref as string;

describe('parseEventDate：樣本檔（test/fixtures/dates.txt）', () => {
  it('樣本數 ≥ 60（T4 DoD）', () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
  });

  it.each(cases.map((c) => [`L${c.line} ${c.fields[0]}｜${c.fields[1]}`, c.fields] as const))(
    '%s',
    (_name, [dateText, timeText, expected]) => {
      const r = parseEventDate(dateText, timeText, { referenceDate });
      expect(render(r), r.kind === 'ambiguous' ? r.reason : '').toBe(expected);
    },
  );
});

describe('parseEventDate：時區與輸出（R1）', () => {
  const opts = { referenceDate: '2026-11-01' };

  it('全天活動以台灣日曆日 00:00 為起點，不會變成前一天', () => {
    const r = parseEventDate('2026/11/16', null, opts);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.allDay).toBe(true);
    expect(r.value.startAt.toISOString()).toBe('2026-11-15T16:00:00.000Z');
    expect(taipeiDateString(r.value.startAt)).toBe('2026-11-16');
    expect(r.value.endAt).toBeNull();
  });

  it('有時刻的活動換算成 UTC', () => {
    const r = parseEventDate('2026/11/16 19:30', null, opts);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.value.allDay).toBe(false);
    expect(r.value.startAt.toISOString()).toBe('2026-11-16T11:30:00.000Z');
  });

  it('全天區間的結束為結束日 23:59:59（台灣時間）', () => {
    const r = parseEventDate('11/16-11/20', null, opts);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.value.endAt?.toISOString()).toBe('2026-11-20T15:59:59.000Z');
  });

  it('同一輸入必得同一輸出', () => {
    const a = parseEventDate('11/21(六)、11/22(日) 10:00-18:00', null, opts);
    const b = parseEventDate('11/21(六)、11/22(日) 10:00-18:00', null, opts);
    expect(a).toEqual(b);
  });

  it('跨年公告：12 月發布的 1 月活動推論為隔年（R2）', () => {
    const r = parseEventDate('1/10(日)', null, { referenceDate: '2026-12-15' });
    expect(render(r)).toBe('2027-01-10 *');
  });

  it('公告日在活動期間內：以結束日判斷年份，不會推到隔年', () => {
    const r = parseEventDate('11/1-11/30', null, { referenceDate: '2026-11-18' });
    expect(render(r)).toBe('2026-11-01 ~ 2026-11-30 *');
  });

  it('星期可輔助驗證推論的年份', () => {
    expect(parseEventDate('1/2(六)', null, { referenceDate: '2026-12-01' }).kind).toBe('ok');
    expect(parseEventDate('1/2(五)', null, { referenceDate: '2026-12-01' }).kind).toBe('ambiguous');
  });

  it('maxForwardDays 可設定（預設 240 天）', () => {
    expect(parseEventDate('6/1', null, { referenceDate: '2026-11-01' }).kind).toBe('ok');
    expect(
      parseEventDate('6/1', null, { referenceDate: '2026-11-01', maxForwardDays: 180 }).kind,
    ).toBe('ambiguous');
    expect(
      parseEventDate('8/1', null, { referenceDate: '2026-11-01', maxForwardDays: 300 }).kind,
    ).toBe('ok');
  });

  it('公告日兩個多月後的回顧文不會被推成隔年（M6）', () => {
    expect(parseEventDate('9/1', null, { referenceDate: '2026-11-18' }).kind).toBe('ambiguous');
  });

  it('ambiguous 附上原因', () => {
    const r = parseEventDate('11/21、11/28', null, opts);
    expect(r).toEqual({ kind: 'ambiguous', reason: expect.stringContaining('不連續') });
  });

  it('referenceDate 格式錯誤時拋錯（程式錯誤，不是資料問題）', () => {
    expect(() => parseEventDate('11/16', null, { referenceDate: '2026/11/01' })).toThrow();
  });
});

describe('parseSaleStart', () => {
  const opts = { referenceDate: '2026-10-01' };
  it.each([
    ['10/15(四) 12:00 開賣', '2026-10-15T04:00:00.000Z'],
    ['2026/10/15 中午12點 正式開賣', '2026-10-15T04:00:00.000Z'],
    ['售票期間：10/15 12:00 ~ 11/15 23:59', '2026-10-15T04:00:00.000Z'],
    ['10/15 起售票', '2026-10-14T16:00:00.000Z'],
  ])('%s', (text, iso) => {
    const r = parseSaleStart(text, opts);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.at.toISOString()).toBe(iso);
  });

  it('即日起開賣 → ambiguous（無確切時間）', () => {
    expect(parseSaleStart('即日起至10/31', opts).kind).toBe('ambiguous');
  });
  it('空值 → missing', () => {
    expect(parseSaleStart(undefined, opts).kind).toBe('missing');
  });
});

describe('chineseNumeralToInt', () => {
  it.each([
    ['一', 1],
    ['十', 10],
    ['十一', 11],
    ['二十', 20],
    ['二十一', 21],
    ['廿五', 25],
    ['卅', 30],
    ['三十一', 31],
    ['一一五', 115],
  ])('%s → %i', (s, n) => expect(chineseNumeralToInt(s)).toBe(n));
  it.each(['', '十十', '百', '一十二十'])('%s → null', (s) =>
    expect(chineseNumeralToInt(s)).toBeNull(),
  );
});

describe('taipeiDateTime / taipeiDateString', () => {
  it('台灣時間與 UTC 互轉', () => {
    expect(taipeiDateTime('2026-01-01').toISOString()).toBe('2025-12-31T16:00:00.000Z');
    expect(taipeiDateString(new Date(Date.UTC(2025, 11, 31, 16, 0)))).toBe('2026-01-01');
    expect(taipeiDateString(new Date(Date.UTC(2025, 11, 31, 15, 59)))).toBe('2025-12-31');
  });
});
