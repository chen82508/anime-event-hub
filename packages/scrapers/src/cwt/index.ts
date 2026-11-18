import type { Scraper } from '../_shared/types';
import { parseCwtActs } from './parse';

export const cwtScraper: Scraper = {
  id: 'cwt',
  schedule: 'daily',
  fixtureStatus: 'real',
  listUrls: () => ['https://www.comicworld.com.tw/Acts/tw'],
  parseList: parseCwtActs,
};

export { parseCwtActs } from './parse';
