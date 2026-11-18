/**
 * 開拓動漫祭（FF）官網首頁的活動區塊。
 *
 * - `.Frontier-activity` 有兩個：「開拓動漫祭系列活動」（同人展 → typeHint doujin）與
 *   「其他類型動漫活動」（演唱會等，交給關鍵字判定）。
 * - 每筆 `.activity-info`：`h2 > a`（標題、詳細頁）與數個 `<p><strong>標籤：</strong>內容</p>`。
 * - 活動日期逐日列出（`2027 年 2月 19日 （五） 10：30–17：00<br>…`），保留換行交給 normalize。
 * - 活動地點為 `名稱（地址）`。
 */
import type { RawEventCandidate } from '@aeh/core';
import { cleanText } from '@aeh/normalize';
import { load } from 'cheerio';
import type { ListItem, ParseContext } from '../_shared/types';
import { absoluteUrl, splitParenthetical, textWithBreaks } from '../_shared/util';

const LABELS: Record<string, 'date' | 'price' | 'venue'> = {
  活動日期: 'date',
  票價資訊: 'price',
  活動地點: 'venue',
};

/** URL 路徑（解碼）作為穩定 ID：`activitys/lisani！taipei-2026` */
function externalIdOf(href: string): string {
  const path = new URL(href).pathname.replace(/^\/+|\/+$/g, '');
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function parseFfHome(html: string, url: string, _ctx: ParseContext): ListItem[] {
  const $ = load(html);
  const items: ListItem[] = [];
  $('.Frontier-activity').each((_, section) => {
    const sec = $(section);
    const heading = cleanText(sec.find('.activity-header h2').first().text());
    const isDoujin = heading.includes('開拓動漫祭');
    sec.find('.activity-info').each((_, info) => {
      const box = $(info);
      const a = box.find('h2 a').first();
      const href = a.attr('href');
      const title = cleanText(a.text());
      if (!href || !title) return;
      const detailUrl = absoluteUrl(href, url);

      const fields: Partial<Record<'date' | 'price' | 'venue', string>> = {};
      box.find('p').each((_, p) => {
        const para = $(p);
        const label = cleanText(para.find('strong').first().text()).replace(/[:：]$/u, '');
        const key = LABELS[label];
        if (!key) return;
        const body = para.clone();
        body.find('strong').first().remove();
        body.find('p').remove(); // 未閉合的 <p> 可能把下一段包進來
        fields[key] = textWithBreaks(body);
      });

      const [venueText, addressText] = fields.venue ? splitParenthetical(fields.venue) : [];
      const externalId = externalIdOf(detailUrl);
      const candidate: RawEventCandidate = {
        sourceId: 'ff',
        externalId,
        url: detailUrl,
        title,
        ...(isDoujin ? { typeHint: 'doujin' as const } : {}),
        ...(fields.date ? { dateText: fields.date.replaceAll('\n', ' ') } : {}),
        ...(fields.price ? { priceText: fields.price } : {}),
        ...(venueText ? { venueText } : {}),
        ...(addressText ? { addressText } : {}),
      };
      items.push({ externalId, url: detailUrl, candidate });
    });
  });
  return items;
}
