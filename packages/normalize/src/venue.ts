/**
 * 場館解析（tech-spec T4、R5、R12）。
 *
 * 判定順序：
 * 1. 場館字典（名稱＋別名，最長匹配、不分空白與全半形）；先比對場館欄，未命中才比對地址
 *    - 命中 1 個 → matched
 *    - 命中多個不同場館 → ambiguous（一則公告多場館，R5，交給人工拆分）
 * 2. 未命中：
 *    - 沒有任何台灣縣市、但出現海外地名 → outside_taiwan（R12；線上活動亦同，C6）
 *    - 有線上關鍵字（或擷取器已標示 isOnline）→ online
 *    - 其它 → unknown（附推得的縣市，供審核者參考）
 * 3. 完全沒有場館文字且非線上 → missing
 *
 * 字典沒有的場館**不自動建立**，一律進待審（unknown_venue）。
 */
import { CITY_REGION, type Region, type ReviewReason, type TaiwanCity } from '@aeh/core';
import { LongestMatcher } from './matcher';
import { CityMatcher, findOverseasPlace, type CityAliasEntry } from './region';
import { cleanText, compactForMatch } from './text';

export interface VenueRecord {
  /** DB id（從 DB 載入時有；直接用 YAML 時沒有） */
  id?: number;
  slug: string;
  name: string;
  aliases: readonly string[];
  city: TaiwanCity;
}

export type VenueResolution<V extends VenueRecord = VenueRecord> =
  | { kind: 'matched'; venue: V; matched: string; city: TaiwanCity; region: Region }
  | { kind: 'online' }
  | { kind: 'outside_taiwan'; place: string }
  | { kind: 'ambiguous'; venues: V[] }
  | { kind: 'unknown'; city: TaiwanCity | null; region: Region | null }
  | { kind: 'missing' };

export interface VenueInput {
  venueText?: string | null;
  addressText?: string | null;
  /** 擷取器判定為線上活動 */
  isOnline?: boolean;
}

const ONLINE_RE =
  /(線上|網路直播|線上直播|直播|オンライン|配信|online|youtube|twitch|zoom|instagram live)/iu;

export class VenueResolver<V extends VenueRecord = VenueRecord> {
  private readonly matcher: LongestMatcher<V>;
  private readonly cities: CityMatcher;

  constructor(venues: readonly V[], cities: readonly CityAliasEntry[]) {
    this.matcher = new LongestMatcher(
      venues.flatMap((v) =>
        [v.name, ...v.aliases].map((a) => ({ pattern: compactForMatch(a), value: v })),
      ),
    );
    this.cities = new CityMatcher(cities);
  }

  private findVenues(text: string): Map<string, { venue: V; matched: string }> {
    const hits = new Map<string, { venue: V; matched: string }>();
    if (!text) return hits;
    for (const m of this.matcher.findAll(compactForMatch(text))) {
      for (const v of m.values)
        if (!hits.has(v.slug)) hits.set(v.slug, { venue: v, matched: m.pattern });
    }
    return hits;
  }

  resolve(input: VenueInput): VenueResolution<V> {
    const venueText = cleanText(input.venueText ?? '');
    const addressText = cleanText(input.addressText ?? '');
    const all = `${venueText} ${addressText}`.trim();

    if (all.length === 0) return input.isOnline ? { kind: 'online' } : { kind: 'missing' };

    // 先比對場館欄；沒有命中才看地址（地址常附帶「位於華山1914」之類的位置說明，會造成誤判）
    const hits = this.findVenues(venueText);
    if (hits.size === 0) for (const [k, v] of this.findVenues(addressText)) hits.set(k, v);
    if (hits.size === 1) {
      const { venue, matched } = [...hits.values()][0] as { venue: V; matched: string };
      return { kind: 'matched', venue, matched, city: venue.city, region: CITY_REGION[venue.city] };
    }
    if (hits.size > 1) return { kind: 'ambiguous', venues: [...hits.values()].map((h) => h.venue) };

    // 海外地名優先於線上判定：「東京 オンライン配信」是海外的線上活動，不收錄（C6）
    const cities = this.cities.findAll(all);
    if (cities.length === 0) {
      const place = findOverseasPlace(all);
      if (place) return { kind: 'outside_taiwan', place };
    }

    if (input.isOnline || ONLINE_RE.test(venueText)) return { kind: 'online' };
    const city = cities.length === 1 ? (cities[0] as TaiwanCity) : null;
    return { kind: 'unknown', city, region: city ? CITY_REGION[city] : null };
  }
}

/** 場館判定 → 審核原因（tech-spec §4.3） */
export function venueReviewReasons(r: VenueResolution): ReviewReason[] {
  switch (r.kind) {
    case 'matched':
    case 'online':
      return [];
    case 'outside_taiwan':
      return ['outside_taiwan'];
    case 'ambiguous':
    case 'unknown':
      return ['unknown_venue'];
    case 'missing':
      return ['missing_venue'];
  }
}
