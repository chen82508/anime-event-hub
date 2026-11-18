/**
 * 縣市與地區解析（D3）。縣市別名來自 regions.yaml；地區歸屬以 @aeh/core 的 CITY_REGION 為準。
 */
import { CITY_REGION, type Region, type RegionsDict, type TaiwanCity } from '@aeh/core';
import { LongestMatcher } from './matcher';
import { compactForMatch } from './text';

export interface CityAliasEntry {
  name: TaiwanCity;
  aliases: readonly string[];
}

/** regions.yaml（依地區分組）→ 扁平的縣市別名清單 */
export function cityEntriesFromRegionsDict(dict: RegionsDict): CityAliasEntry[] {
  return Object.values(dict).flat();
}

export type CityResult =
  { kind: 'ok'; city: TaiwanCity } | { kind: 'ambiguous'; cities: TaiwanCity[] } | { kind: 'none' };

export class CityMatcher {
  private readonly matcher: LongestMatcher<TaiwanCity>;

  constructor(entries: readonly CityAliasEntry[]) {
    this.matcher = new LongestMatcher(
      entries.flatMap((e) =>
        [e.name, ...e.aliases].map((a) => ({ pattern: compactForMatch(a), value: e.name })),
      ),
    );
  }

  /** 文字中出現的縣市（去重、依出現順序）。`新北市` 不會被誤判成 `北市`（最長匹配） */
  findAll(text: string): TaiwanCity[] {
    const out: TaiwanCity[] = [];
    for (const m of this.matcher.findAll(compactForMatch(text))) {
      for (const c of m.values) if (!out.includes(c)) out.push(c);
    }
    return out;
  }

  /** 唯一縣市；出現多個 → ambiguous */
  extract(text: string): CityResult {
    const cities = this.findAll(text);
    if (cities.length === 0) return { kind: 'none' };
    if (cities.length === 1) return { kind: 'ok', city: cities[0] as TaiwanCity };
    return { kind: 'ambiguous', cities };
  }
}

/** 地區：線上 → online；否則由縣市推得（D3）；無縣市 → null */
export function resolveRegion(input: {
  isOnline: boolean;
  city: TaiwanCity | null;
}): Region | null {
  if (input.isOnline) return 'online';
  return input.city ? CITY_REGION[input.city] : null;
}

/**
 * 海外地名（R12）。只在「場館字典未命中、且文字中沒有任何台灣縣市」時才用來判定 outside_taiwan。
 * 刻意不收「中國」「美國」等易出現在台灣場館/企業名稱中的詞（如「中國信託」）。
 */
export const OVERSEAS_PLACES: readonly string[] = [
  // 日本
  '日本',
  'japan',
  '東京',
  'tokyo',
  '大阪',
  'osaka',
  '京都',
  'kyoto',
  '名古屋',
  'nagoya',
  '橫濱',
  '横浜',
  '横濱',
  'yokohama',
  '福岡',
  'fukuoka',
  '札幌',
  'sapporo',
  '神戶',
  '神戸',
  '幕張',
  'makuhari',
  '埼玉',
  'saitama',
  '千葉',
  '仙台',
  '沖繩',
  '沖縄',
  '武道館',
  '東京巨蛋',
  '東京ドーム',
  // 港澳、中國大陸
  '香港',
  'hong kong',
  '澳門',
  'macau',
  '上海',
  'shanghai',
  '北京',
  'beijing',
  '廣州',
  '广州',
  '深圳',
  '成都',
  // 韓國、東南亞
  '韓國',
  '首爾',
  'seoul',
  '釜山',
  'busan',
  '新加坡',
  'singapore',
  '馬來西亞',
  '吉隆坡',
  'kuala lumpur',
  '泰國',
  '曼谷',
  'bangkok',
  '雅加達',
  'jakarta',
  '馬尼拉',
  'manila',
];

const overseasMatcher = new LongestMatcher(
  OVERSEAS_PLACES.map((p) => ({ pattern: compactForMatch(p), value: p })),
);

/** 文字中第一個海外地名（原清單寫法），沒有則 null */
export function findOverseasPlace(text: string): string | null {
  const m = overseasMatcher.findAll(compactForMatch(text))[0];
  return m ? (m.values[0] as string) : null;
}
