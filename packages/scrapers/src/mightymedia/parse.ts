/**
 * 曼迪傳播 Mighty Media（Wix 網站）的最新消息 RSS：`/blog-feed.xml`。
 * 首頁為 Wix 動態頁面（約 1.8 MB），RSS 結構穩定得多。
 *
 * 低結構來源：日期與場館只出現在標題中（例：`…12/28高雄夢時代登場`），
 * 因此以標題作為 dateText / venueText；大多數項目會因場館不在字典而進待審，屬預期行為。
 * 只收分類為「活動」者；其餘（播映、商品、授權）記錄 skipReason（R11）。
 */
import type { RawEventCandidate } from '@aeh/core';
import { cleanText } from '@aeh/normalize';
import { XMLParser } from 'fast-xml-parser';
import type { ListItem, ParseContext } from '../_shared/types';
import { decodeEntities, nonEventKeyword, taipeiDayFromZoned } from '../_shared/util';

interface RssItem {
  title?: string;
  link?: string;
  guid?: string | { '#text'?: string };
  category?: string | string[];
  pubDate?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'item' || name === 'category',
  parseTagValue: false,
});

export const MIGHTYMEDIA_EVENT_CATEGORIES: readonly string[] = ['活動'];

export function parseMightyMediaFeed(xml: string, _url: string, _ctx: ParseContext): ListItem[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: RssItem[] } } };
  const items: ListItem[] = [];
  for (const it of doc.rss?.channel?.item ?? []) {
    const url = it.link?.trim();
    const title = cleanText(decodeEntities(it.title ?? ''));
    if (!url || !title) continue;
    const guid = typeof it.guid === 'string' ? it.guid : it.guid?.['#text'];
    const externalId = guid?.trim() || url;
    const categories = ([] as string[]).concat(it.category ?? []).map((c) => cleanText(c));

    if (!categories.some((c) => MIGHTYMEDIA_EVENT_CATEGORIES.includes(c))) {
      items.push({
        externalId,
        url,
        candidate: null,
        skipReason: `非活動分類：${categories.join('、') || '（無）'}`,
      });
      continue;
    }
    const kw = nonEventKeyword(title);
    if (kw) {
      items.push({ externalId, url, candidate: null, skipReason: `非活動公告（${kw}）` });
      continue;
    }

    const publishedOn = taipeiDayFromZoned(it.pubDate);
    const candidate: RawEventCandidate = {
      sourceId: 'mightymedia',
      externalId,
      url,
      title,
      dateText: title,
      venueText: title,
      ...(publishedOn ? { publishedOn } : {}),
      notes: ['低結構來源：日期與場館取自標題'],
    };
    items.push({ externalId, url, candidate });
  }
  return items;
}
