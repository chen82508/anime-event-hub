import { describe, expect, it } from 'vitest';
import {
  formatEventWhen,
  formatFullDate,
  formatMonthDay,
  formatPlace,
  formatPrice,
  formatTime,
  hasEnded,
  taipeiIsoDate,
} from '../src';

const tw = (s: string) => new Date(`${s}+08:00`);

describe('format（前台與推播模板共用）', () => {
  it('台灣日期與時刻不受執行環境時區影響', () => {
    // UTC 16:30 = 台灣隔天 00:30
    expect(taipeiIsoDate(new Date('2026-12-11T16:30:00Z'))).toBe('2026-12-12');
    expect(formatTime(new Date('2026-12-11T16:30:00Z'))).toBe('00:30');
    expect(formatMonthDay(tw('2026-12-12T10:00:00'))).toBe('12/12（六）');
    expect(formatFullDate(tw('2027-01-01T10:00:00'))).toBe('2027/1/1（五）');
  });

  it('formatEventWhen：單日／多日／跨年／compact', () => {
    const now = tw('2026-11-25T12:00:00');
    expect(formatEventWhen(tw('2026-12-12T19:00:00'), null, false)).toBe('2026/12/12（六） 19:00');
    expect(formatEventWhen(tw('2026-12-12T19:00:00'), null, false, { now, compact: true })).toBe(
      '12/12（六） 19:00',
    );
    expect(
      formatEventWhen(tw('2026-12-31T00:00:00'), tw('2027-01-01T23:59:59'), true, {
        now,
        compact: true,
      }),
    ).toBe('12/31（四） – 2027/1/1（五）');
    expect(formatEventWhen(null, null, false)).toBe('時間未定');
  });

  it('formatPrice／formatPlace／hasEnded', () => {
    expect(formatPrice(0, 800, false)).toBe('免費 ～ NT$800');
    expect(formatPrice(null, null, true)).toBe('免費');
    expect(formatPlace({ isOnline: false, venueName: 'Zepp New Taipei', city: '新北市' })).toBe(
      'Zepp New Taipei（新北市）',
    );
    expect(hasEnded(tw('2026-11-01T10:00:00'), null, tw('2026-11-02T10:00:01'))).toBe(true);
  });
});
