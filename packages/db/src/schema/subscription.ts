/**
 * 訂閱與推播（Phase 3，企劃 §3-3）。
 *
 * MVP 不做會員帳號：訪客第一次收藏／訂閱時建立匿名 subscriber，
 * 以隨機 token 存在 httpOnly cookie，DB 只存 token 的 SHA-256（外洩 DB 也無法冒用 cookie）。
 * 站外管道：Web Push 訂閱（每個瀏覽器一筆）與 LINE 官方帳號（以綁定碼連結 userId）。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, tstz } from './_helpers';
import { tag } from './dictionary';
import {
  deliveryStatusEnum,
  eventTypeEnum,
  notificationKindEnum,
  notifyChannelEnum,
} from './enums';
import { event } from './event';

export const subscriber = pgTable('subscriber', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  /** SHA-256(cookie token)，hex */
  tokenHash: text('token_hash').notNull().unique(),
  /** 通知偏好：訂閱標籤／類型的新活動上架 */
  notifyNewEvent: boolean('notify_new_event').notNull().default(true),
  /** 通知偏好：收藏活動開賣前提醒 */
  notifySaleReminder: boolean('notify_sale_reminder').notNull().default(true),
  /** 通知偏好：收藏活動舉辦前一天提醒 */
  notifyEventReminder: boolean('notify_event_reminder').notNull().default(true),
  /** LINE 官方帳號的 userId（綁定後才有） */
  lineUserId: text('line_user_id').unique(),
  lineLinkedAt: tstz('line_linked_at'),
  /** 一次性綁定碼（使用者在 LINE 傳「綁定 XXXXXX」），逾時失效 */
  lineLinkCode: text('line_link_code').unique(),
  lineLinkCodeExpiresAt: tstz('line_link_code_expires_at'),
  createdAt: createdAt(),
  lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
});

/** Web Push 訂閱（PushSubscription.toJSON()）；一個 subscriber 可有多個瀏覽器 */
export const pushSubscription = pgTable(
  'push_subscription',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    subscriberId: bigint('subscriber_id', { mode: 'number' })
      .notNull()
      .references(() => subscriber.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSuccessAt: tstz('last_success_at'),
  },
  (t) => [index('push_subscription_subscriber_idx').on(t.subscriberId)],
);

/** 收藏活動（開賣前／舉辦前一天提醒的對象） */
export const favorite = pgTable(
  'favorite',
  {
    subscriberId: bigint('subscriber_id', { mode: 'number' })
      .notNull()
      .references(() => subscriber.id, { onDelete: 'cascade' }),
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.subscriberId, t.eventId] }),
    index('favorite_event_idx').on(t.eventId),
  ],
);

/** 訂閱代理商／作品／聲優／歌手標籤 */
export const tagFollow = pgTable(
  'tag_follow',
  {
    subscriberId: bigint('subscriber_id', { mode: 'number' })
      .notNull()
      .references(() => subscriber.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.subscriberId, t.tagId] }),
    index('tag_follow_tag_idx').on(t.tagId),
  ],
);

/** 訂閱活動類型 */
export const typeFollow = pgTable(
  'type_follow',
  {
    subscriberId: bigint('subscriber_id', { mode: 'number' })
      .notNull()
      .references(() => subscriber.id, { onDelete: 'cascade' }),
    eventType: eventTypeEnum('event_type').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.subscriberId, t.eventType] })],
);

/**
 * 通知（站內通知匣 ＋ 推播的共同來源）。
 * dedupe_key 唯一 → 排程重跑不會重複通知（idempotent）。
 */
export const notification = pgTable(
  'notification',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    subscriberId: bigint('subscriber_id', { mode: 'number' })
      .notNull()
      .references(() => subscriber.id, { onDelete: 'cascade' }),
    kind: notificationKindEnum('kind').notNull(),
    eventId: bigint('event_id', { mode: 'number' }).references(() => event.id, {
      onDelete: 'set null',
    }),
    dedupeKey: text('dedupe_key').notNull().unique(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** 站內相對路徑（/events/123）；LINE 訊息會補上 PUBLIC_BASE_URL */
    path: text('path').notNull(),
    createdAt: createdAt(),
    readAt: tstz('read_at'),
  },
  (t) => [index('notification_subscriber_idx').on(t.subscriberId, t.createdAt)],
);

/** 每則通知 × 每個站外目標一筆；失敗重試 ≤ 3 次 */
export const notificationDelivery = pgTable(
  'notification_delivery',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    notificationId: bigint('notification_id', { mode: 'number' })
      .notNull()
      .references(() => notification.id, { onDelete: 'cascade' }),
    channel: notifyChannelEnum('channel').notNull(),
    /** Web Push：push_subscription.id；LINE：userId */
    target: text('target').notNull(),
    status: deliveryStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** 勿擾時段／重試退避：早於此時間不送 */
    notBefore: tstz('not_before').notNull().defaultNow(),
    lastError: text('last_error'),
    sentAt: tstz('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('notification_delivery_target_uq').on(t.notificationId, t.channel, t.target),
    index('notification_delivery_pending_idx')
      .on(t.notBefore)
      .where(sql`${t.status} = 'pending'`),
  ],
);
