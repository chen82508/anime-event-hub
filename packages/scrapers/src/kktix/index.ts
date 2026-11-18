import type { Scraper } from '../_shared/types';
import { parseKktixAtom } from './parse';

/** 預設搜尋關鍵字（設定化，PoC 後校正，R15） */
export const DEFAULT_KKTIX_KEYWORDS: readonly string[] = [
  '動漫',
  '動畫',
  '聲優',
  '同人',
  'cosplay',
];

export function createKktixScraper(keywords: readonly string[] = DEFAULT_KKTIX_KEYWORDS): Scraper {
  return {
    id: 'kktix',
    schedule: 'daily',
    fixtureStatus: 'real',
    listUrls: () =>
      keywords.map((k) => `https://kktix.com/events.atom?search=${encodeURIComponent(k)}`),
    parseList: parseKktixAtom,
  };
}

export { parseKktixAtom, parseKktixTime } from './parse';
