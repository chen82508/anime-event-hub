import type { SourceId } from '@aeh/core';
import type { Scraper } from './_shared/types';
import { cwtScraper } from './cwt';
import { ffScraper } from './ff';
import { createKktixScraper, DEFAULT_KKTIX_KEYWORDS } from './kktix';
import { mightyMediaScraper } from './mightymedia';
import { museScraper } from './muse';

export interface ScraperConfig {
  kktixKeywords?: readonly string[];
}

/**
 * 已實作的擷取器。tica / comic_exhibition 尚未實作（官網結構待 PoC 確認）；
 * 拓元、ibon 暫緩、社群平台不爬（C10）。
 */
export function createRegistry(config: ScraperConfig = {}): Partial<Record<SourceId, Scraper>> {
  return {
    kktix: createKktixScraper(config.kktixKeywords ?? DEFAULT_KKTIX_KEYWORDS),
    cwt: cwtScraper,
    ff: ffScraper,
    mightymedia: mightyMediaScraper,
    muse: museScraper,
  };
}
