/**
 * KKTIX 搜尋結果 Atom feed（`https://kktix.com/events.atom?search=<關鍵字>`）。
 * `events.json` 位於 Cloudflare 驗證之後，不使用（不繞過防護）。
 *
 * 每個 entry 的 `<content>` 固定為兩行：
 *   時間：2026/12/05 18:30(+0800) ~ 2026/12/06 21:30(+0800)   （結束可省略日期或整段省略）
 *   地點：<場館> / <地址>
 */
import type { RawEventCandidate } from '@aeh/core';
import { cleanText } from '@aeh/normalize';
import { XMLParser } from 'fast-xml-parser';
import type { ListItem, ParseContext } from '../_shared/types';
import { taipeiDayFromZoned } from '../_shared/util';

interface AtomLink {
  '@_rel'?: string;
  '@_href'?: string;
}
interface AtomEntry {
  id?: string;
  published?: string;
  title?: string | { '#text'?: string };
  link?: AtomLink[];
  content?: string | { '#text'?: string };
  author?: { name?: string };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'entry' || name === 'link',
  // 標題常含 `&amp;` 等實體，交給 parser 解碼；不解析成數字
  parseTagValue: false,
});

const TIME_RE =
  /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})\(([+-])(\d{2})(\d{2})\)(?:\s*~\s*(?:(\d{4})\/(\d{2})\/(\d{2}) )?(\d{2}):(\d{2})(?:\(([+-])(\d{2})(\d{2})\))?)?$/;

function text(v: string | { '#text'?: string } | undefined): string {
  if (v === undefined) return '';
  return cleanText(typeof v === 'string' ? v : (v['#text'] ?? ''));
}

/** `2026/12/05 18:30(+0800) ~ 21:30` → ISO（帶時區）；格式不符回傳 null */
export function parseKktixTime(s: string): { startAt: string; endAt?: string } | null {
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  const g = (i: number) => m[i] as string;
  const startAt = `${g(1)}-${g(2)}-${g(3)}T${g(4)}:${g(5)}:00${g(6)}${g(7)}:${g(8)}`;
  if (m[12] === undefined) return { startAt };
  const [y, mo, d] = m[9] !== undefined ? [g(9), g(10), g(11)] : [g(1), g(2), g(3)];
  const tz = m[14] !== undefined ? `${g(14)}${g(15)}:${g(16)}` : `${g(6)}${g(7)}:${g(8)}`;
  return { startAt, endAt: `${y}-${mo}-${d}T${g(12)}:${g(13)}:00${tz}` };
}

export function parseKktixAtom(xml: string, _url: string, _ctx: ParseContext): ListItem[] {
  const doc = parser.parse(xml) as { feed?: { entry?: AtomEntry[] } };
  const items: ListItem[] = [];
  for (const e of doc.feed?.entry ?? []) {
    const url = e.link?.find((l) => (l['@_rel'] ?? 'alternate') === 'alternate')?.['@_href'];
    const title = text(e.title);
    if (!url || !title) continue;
    const externalId = /Event\/(\d+)$/.exec(e.id ?? '')?.[1] ?? url;

    const raw = typeof e.content === 'string' ? e.content : (e.content?.['#text'] ?? '');
    const lines = raw.split(/\r?\n/).map((l) => cleanText(l));
    const field = (label: string) =>
      lines
        .find((l) => l.startsWith(`${label}：`) || l.startsWith(`${label}:`))
        ?.slice(label.length + 1)
        .trim();
    const timeRaw = field('時間');
    const placeRaw = field('地點');

    const time = timeRaw ? parseKktixTime(timeRaw) : null;
    const [venueText, ...addr] = (placeRaw ?? '').split(' / ');
    const organizer = e.author?.name ? cleanText(e.author.name) : undefined;

    const candidate: RawEventCandidate = {
      sourceId: 'kktix',
      externalId,
      url,
      title,
      ...(time ? { structured: time } : timeRaw ? { dateText: timeRaw } : {}),
      ...(venueText ? { venueText: venueText.trim() } : {}),
      ...(addr.length > 0 ? { addressText: addr.join(' / ').trim() } : {}),
      ...(taipeiDayFromZoned(e.published) ? { publishedOn: taipeiDayFromZoned(e.published) } : {}),
      ...(organizer ? { notes: [`主辦：${organizer}`] } : {}),
    };
    items.push({ externalId, url, candidate });
  }
  return items;
}
