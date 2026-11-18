import { describe, expect, it } from 'vitest';
import { fixture, tagger, venueResolver, venueSlug } from '../../test/context';
import { normalizeCandidate } from '../_shared/validate';
import { createKktixScraper, parseKktixAtom, parseKktixTime } from './index';

const ctx = { fetchedOn: '2026-11-18' };
const items = parseKktixAtom(
  fixture('kktix', 'search-2026-11-18.atom'),
  'https://kktix.com/events.atom',
  ctx,
);
const byId = (id: string) => items.find((i) => i.externalId === id)?.candidate;
const norm = (id: string) =>
  normalizeCandidate(byId(id)!, { venues: venueResolver, tagger, fetchedOn: ctx.fetchedOn });

describe('KKTIX Atom（真實快照 2026-11-18）', () => {
  it('解析所有 entry，external_id 取自 Event/<id>（不依賴順序）', () => {
    expect(items).toHaveLength(14);
    expect(items.every((i) => /^\d+$/.test(i.externalId))).toBe(true);
    expect(new Set(items.map((i) => i.externalId)).size).toBe(14);
  });

  it('時間轉成帶時區的結構化資料；地點拆成場館與地址', () => {
    const c = items.find((i) => i.candidate?.title.startsWith('乃紫'))?.candidate;
    expect(c).toMatchObject({
      sourceId: 'kktix',
      structured: { startAt: '2026-12-20T18:00:00+08:00' },
      venueText: 'Legacy Taipei',
      addressText: expect.stringContaining('台北市中正區八德路一段1號'),
      publishedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(c?.url).toMatch(/^https:\/\/.+\.kktix\.cc\/events\//);
  });

  it('正規化：字典內場館 → 自動發布；未知場館 → 待審並附規模門檻', () => {
    const noa = items.find((i) => i.candidate?.title.startsWith('乃紫'))!;
    const r1 = norm(noa.externalId);
    expect(r1.status).toBe('published');
    expect(venueSlug(r1.event.venueId)).toBe('legacy-taipei');
    expect(r1.event.type).toBe('concert');

    const shop = items.find((i) => i.candidate?.title.includes('Uki Violeta'))!;
    const r2 = norm(shop.externalId);
    expect(r2.status).toBe('pending_review');
    expect(r2.event.reviewReasons).toEqual(['unknown_venue', 'below_scale_threshold']);
    expect(r2.event.city).toBe('台北市');
  });

  it('海外活動 → outside_taiwan', () => {
    const tokyo = items.find((i) => i.candidate?.title.startsWith('【東京】'))!;
    expect(norm(tokyo.externalId).event.reviewReasons).toContain('outside_taiwan');
  });

  it('同一演唱會的多個票種頁面 → 正規化後日期、場館相同（交給 dedup 合併）', () => {
    const eir = items
      .filter((i) => i.candidate?.title.includes('EIR AOI'))
      .map((i) => norm(i.externalId).event);
    expect(eir).toHaveLength(3);
    expect(new Set(eir.map((e) => `${e.startAt?.toISOString()}|${e.venueId}`)).size).toBe(1);
  });
});

describe('parseKktixTime', () => {
  it.each([
    ['2026/12/20 18:00(+0800)', { startAt: '2026-12-20T18:00:00+08:00' }],
    [
      '2026/10/29 12:00(+0800) ~ 2027/02/14 20:00(+0800)',
      { startAt: '2026-10-29T12:00:00+08:00', endAt: '2027-02-14T20:00:00+08:00' },
    ],
    [
      '2026/12/05 18:30(+0800)~21:30',
      { startAt: '2026-12-05T18:30:00+08:00', endAt: '2026-12-05T21:30:00+08:00' },
    ],
  ])('%s', (s, expected) => expect(parseKktixTime(s)).toEqual(expected));
  it('格式不符 → null', () => expect(parseKktixTime('2026/12/20')).toBeNull());
});

describe('createKktixScraper', () => {
  it('關鍵字設定化', () => {
    expect(createKktixScraper(['聲優']).listUrls()).toEqual([
      'https://kktix.com/events.atom?search=%E8%81%B2%E5%84%AA',
    ]);
  });
});
