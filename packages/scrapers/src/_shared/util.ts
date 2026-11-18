import { cleanText, taipeiDateString } from '@aeh/normalize';
import type { Cheerio, CheerioAPI } from 'cheerio';

/** domhandler 的 AnyNode（cheerio 未直接匯出，避免額外相依） */
type AnyNode = Parameters<CheerioAPI['contains']>[0];

/** 元素文字：`<br>` 轉換行，其餘空白收斂（保留換行，供逐日日期解析） */
export function textWithBreaks(el: Cheerio<AnyNode>): string {
  const clone = el.clone();
  clone.find('br').replaceWith('\n');
  return clone
    .text()
    .split('\n')
    .map((l) => cleanText(l))
    .filter((l) => l.length > 0)
    .join('\n');
}

export function absoluteUrl(href: string, base: string): string {
  return new URL(href, base).href;
}

/**
 * 帶時區的日期字串（RFC 822 `Tue, 10 Nov 2026 04:32:11 GMT`、ISO `2026-10-29T12:00:00+08:00`）→ 台灣日曆日。
 * 沒有時區資訊的字串一律回傳 undefined（R1：不使用無時區的 Date 解析）。
 */
export function taipeiDayFromZoned(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2}|\bGMT|\bUTC)$/i.test(t);
  if (!hasZone) return undefined;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : taipeiDateString(new Date(ms));
}

/** `名稱（地址）` / `名稱(地址)` → [名稱, 地址] */
export function splitParenthetical(s: string): [string, string | undefined] {
  const m = /^(.*?)\s*[（(](.+)[）)]\s*$/u.exec(s);
  return m ? [(m[1] as string).trim(), (m[2] as string).trim()] : [s.trim(), undefined];
}

/**
 * 非活動公告的排除關鍵字（R11）：代理商「最新消息」大量為商品、授權、播映新聞。
 * 命中者記錄 skipReason，不建立活動。
 */
export const NON_EVENT_KEYWORDS: readonly string[] = [
  '預購',
  '發售',
  '開賣商品',
  '代理決定',
  '授權決定',
  '播映',
  '播出',
  '開播',
  '上架',
  '得獎名單',
  '中獎名單',
  '徵件',
  '失物',
  '招募',
];

export function nonEventKeyword(title: string): string | null {
  return NON_EVENT_KEYWORDS.find((k) => title.includes(k)) ?? null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** 解碼殘留的 HTML 實體（部分 RSS 在 CDATA 內又編碼了一次，如 `&#38;`） */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : all;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? all;
  });
}
