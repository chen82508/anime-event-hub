import { describe, expect, it } from 'vitest';
import { fixture, tagger, venueResolver, venueSlug } from '../../test/context';
import { normalizeCandidate } from '../_shared/validate';
import { parseFfHome } from './index';

const ctx = { fetchedOn: '2026-11-18' };
const items = parseFfHome(fixture('ff', 'home-2026-11-18.html'), 'https://www.f-2.com.tw/', ctx);
const norm = (i: number) =>
  normalizeCandidate(items[i]!.candidate!, { venues: venueResolver, tagger, ...ctx });

describe('FF 官網首頁（真實快照 2026-11-18）', () => {
  it('兩個區塊共 5 筆；開拓動漫祭系列標 doujin，其他類型不標', () => {
    expect(items.map((i) => i.candidate?.title)).toEqual([
      '2026 駁二動漫祭-同人誌創作展',
      'Fancy Frontier開拓動漫祭 48',
      'LISANI!TAIPEI 2026',
      'angela Live 2026 〜All About StarChild?!〜 in Taipei',
      'MYTH & ROID Tour 2026-2027 “I know your fire” 台北場',
    ]);
    expect(items.map((i) => i.candidate?.typeHint)).toEqual([
      'doujin',
      'doujin',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('external_id 為解碼後的 URL 路徑', () => {
    expect(items[1]?.externalId).toBe('activitys/fancy-frontier開拓動漫祭-48');
  });

  it('場館拆出地址；票價、逐日時刻解析', () => {
    expect(items[1]?.candidate).toMatchObject({
      venueText: '花博公園爭艷館',
      addressText: '台北市中山區玉門街一號',
      priceText: '單日票200元',
    });
    const ff48 = norm(1).event;
    expect(venueSlug(ff48.venueId)).toBe('expo-dome');
    expect(ff48.startAt?.toISOString()).toBe('2027-02-19T02:30:00.000Z');
    expect(ff48.endAt?.toISOString()).toBe('2027-02-21T08:30:00.000Z');
    expect([ff48.priceMin, ff48.priceMax]).toEqual([200, 200]);
    expect(norm(1).status).toBe('published');
  });

  it('演唱會：取開演時間、多票種取最低/最高；類型無關鍵字 → 待審', () => {
    const lisani = norm(2);
    expect(lisani.event.startAt?.toISOString()).toBe('2026-11-28T10:00:00.000Z');
    expect([lisani.event.priceMin, lisani.event.priceMax]).toEqual([2600, 6400]);
    expect(venueSlug(lisani.event.venueId)).toBe('legacy-max');
    expect(lisani.event.reviewReasons).toEqual(['type_unresolved']);
    expect(norm(3).event.startAt?.toISOString()).toBe('2026-12-06T10:00:00.000Z');
  });
});
