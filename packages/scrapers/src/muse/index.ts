import type { Scraper } from '../_shared/types';
import { parseMuseNewsList } from './parse';

export const museScraper: Scraper = {
  id: 'muse',
  schedule: 'daily',
  // 官網無法連線，結構未驗證（見 parse.ts / README.md）
  fixtureStatus: 'synthetic',
  listUrls: () => ['https://www.e-muse.com.tw/news'],
  parseList: parseMuseNewsList,
};

export { parseMuseNewsList } from './parse';
