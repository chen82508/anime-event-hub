import type { RawEventCandidate } from '@aeh/core';
import { describe, expect, it } from 'vitest';
import { tagger, venueResolver } from '../../test/context';
import { normalizeCandidate } from './validate';

const base: RawEventCandidate = {
  sourceId: 'kktix',
  externalId: '1',
  url: 'https://example.kktix.cc/events/1',
  title: '某某 演唱會',
};
const run = (
  c: Partial<RawEventCandidate>,
  scale?: { kktixMinPriceMax: number | null; kktixTagPasses: boolean },
) =>
  normalizeCandidate(
    { ...base, ...c },
    { venues: venueResolver, tagger, fetchedOn: '2026-11-18', ...(scale ? { scale } : {}) },
  );

describe('必要欄位驗證（§4.2 / C4）', () => {
  it('齊全 → published', () => {
    const r = run({ dateText: '2026/12/20 19:00', venueText: '台北小巨蛋' });
    expect(r.status).toBe('published');
    expect(r.event.reviewReasons).toEqual([]);
  });

  it('缺日期 → missing_date；日期無法判定 → ambiguous_date（附說明）', () => {
    expect(run({ venueText: '台北小巨蛋' }).event.reviewReasons).toEqual(['missing_date']);
    const r = run({ dateText: '12/20、12/27', venueText: '台北小巨蛋' });
    expect(r.event.reviewReasons).toEqual(['ambiguous_date']);
    expect(r.notes.some((n) => n.includes('不連續'))).toBe(true);
    expect(r.status).toBe('pending_review');
  });

  it('海外的線上活動 → outside_taiwan（H2 / C6）', () => {
    const r = run({
      title: '某聲優 線上見面會',
      dateText: '2026/12/20 19:00',
      venueText: '東京 オンライン配信',
    });
    expect(r.status).toBe('pending_review');
    expect(r.event.reviewReasons).toContain('outside_taiwan');
  });

  it('無法確認台灣主辦/售票的來源，線上活動進待審（C6）', () => {
    const r = normalizeCandidate(
      {
        ...base,
        sourceId: 'mightymedia',
        title: '某作品 線上見面會',
        dateText: '2026/12/20 19:00',
        isOnline: true,
      },
      { venues: venueResolver, tagger, fetchedOn: '2026-11-18' },
    );
    expect(r.event.reviewReasons).toEqual(['outside_taiwan']);
    expect(r.notes.some((n) => n.includes('C6'))).toBe(true);
  });

  it('缺場館且非線上 → missing_venue；線上 → 不需場館', () => {
    expect(run({ dateText: '2026/12/20' }).event.reviewReasons).toEqual([
      'missing_venue',
      'below_scale_threshold',
    ]);
    const online = run({ dateText: '2026/12/20', isOnline: true });
    expect(online.event).toMatchObject({ isOnline: true, region: 'online', reviewReasons: [] });
  });

  it('類型無法判定 → type_unresolved', () => {
    expect(
      run({ title: '某某 15 週年', dateText: '2026/12/20', venueText: '台北小巨蛋' }).event
        .reviewReasons,
    ).toEqual(['type_unresolved']);
  });

  it('KKTIX 規模門檻：未知場館但票價達門檻 → 不標；門檻可設定', () => {
    const c = { dateText: '2026/12/20', venueText: '某 Live House 台北', priceText: 'NT$1,800' };
    expect(run(c).event.reviewReasons).toEqual(['unknown_venue']);
    expect(run(c, { kktixMinPriceMax: 2000, kktixTagPasses: true }).event.reviewReasons).toEqual([
      'unknown_venue',
      'below_scale_threshold',
    ]);
  });

  it('KKTIX 規模門檻：未知場館但命中作品/聲優/歌手標籤 → 不標（M5）；可關閉', () => {
    const c = { title: '孤獨搖滾 演唱會', dateText: '2026/12/20', venueText: '某 Live House 台北' };
    expect(run(c).event.reviewReasons).toEqual(['unknown_venue']);
    expect(run(c, { kktixMinPriceMax: null, kktixTagPasses: false }).event.reviewReasons).toEqual([
      'unknown_venue',
      'below_scale_threshold',
    ]);
  });

  it('結構化資料優先於文字', () => {
    const r = run({
      dateText: '亂寫的日期',
      structured: { startAt: '2026-12-20T19:00:00+08:00', priceMin: 800, priceMax: 1500 },
      venueText: '台北小巨蛋',
    });
    expect(r.event.startAt?.toISOString()).toBe('2026-12-20T11:00:00.000Z');
    expect([r.event.priceMin, r.event.priceMax]).toEqual([800, 1500]);
  });

  it('缺年份時以公告日推論（R2）', () => {
    const r = run({ dateText: '1/10', venueText: '台北小巨蛋', publishedOn: '2026-12-15' });
    expect(r.event.startAt?.toISOString()).toBe('2027-01-09T16:00:00.000Z');
    expect(r.event.yearInferred).toBe(true);
  });

  it('標題正規化與原文保留', () => {
    const r = run({
      title: '【公告】ＬｉＳＡ 演唱會',
      dateText: '2026/12/20',
      venueText: '台北小巨蛋',
    });
    expect(r.event.title).toBe('【公告】ＬｉＳＡ 演唱會');
    expect(r.event.titleNormalized).toBe('lisa 演唱會');
  });

  it('同一輸入必得同一輸出', () => {
    const c = { dateText: '11/21(六)、11/22(日)', venueText: '花博爭艷館' };
    expect(run(c)).toEqual(run(c));
  });
});
