/**
 * 通知與投遞（Phase 3）。比對／模板邏輯在 @aeh/notify（純函式），這裡只負責讀寫。
 *
 * 流程（apps/worker notify 工作）：
 *   1. listUnnotifiedEvents → 比對訂閱 → insertNotifications → markEventsNotified
 *   2. listFavoritesForReminders → 判斷提醒時機 → insertNotifications
 *   3. listDueDeliveries → 送出 → recordDelivery
 * notification.dedupe_key 唯一，所以排程重跑、CLI 與排程同時執行都不會重複通知。
 */
import type { DeliveryStatus, EventType, NotificationKind, NotifyChannel } from '@aeh/core';
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  event,
  eventTag,
  favorite,
  notification,
  notificationDelivery,
  pushSubscription,
  subscriber,
  tag,
  tagFollow,
  typeFollow,
  venue,
} from '../schema';
import type { Database } from '../client';
import type { DbOrTx } from './types';

/** 與 @aeh/notify NotifyEvent 相同結構（db 不依賴 notify） */
export interface NotifyEventRow {
  id: number;
  title: string;
  type: EventType | null;
  startAt: Date | null;
  endAt: Date | null;
  allDay: boolean;
  isOnline: boolean;
  venueName: string | null;
  city: string | null;
  saleStartAt: Date | null;
}

const notifyEventCols = {
  id: event.id,
  title: event.title,
  type: event.type,
  startAt: event.startAt,
  endAt: event.endAt,
  allDay: event.allDay,
  isOnline: event.isOnline,
  venueName: venue.name,
  city: event.city,
  saleStartAt: event.saleStartAt,
};

// ── 1. 新活動上架 ────────────────────────────────────────

/** 已發布但尚未做過「新活動上架」比對的活動（含標籤） */
export async function listUnnotifiedEvents(
  db: DbOrTx,
  limit = 200,
): Promise<(NotifyEventRow & { tags: { id: number; name: string }[] })[]> {
  const rows = await db
    .select({
      ...notifyEventCols,
      tags: sql<{ id: number; name: string }[]>`coalesce((
        select json_agg(json_build_object('id', t.id, 'name', t.name) order by t.kind, t.name)
        from ${eventTag} et join ${tag} t on t.id = et.tag_id
        where et.event_id = ${event.id}), '[]'::json)`,
    })
    .from(event)
    .leftJoin(venue, eq(venue.id, event.venueId))
    .where(and(eq(event.status, 'published'), isNull(event.newEventNotifiedAt)))
    .orderBy(asc(event.id))
    .limit(limit);
  return rows;
}

export async function markEventsNotified(
  db: DbOrTx,
  ids: readonly number[],
  now = new Date(),
): Promise<void> {
  if (!ids.length) return;
  await db
    .update(event)
    .set({ newEventNotifiedAt: now })
    .where(and(inArray(event.id, [...ids]), isNull(event.newEventNotifiedAt)));
}

/** 所有有訂閱的訪客（與 @aeh/notify SubscriberFollows 相同結構）；數量級小，一次載入 */
export async function listAllFollows(db: DbOrTx): Promise<
  {
    subscriberId: number;
    notifyNewEvent: boolean;
    tagIds: number[];
    types: EventType[];
  }[]
> {
  return db
    .select({
      subscriberId: subscriber.id,
      notifyNewEvent: subscriber.notifyNewEvent,
      tagIds: sql<number[]>`coalesce((select array_agg(tf.tag_id order by tf.tag_id)
        from ${tagFollow} tf where tf.subscriber_id = ${subscriber.id}), '{}')`,
      types: sql<EventType[]>`coalesce((select array_agg(ty.event_type::text order by ty.event_type)
        from ${typeFollow} ty where ty.subscriber_id = ${subscriber.id}), '{}')`,
    })
    .from(subscriber)
    .where(
      or(
        sql`exists (select 1 from ${tagFollow} where ${tagFollow.subscriberId} = ${subscriber.id})`,
        sql`exists (select 1 from ${typeFollow} where ${typeFollow.subscriberId} = ${subscriber.id})`,
      ),
    )
    .orderBy(asc(subscriber.id));
}

// ── 2. 收藏提醒 ──────────────────────────────────────────

/**
 * 可能需要提醒的收藏：已發布活動中，開賣或開始時間落在 (now, now + horizon]。
 * 實際是否到提醒時間由 @aeh/notify dueReminders 判斷。
 */
export async function listFavoritesForReminders(
  db: DbOrTx,
  now: Date,
  horizonMs: number,
): Promise<
  {
    subscriberId: number;
    notifySaleReminder: boolean;
    notifyEventReminder: boolean;
    event: NotifyEventRow;
  }[]
> {
  const until = new Date(now.getTime() + horizonMs);
  const rows = await db
    .select({
      subscriberId: favorite.subscriberId,
      notifySaleReminder: subscriber.notifySaleReminder,
      notifyEventReminder: subscriber.notifyEventReminder,
      ...notifyEventCols,
    })
    .from(favorite)
    .innerJoin(subscriber, eq(subscriber.id, favorite.subscriberId))
    .innerJoin(event, eq(event.id, favorite.eventId))
    .leftJoin(venue, eq(venue.id, event.venueId))
    .where(
      and(
        eq(event.status, 'published'),
        or(
          and(
            eq(subscriber.notifySaleReminder, true),
            gt(event.saleStartAt, now),
            lte(event.saleStartAt, until),
          ),
          and(
            eq(subscriber.notifyEventReminder, true),
            gt(event.startAt, now),
            lte(event.startAt, until),
          ),
        ),
      ),
    )
    .orderBy(asc(favorite.subscriberId), asc(event.id));
  return rows.map(({ subscriberId, notifySaleReminder, notifyEventReminder, ...e }) => ({
    subscriberId,
    notifySaleReminder,
    notifyEventReminder,
    event: e,
  }));
}

// ── 寫入通知 ─────────────────────────────────────────────

export interface NotificationInput {
  subscriberId: number;
  kind: NotificationKind;
  eventId: number | null;
  dedupeKey: string;
  title: string;
  body: string;
  path: string;
  /** 個別指定的最早投遞時間（覆寫 opts.notBefore；例如提醒不可延到開賣之後） */
  notBefore?: Date;
}

/**
 * 寫入通知（dedupe_key 衝突者略過），並為每則「新寫入」的通知建立站外投遞：
 * 訪客的每個 Web Push 端點各一筆、已綁定 LINE 者一筆。
 * `notBefore`：勿擾時段延後送出的時間。
 */
export async function insertNotifications(
  db: Database,
  drafts: readonly NotificationInput[],
  opts: { notBefore?: Date; channels?: readonly NotifyChannel[] } = {},
): Promise<{ notifications: number; deliveries: number }> {
  if (!drafts.length) return { notifications: 0, deliveries: 0 };
  const channels = new Set(opts.channels ?? ['web_push', 'line']);
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(notification)
      .values(drafts.map(({ notBefore: _nb, ...d }) => d))
      .onConflictDoNothing({ target: notification.dedupeKey })
      .returning({
        id: notification.id,
        subscriberId: notification.subscriberId,
        dedupeKey: notification.dedupeKey,
      });
    if (!inserted.length) return { notifications: 0, deliveries: 0 };

    const subIds = [...new Set(inserted.map((n) => n.subscriberId))];
    const [pushes, lines] = await Promise.all([
      channels.has('web_push')
        ? tx
            .select({ id: pushSubscription.id, subscriberId: pushSubscription.subscriberId })
            .from(pushSubscription)
            .where(inArray(pushSubscription.subscriberId, subIds))
        : [],
      channels.has('line')
        ? tx
            .select({ id: subscriber.id, lineUserId: subscriber.lineUserId })
            .from(subscriber)
            .where(and(inArray(subscriber.id, subIds), sql`${subscriber.lineUserId} is not null`))
        : [],
    ]);

    const fallback = opts.notBefore ?? new Date();
    const perDraft = new Map(drafts.map((d) => [d.dedupeKey, d.notBefore]));
    const deliveries: (typeof notificationDelivery.$inferInsert)[] = [];
    for (const n of inserted) {
      const notBefore = perDraft.get(n.dedupeKey) ?? fallback;
      for (const p of pushes) {
        if (p.subscriberId === n.subscriberId)
          deliveries.push({
            notificationId: n.id,
            channel: 'web_push',
            target: String(p.id),
            notBefore,
          });
      }
      for (const l of lines) {
        if (l.id === n.subscriberId && l.lineUserId)
          deliveries.push({
            notificationId: n.id,
            channel: 'line',
            target: l.lineUserId,
            notBefore,
          });
      }
    }
    if (deliveries.length)
      await tx.insert(notificationDelivery).values(deliveries).onConflictDoNothing();
    return { notifications: inserted.length, deliveries: deliveries.length };
  });
}

// ── 3. 投遞 ──────────────────────────────────────────────

export interface DueDelivery {
  id: number;
  channel: NotifyChannel;
  target: string;
  attempts: number;
  notification: { id: number; title: string; body: string; path: string; dedupeKey: string };
  /** Web Push 端點；訂閱已刪除時為 null */
  push: { id: number; endpoint: string; p256dh: string; auth: string } | null;
}

export async function listDueDeliveries(
  db: DbOrTx,
  now: Date,
  limit = 200,
): Promise<DueDelivery[]> {
  const rows = await db
    .select({
      id: notificationDelivery.id,
      channel: notificationDelivery.channel,
      target: notificationDelivery.target,
      attempts: notificationDelivery.attempts,
      nId: notification.id,
      title: notification.title,
      body: notification.body,
      path: notification.path,
      dedupeKey: notification.dedupeKey,
      pushId: pushSubscription.id,
      endpoint: pushSubscription.endpoint,
      p256dh: pushSubscription.p256dh,
      auth: pushSubscription.auth,
    })
    .from(notificationDelivery)
    .innerJoin(notification, eq(notification.id, notificationDelivery.notificationId))
    .leftJoin(
      pushSubscription,
      and(
        eq(notificationDelivery.channel, 'web_push'),
        sql`${pushSubscription.id}::text = ${notificationDelivery.target}`,
      ),
    )
    .where(
      and(eq(notificationDelivery.status, 'pending'), lte(notificationDelivery.notBefore, now)),
    )
    .orderBy(asc(notificationDelivery.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    target: r.target,
    attempts: r.attempts,
    notification: { id: r.nId, title: r.title, body: r.body, path: r.path, dedupeKey: r.dedupeKey },
    push:
      r.pushId !== null && r.endpoint && r.p256dh && r.auth
        ? { id: r.pushId, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }
        : null,
  }));
}

export type DeliveryOutcome =
  | { status: 'sent' }
  | { status: 'simulated' }
  | { status: 'gone'; error: string }
  | { status: 'retry'; error: string };

export const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * 記錄投遞結果：
 * - retry：attempts + 1，未達上限則 5 分鐘 × 2^n 後重試，達上限 → failed
 * - gone：端點失效 → 刪除該 Web Push 訂閱／解除 LINE 綁定，其餘待送的同目標投遞一併標記
 */
export async function recordDelivery(
  db: Database,
  d: Pick<DueDelivery, 'id' | 'channel' | 'target' | 'attempts'>,
  outcome: DeliveryOutcome,
  now = new Date(),
): Promise<void> {
  const attempts = d.attempts + 1;
  if (outcome.status === 'sent' || outcome.status === 'simulated') {
    await db.transaction(async (tx) => {
      await tx
        .update(notificationDelivery)
        .set({ status: outcome.status, attempts, sentAt: now, lastError: null })
        .where(eq(notificationDelivery.id, d.id));
      if (d.channel === 'web_push' && outcome.status === 'sent')
        await tx
          .update(pushSubscription)
          .set({ lastSuccessAt: now })
          .where(sql`${pushSubscription.id}::text = ${d.target}`);
    });
    return;
  }
  if (outcome.status === 'retry') {
    const final = attempts >= MAX_DELIVERY_ATTEMPTS;
    await db
      .update(notificationDelivery)
      .set({
        status: final ? 'failed' : 'pending',
        attempts,
        lastError: outcome.error.slice(0, 500),
        notBefore: new Date(now.getTime() + 5 * 60_000 * 2 ** (attempts - 1)),
      })
      .where(eq(notificationDelivery.id, d.id));
    return;
  }
  const goneError = outcome.error.slice(0, 500);
  await db.transaction(async (tx) => {
    await tx
      .update(notificationDelivery)
      .set({ status: 'gone', attempts, lastError: goneError })
      .where(
        and(
          eq(notificationDelivery.channel, d.channel),
          eq(notificationDelivery.target, d.target),
          or(eq(notificationDelivery.id, d.id), eq(notificationDelivery.status, 'pending')),
        ),
      );
    if (d.channel === 'web_push')
      await tx.delete(pushSubscription).where(sql`${pushSubscription.id}::text = ${d.target}`);
    else
      await tx
        .update(subscriber)
        .set({ lineUserId: null, lineLinkedAt: null })
        .where(eq(subscriber.lineUserId, d.target));
  });
}

// ── 站內通知匣 ───────────────────────────────────────────

export type InboxItem = Pick<
  typeof notification.$inferSelect,
  'id' | 'kind' | 'title' | 'body' | 'path' | 'createdAt' | 'readAt'
>;

export async function listInbox(
  db: DbOrTx,
  subscriberId: number,
  limit = 30,
): Promise<InboxItem[]> {
  return db
    .select({
      id: notification.id,
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
      path: notification.path,
      createdAt: notification.createdAt,
      readAt: notification.readAt,
    })
    .from(notification)
    .where(eq(notification.subscriberId, subscriberId))
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(limit);
}

export async function countUnread(db: DbOrTx, subscriberId: number): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notification)
    .where(and(eq(notification.subscriberId, subscriberId), isNull(notification.readAt)));
  return r?.n ?? 0;
}

export async function markInboxRead(
  db: DbOrTx,
  subscriberId: number,
  now = new Date(),
): Promise<void> {
  await db
    .update(notification)
    .set({ readAt: now })
    .where(and(eq(notification.subscriberId, subscriberId), isNull(notification.readAt)));
}

/** 投遞統計（CLI／除錯用） */
export async function deliveryStats(
  db: DbOrTx,
): Promise<{ channel: NotifyChannel; status: DeliveryStatus; n: number }[]> {
  return db
    .select({
      channel: notificationDelivery.channel,
      status: notificationDelivery.status,
      n: sql<number>`count(*)::int`,
    })
    .from(notificationDelivery)
    .groupBy(notificationDelivery.channel, notificationDelivery.status)
    .orderBy(asc(notificationDelivery.channel), asc(notificationDelivery.status));
}

/** 刪除過舊通知（cleanup 排程；投遞紀錄 cascade） */
export async function deleteOldNotifications(db: DbOrTx, before: Date): Promise<number> {
  const rows = await db
    .delete(notification)
    .where(lt(notification.createdAt, before))
    .returning({ id: notification.id });
  return rows.length;
}
