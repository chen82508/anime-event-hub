/**
 * CWT 台灣場活動一覽（`/Acts/tw`）。香港場（`/Acts/hk`）不在收錄範圍，不擷取。
 *
 * 每張卡片：
 *   <div class="activity">
 *     <a href="/Act1/170" class="a_row"><span class="a_c_tit">【CWT-74】(台北場)</span></a>
 *     <span class="a_row"><span class="a_c_i">活動日期</span>2026年12月12 / 13日</span>
 *     <span class="a_row"><span class="a_c_i">活動地點</span>國立臺灣大學綜合體育館1F&3F&4F</span>
 *     <span class="a_row"><span class="a_c_i">地址</span>台北市大安區羅斯福路四段1號</span>（標籤中間為兩個全形空白）
 */
import type { RawEventCandidate } from '@aeh/core';
import { cleanText } from '@aeh/normalize';
import { load } from 'cheerio';
import type { ListItem, ParseContext } from '../_shared/types';
import { absoluteUrl } from '../_shared/util';

export function parseCwtActs(html: string, url: string, _ctx: ParseContext): ListItem[] {
  const $ = load(html);
  const items: ListItem[] = [];
  $('.activity').each((_, el) => {
    const card = $(el);
    const link = card.find('a.a_row').first();
    const href = link.attr('href');
    const title = cleanText(card.find('.a_c_tit').first().text());
    if (!href || !title) return;
    const detailUrl = absoluteUrl(href, url);
    const externalId = /\/Act1\/(\d+)/.exec(href)?.[1] ?? detailUrl;

    const fields: Record<string, string> = {};
    card.find('span.a_row').each((_, row) => {
      const label = cleanText($(row).find('.a_c_i').text()).replaceAll(' ', '');
      const value = cleanText($(row).clone().children('.a_c_i').remove().end().text());
      if (label) fields[label] = value;
    });

    const candidate: RawEventCandidate = {
      sourceId: 'cwt',
      externalId,
      url: detailUrl,
      title,
      typeHint: 'doujin',
      ...(fields['活動日期'] ? { dateText: fields['活動日期'] } : {}),
      ...(fields['活動地點'] ? { venueText: fields['活動地點'] } : {}),
      ...(fields['地址'] ? { addressText: fields['地址'] } : {}),
    };
    items.push({ externalId, url: detailUrl, candidate });
  });
  return items;
}
