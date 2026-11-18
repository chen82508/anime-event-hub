/**
 * 木棉花 Muse 官網最新消息列表。
 *
 * ⚠️ 結構未經驗證：2026-11-18 檢查時 `www.e-muse.com.tw` 沒有 DNS A 記錄（NS 在 Cloudflare），
 * 無法取得真實頁面。本 parser 依常見的新聞列表結構撰寫，fixture 為**合成樣本**；
 * 因此 `fixtureStatus: 'synthetic'`，pipeline 預設不執行。PoC 時取得真實快照後須改寫 selector 與 fixture。
 *
 * 預期結構：
 *   <li class="news-item">
 *     <span class="news-date">2026.11.10</span>
 *     <span class="news-category">活動</span>
 *     <a class="news-title" href="/news/1234">標題</a>
 *   </li>
 */
import type { RawEventCandidate } from '@aeh/core';
import { cleanText } from '@aeh/normalize';
import { load } from 'cheerio';
import type { ListItem, ParseContext } from '../_shared/types';
import { absoluteUrl, nonEventKeyword } from '../_shared/util';

const DATE_RE = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/;

export function parseMuseNewsList(html: string, url: string, _ctx: ParseContext): ListItem[] {
  const $ = load(html);
  const items: ListItem[] = [];
  $('.news-item').each((_, el) => {
    const row = $(el);
    const a = row.find('a.news-title').first();
    const href = a.attr('href');
    const title = cleanText(a.text());
    if (!href || !title) return;
    const itemUrl = absoluteUrl(href, url);
    const externalId = /\/news\/(\d+)/.exec(itemUrl)?.[1] ?? itemUrl;
    const category = cleanText(row.find('.news-category').text());
    if (category && category !== '活動') {
      items.push({
        externalId,
        url: itemUrl,
        candidate: null,
        skipReason: `非活動分類：${category}`,
      });
      return;
    }
    const kw = nonEventKeyword(title);
    if (kw) {
      items.push({ externalId, url: itemUrl, candidate: null, skipReason: `非活動公告（${kw}）` });
      return;
    }
    const d = DATE_RE.exec(cleanText(row.find('.news-date').text()));
    const publishedOn = d
      ? `${d[1]}-${(d[2] as string).padStart(2, '0')}-${(d[3] as string).padStart(2, '0')}`
      : undefined;
    const candidate: RawEventCandidate = {
      sourceId: 'muse',
      externalId,
      url: itemUrl,
      title,
      dateText: title,
      venueText: title,
      ...(publishedOn ? { publishedOn } : {}),
      notes: ['低結構來源：日期與場館取自標題'],
    };
    items.push({ externalId, url: itemUrl, candidate });
  });
  return items;
}
