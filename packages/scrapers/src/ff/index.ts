import type { Scraper } from '../_shared/types';
import { parseFfHome } from './parse';

export const ffScraper: Scraper = {
  id: 'ff',
  schedule: 'daily',
  fixtureStatus: 'real',
  listUrls: () => ['https://www.f-2.com.tw/'],
  parseList: parseFfHome,
};

export { parseFfHome } from './parse';
