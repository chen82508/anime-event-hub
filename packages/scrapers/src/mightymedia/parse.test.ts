import { describe, expect, it } from 'vitest';
import { fixture, tagger, venueResolver } from '../../test/context';
import { normalizeCandidate } from '../_shared/validate';
import { parseMightyMediaFeed } from './index';

const ctx = { fetchedOn: '2026-11-18' };
const items = parseMightyMediaFeed(
  fixture('mightymedia', 'blog-feed-2026-11-18.xml'),
  'https://www.mightymedia.com.tw/blog-feed.xml',
  ctx,
);
const find = (s: string) => items.find((i) => i.candidate?.title.includes(s))!;
const norm = (s: string) =>
  normalizeCandidate(find(s).candidate!, { venues: venueResolver, tagger, ...ctx });

describe('曼迪 Mighty Media RSS（真實快照 2026-11-18）', () => {
  it('非「活動」分類記錄略過原因', () => {
    const skipped = items.filter((i) => i.candidate === null);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((i) => i.skipReason?.startsWith('非活動'))).toBe(true);
  });

  it('external_id 為 RSS guid；發布日由 pubDate 轉台灣日期', () => {
    const it0 = find('San-X 90週年');
    expect(it0.externalId).toMatch(/^[0-9a-f]{24}$/);
    expect(it0.candidate?.publishedOn).toBe('2026-11-05');
  });

  it('HTML 實體解碼（Wix 在 CDATA 內多編碼一次）', () => {
    expect(find('高雄動漫節').candidate?.title).toContain('&福袋');
  });

  it('低結構：日期取自標題、場館不在字典 → 待審；香港場 → outside_taiwan；來源推論代理商標籤', () => {
    const sanx = norm('San-X 90週年');
    expect(sanx.event.startAt?.toISOString()).toBe('2026-12-27T16:00:00.000Z');
    expect(sanx.status).toBe('pending_review');
    expect(sanx.event.reviewReasons).toContain('unknown_venue');
    expect(sanx.event.city).toBe('高雄市');
    expect(sanx.tags.map((t) => t.tag.slug)).toContain('mighty-media');

    const hk = norm('11/13香港啟德SOGO');
    expect(hk.event.reviewReasons).toContain('outside_taiwan');
    expect(hk.tags.map((t) => t.tag.slug)).toEqual(['mighty-media', 'bocchi-the-rock']);
  });

  it('標題中重複的同一日期視為單一日期', () => {
    expect(norm('11/1南部首亮相').event.startAt?.toISOString()).toBe('2026-10-31T16:00:00.000Z');
  });
});
