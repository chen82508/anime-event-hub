import type { Scraper } from '../_shared/types';
import { parseMightyMediaFeed } from './parse';

export const mightyMediaScraper: Scraper = {
  id: 'mightymedia',
  schedule: 'daily',
  fixtureStatus: 'real',
  listUrls: () => ['https://www.mightymedia.com.tw/blog-feed.xml'],
  parseList: parseMightyMediaFeed,
};

export { parseMightyMediaFeed } from './parse';
