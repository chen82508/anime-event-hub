/**
 * 收藏活動的提醒時機（企劃 §3-3：開賣前／舉辦前一天）。
 *
 * - 開賣提醒：now ∈ [開賣時間 − saleLeadHours, 開賣時間)
 * - 活動提醒：now ∈ [開始日前一天 eventReminderHour:00（台灣時間）, 開始時間)
 *
 * 排程每隔幾分鐘檢查一次，落在區間內就產生通知；dedupeKey 含開賣／開始時間，
 * 已提醒過不會重複，但官方改期後會再提醒一次。錯過區間（例如收藏時已開賣）就不補發。
 */
import { taipeiIsoDate } from '@aeh/core';
import { renderEventReminder, renderSaleReminder } from './templates';
import type { NotificationDraft, NotifyEvent } from './types';

export interface FavoriteForReminder {
  subscriberId: number;
  notifySaleReminder: boolean;
  notifyEventReminder: boolean;
  event: NotifyEvent;
}

export interface ReminderOptions {
  /** 開賣前幾小時提醒（預設 24） */
  saleLeadHours?: number;
  /** 活動前一天幾點提醒（台灣時間 0–23，預設 18） */
  eventReminderHour?: number;
}

export const DEFAULT_SALE_LEAD_HOURS = 24;
export const DEFAULT_EVENT_REMINDER_HOUR = 18;

const HOUR = 3_600_000;

/** 台灣日期 YYYY-MM-DD 的 hh:00（+08:00，台灣無日光節約時間） */
function taipeiAt(isoDate: string, hour: number): Date {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour - 8));
}

/** 活動提醒的開始時間：開始日前一天 hour:00 */
export function eventReminderOpensAt(startAt: Date, hour = DEFAULT_EVENT_REMINDER_HOUR): Date {
  const [y, m, d] = taipeiIsoDate(startAt).split('-').map(Number) as [number, number, number];
  const prev = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  return taipeiAt(prev, hour);
}

export function dueReminders(
  favorites: readonly FavoriteForReminder[],
  now: Date,
  opts: ReminderOptions = {},
): NotificationDraft[] {
  const lead = (opts.saleLeadHours ?? DEFAULT_SALE_LEAD_HOURS) * HOUR;
  const hour = opts.eventReminderHour ?? DEFAULT_EVENT_REMINDER_HOUR;
  const t = now.getTime();
  const drafts: NotificationDraft[] = [];
  const sorted = [...favorites].sort(
    (a, b) => a.subscriberId - b.subscriberId || a.event.id - b.event.id,
  );
  for (const f of sorted) {
    const e = f.event;
    const sale = e.saleStartAt?.getTime();
    if (f.notifySaleReminder && sale !== undefined && t >= sale - lead && t < sale) {
      drafts.push({
        subscriberId: f.subscriberId,
        kind: 'sale_reminder',
        eventId: e.id,
        dedupeKey: `sale_reminder:${f.subscriberId}:${e.id}:${e.saleStartAt!.toISOString()}`,
        ...renderSaleReminder(e, now),
      });
    }
    if (f.notifyEventReminder && e.startAt) {
      const opens = eventReminderOpensAt(e.startAt, hour).getTime();
      if (t >= opens && t < e.startAt.getTime()) {
        drafts.push({
          subscriberId: f.subscriberId,
          kind: 'event_reminder',
          eventId: e.id,
          dedupeKey: `event_reminder:${f.subscriberId}:${e.id}:${taipeiIsoDate(e.startAt)}`,
          ...renderEventReminder(e, now),
        });
      }
    }
  }
  return drafts;
}
