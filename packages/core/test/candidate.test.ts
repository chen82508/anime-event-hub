import { describe, expect, it } from 'vitest';
import { RawEventCandidateSchema } from '../src';

const base = {
  sourceId: 'kktix',
  externalId: 'abc123',
  url: 'https://kktix.com/events/abc123',
  title: 'ぼっち・ざ・ろっく！ 快閃店 in 台北',
};

describe('RawEventCandidateSchema', () => {
  it('接受最小必要欄位，標題保留原文（含日文）', () => {
    const c = RawEventCandidateSchema.parse(base);
    expect(c.title).toBe(base.title);
  });

  it('接受原始文字欄位與結構化欄位', () => {
    const c = RawEventCandidateSchema.parse({
      ...base,
      dateText: '11/16(六)～11/30(日)',
      venueText: '華山1914 東2館',
      priceText: 'NT$1,200 / $800',
      publishedOn: '2026-11-01',
      structured: { startAt: '2026-11-16T11:00:00+08:00', priceMin: 800, priceMax: 1200 },
      typeHint: 'popup_cafe',
    });
    expect(c.structured?.startAt).toBe('2026-11-16T11:00:00+08:00');
  });

  it('會修剪標題前後空白，並拒絕空標題', () => {
    expect(RawEventCandidateSchema.parse({ ...base, title: '  測試  ' }).title).toBe('測試');
    expect(RawEventCandidateSchema.safeParse({ ...base, title: '   ' }).success).toBe(false);
  });

  it.each([
    ['未知來源', { sourceId: 'tixcraft' }],
    ['空 externalId', { externalId: '' }],
    ['非 http(s) URL', { url: 'ftp://example.com/a' }],
    ['無時區的時間（R1）', { structured: { startAt: '2026-11-16T19:30:00' } }],
    ['結構化欄位有未知 key', { structured: { start: '2026-11-16' } }],
    ['負票價', { structured: { priceMin: -1 } }],
    ['小數票價', { structured: { priceMin: 99.5 } }],
    ['非法日期', { publishedOn: '2026-13-01' }],
    ['未知類型', { typeHint: 'live' }],
  ])('拒絕：%s', (_label, patch) => {
    expect(RawEventCandidateSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});
