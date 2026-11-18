import { describe, expect, it } from 'vitest';
import { fixture, tagger, venueResolver, venueSlug } from '../../test/context';
import { normalizeCandidate } from '../_shared/validate';
import { museScraper, parseMuseNewsList } from './index';

// ⚠️ 合成樣本：官網無法連線，結構未驗證（見 parse.ts）
const ctx = { fetchedOn: '2026-11-18' };
const items = parseMuseNewsList(
  fixture('muse', 'news-synthetic.html'),
  'https://www.e-muse.com.tw/news',
  ctx,
);

describe('木棉花（合成樣本）', () => {
  it('標示為 synthetic，pipeline 預設不執行', () => {
    expect(museScraper.fixtureStatus).toBe('synthetic');
  });

  it('商品公告略過；活動解析日期與場館', () => {
    expect(items.map((i) => i.skipReason ?? 'event')).toEqual([
      'event',
      '非活動分類：商品',
      'event',
      'event',
    ]);
    const r = normalizeCandidate(items[0]!.candidate!, { venues: venueResolver, tagger, ...ctx });
    expect(venueSlug(r.event.venueId)).toBe('syntrend');
    expect(r.event.type).toBe('popup_cafe');
    expect(r.tags.map((t) => t.tag.slug)).toEqual(['muse', 'bocchi-the-rock']);
  });

  it('海外巡迴 → outside_taiwan', () => {
    const r = normalizeCandidate(items[3]!.candidate!, { venues: venueResolver, tagger, ...ctx });
    expect(r.event.reviewReasons).toContain('outside_taiwan');
  });
});
