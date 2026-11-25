/**
 * 推播文案：固定繁中模板（C3：不生成、同一輸入必得同一輸出）。
 * 標題保留來源原文（C2），只做換行／控制字元清理與長度截斷。
 * 每則通知都導向站內活動頁，活動頁再強制導流至官方購票／原始公告（C8）。
 */
import {
  EVENT_TYPE_LABEL,
  formatEventWhen,
  formatMonthDay,
  formatPlace,
  formatTime,
  taipeiIsoDate,
} from '@aeh/core';
import type { NotifyEvent, RenderedMessage } from './types';

export const TITLE_MAX = 60;
const DIGEST_PREVIEW = 3;
/** 控制字元、零寬字元、行／段落分隔符 */
// eslint-disable-next-line no-control-regex -- 刻意比對控制字元以清理標題
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200d\\u2028\\u2029]+', 'g');

/** 去除換行與控制字元、合併空白，超過上限以「…」截斷（以 code point 計，不切斷 emoji） */
export function cleanTitle(title: string, max = TITLE_MAX): string {
  const s = title.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

function place(e: NotifyEvent): string {
  return formatPlace(e);
}

export const eventPath = (id: number) => `/events/${id}`;

/** 相對日期：今天／明天／12/12（六） */
export function relativeDay(at: Date, now: Date): string {
  const d = taipeiIsoDate(at);
  const today = taipeiIsoDate(now);
  if (d === today) return '今天';
  const [y, m, dd] = today.split('-').map(Number) as [number, number, number];
  const tomorrow = new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10);
  if (d === tomorrow) return '明天';
  return formatMonthDay(at);
}

/** 新活動上架（單筆） */
export function renderNewEvent(
  e: NotifyEvent,
  reasons: readonly string[],
  now: Date,
): RenderedMessage {
  const when = formatEventWhen(e.startAt, e.endAt, e.allDay, { now, compact: true });
  const typeLabel = e.type && e.type !== 'other' ? `［${EVENT_TYPE_LABEL[e.type]}］` : '';
  const lines = [`${typeLabel}${when}・${place(e)}`];
  if (reasons.length) lines.push(`符合你的訂閱：${reasons.join('、')}`);
  return {
    title: `新活動上架｜${cleanTitle(e.title)}`,
    body: lines.join('\n'),
    path: eventPath(e.id),
  };
}

/** 新活動上架（同一次比對命中多筆時合併成一則，避免洗版） */
export function renderNewEventDigest(events: readonly NotifyEvent[]): RenderedMessage {
  const preview = events.slice(0, DIGEST_PREVIEW).map((e) => `・${cleanTitle(e.title, 30)}`);
  if (events.length > DIGEST_PREVIEW) preview.push(`…等共 ${events.length} 個活動`);
  return {
    title: `${events.length} 個新活動符合你的訂閱`,
    body: preview.join('\n'),
    path: '/me#inbox',
  };
}

/** 收藏活動開賣前提醒 */
export function renderSaleReminder(e: NotifyEvent, now: Date): RenderedMessage {
  const sale = e.saleStartAt!;
  return {
    title: `開賣提醒｜${cleanTitle(e.title)}`,
    body: `${relativeDay(sale, now)} ${formatTime(sale)} 開賣，記得準時搶票！\n${place(e)}・實際購票方式請以官方公告為準`,
    path: eventPath(e.id),
  };
}

/** 收藏活動舉辦前一天提醒 */
export function renderEventReminder(e: NotifyEvent, now: Date): RenderedMessage {
  const start = e.startAt!;
  const day = relativeDay(start, now);
  const time = e.allDay ? '' : ` ${formatTime(start)}`;
  return {
    title: `${day}就是活動日｜${cleanTitle(e.title)}`,
    body: `${day}${time} 開始・${place(e)}\n出發前請再確認官方公告的入場資訊`,
    path: eventPath(e.id),
  };
}

export function renderTest(): RenderedMessage {
  return {
    title: '測試通知｜動漫活動一站看',
    body: '收到這則訊息，代表推播設定成功！之後有新活動或開賣提醒會用這個管道通知你。',
    path: '/me',
  };
}

// ── 各管道的訊息格式 ─────────────────────────────────────

export interface ChannelMessage {
  title: string;
  body: string;
  path: string;
  /** 同一 tag 的推播會取代舊的（瀏覽器端） */
  tag: string;
}

/** Web Push payload（service worker 解析；上限約 4KB，模板長度遠低於此） */
export function toPushPayload(m: ChannelMessage): string {
  return JSON.stringify({ title: m.title, body: m.body, url: m.path, tag: m.tag });
}

/** LINE 文字訊息（上限 5000 字）；附完整網址 */
export function toLineText(m: ChannelMessage, baseUrl: string): string {
  const url = `${baseUrl.replace(/\/+$/, '')}${m.path}`;
  return `${m.title}\n${m.body}\n\n👉 ${url}`.slice(0, 5000);
}
