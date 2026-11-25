/**
 * notify 工作（排程每 5 分鐘 ＋ CLI `notify`）：
 *   1. 新活動上架：比對「已發布、尚未通知」活動與訂閱 → 通知（命中多筆合併為摘要）
 *   2. 收藏提醒：開賣前 N 小時、活動前一天 → 通知
 *   3. 投遞：送出到期的站外推播（勿擾時段的通知延後到時段結束）
 * 每一步都可重跑（dedupe_key 唯一、投遞狀態機），失敗的投遞依退避重試 ≤ 3 次。
 */
import type { NotifyChannel } from '@aeh/core';
import {
  insertNotifications,
  listAllFollows,
  listDueDeliveries,
  listFavoritesForReminders,
  listUnnotifiedEvents,
  markEventsNotified,
  recordDelivery,
  type Database,
} from '@aeh/db';
import {
  buildNewEventNotifications,
  dueReminders,
  matchNewEvents,
  nextDeliveryTime,
  type QuietHours,
} from '@aeh/notify';
import type { Logger } from 'pino';
import type { ChannelSender } from './channels';

export interface NotifyConfig {
  quietHours: QuietHours | null;
  saleLeadHours: number;
  eventReminderHour: number;
  digestThreshold: number;
}

export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  quietHours: { start: 23, end: 8 },
  saleLeadHours: 24,
  eventReminderHour: 18,
  digestThreshold: 3,
};

export interface NotifyDeps {
  db: Database;
  channels: Record<NotifyChannel, ChannelSender>;
  logger: Logger;
  config: NotifyConfig;
}

export interface NotifySummary {
  eventsChecked: number;
  newEventNotifications: number;
  reminderNotifications: number;
  deliveriesCreated: number;
  delivered: Record<'sent' | 'simulated' | 'retry' | 'gone', number>;
}

const HOUR = 3_600_000;

export async function runNotify(
  deps: NotifyDeps,
  opts: { now?: Date; dryRun?: boolean; skipDelivery?: boolean } = {},
): Promise<NotifySummary> {
  const now = opts.now ?? new Date();
  const { db, config, logger } = deps;
  const notBefore = nextDeliveryTime(now, config.quietHours);
  const summary: NotifySummary = {
    eventsChecked: 0,
    newEventNotifications: 0,
    reminderNotifications: 0,
    deliveriesCreated: 0,
    delivered: { sent: 0, simulated: 0, retry: 0, gone: 0 },
  };

  // 1. 新活動上架
  const events = await listUnnotifiedEvents(db);
  summary.eventsChecked = events.length;
  if (events.length) {
    const follows = await listAllFollows(db);
    const drafts = buildNewEventNotifications(matchNewEvents(events, follows, now), now, {
      digestThreshold: config.digestThreshold,
    });
    if (opts.dryRun) {
      summary.newEventNotifications = drafts.length;
      for (const d of drafts) logger.info({ draft: d }, '［dry-run］新活動通知');
    } else {
      const r = await insertNotifications(db, drafts, { notBefore });
      summary.newEventNotifications = r.notifications;
      summary.deliveriesCreated += r.deliveries;
      await markEventsNotified(
        db,
        events.map((e) => e.id),
        now,
      );
    }
  }

  // 2. 收藏提醒（查詢範圍要涵蓋「前一天 18:00」到開始時間，最長約 2 天）
  const horizon = Math.max(config.saleLeadHours * HOUR, 48 * HOUR);
  const favorites = await listFavoritesForReminders(db, now, horizon);
  const reminders = dueReminders(favorites, now, {
    saleLeadHours: config.saleLeadHours,
    eventReminderHour: config.eventReminderHour,
  });
  if (opts.dryRun) {
    summary.reminderNotifications = reminders.length;
    for (const d of reminders) logger.info({ draft: d }, '［dry-run］提醒通知');
  } else if (reminders.length) {
    // 勿擾延後若會超過開賣／開始時間，提醒就失去意義 → 改為立即送出
    const byEvent = new Map(favorites.map((f) => [f.event.id, f.event]));
    const timed = reminders.map((d) => {
      const e = byEvent.get(d.eventId!);
      const deadline = d.kind === 'sale_reminder' ? e?.saleStartAt : e?.startAt;
      return deadline && notBefore >= deadline ? { ...d, notBefore: now } : d;
    });
    const r = await insertNotifications(db, timed, { notBefore });
    summary.reminderNotifications = r.notifications;
    summary.deliveriesCreated += r.deliveries;
  }

  // 3. 投遞
  if (!opts.dryRun && !opts.skipDelivery) {
    for (const d of await listDueDeliveries(db, now)) {
      let outcome;
      try {
        outcome = await deps.channels[d.channel].send(d);
      } catch (err) {
        outcome = { status: 'retry' as const, error: (err as Error).message };
      }
      await recordDelivery(db, d, outcome, now);
      summary.delivered[outcome.status]++;
      if (outcome.status === 'retry' || outcome.status === 'gone')
        logger.warn({ deliveryId: d.id, channel: d.channel, outcome }, '推播未送達');
    }
  }

  logger.info({ summary }, 'notify 完成');
  return summary;
}
