/**
 * 訪客端：匿名訂閱者、收藏、標籤／類型訂閱、Web Push 訂閱、LINE 綁定（Phase 3）。
 * 只能收藏／訂閱前台看得到的資料（已發布或已結束的活動、既有標籤）。
 */
import type { EventType, TagKind } from '@aeh/core';
import { and, asc, eq, gt, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import {
  event,
  favorite,
  pushSubscription,
  subscriber,
  tag,
  tagFollow,
  typeFollow,
} from '../schema';
import type { Database } from '../client';
import type { PublicEventTag } from './public-event';
import type { DbOrTx } from './types';

export type SubscriberRow = typeof subscriber.$inferSelect;

export interface SubscriberPrefs {
  notifyNewEvent: boolean;
  notifySaleReminder: boolean;
  notifyEventReminder: boolean;
}

export async function createSubscriber(db: DbOrTx, tokenHash: string): Promise<SubscriberRow> {
  const [row] = await db.insert(subscriber).values({ tokenHash }).returning();
  return row!;
}

export async function findSubscriberByTokenHash(
  db: DbOrTx,
  tokenHash: string,
): Promise<SubscriberRow | null> {
  const [row] = await db.select().from(subscriber).where(eq(subscriber.tokenHash, tokenHash));
  return row ?? null;
}

export async function getSubscriber(db: DbOrTx, id: number): Promise<SubscriberRow | null> {
  const [row] = await db.select().from(subscriber).where(eq(subscriber.id, id));
  return row ?? null;
}

/** 最後使用時間（一天最多更新一次，避免每個請求都寫入） */
export async function touchSubscriber(db: DbOrTx, id: number, now = new Date()): Promise<void> {
  await db
    .update(subscriber)
    .set({ lastSeenAt: now })
    .where(
      and(eq(subscriber.id, id), lt(subscriber.lastSeenAt, new Date(now.getTime() - 86_400_000))),
    );
}

/** 「刪除我的資料」：收藏、訂閱、推播端點、通知一併刪除（FK cascade） */
export async function deleteSubscriber(db: DbOrTx, id: number): Promise<void> {
  await db.delete(subscriber).where(eq(subscriber.id, id));
}

export async function updateSubscriberPrefs(
  db: DbOrTx,
  id: number,
  prefs: SubscriberPrefs,
): Promise<void> {
  await db.update(subscriber).set(prefs).where(eq(subscriber.id, id));
}

// ── 收藏 ─────────────────────────────────────────────────

/** 收藏／取消收藏；只接受前台看得到的活動。回傳是否成功（活動不存在或未公開 → false） */
export async function setFavorite(
  db: DbOrTx,
  subscriberId: number,
  eventId: number,
  on: boolean,
): Promise<boolean> {
  if (!on) {
    await db
      .delete(favorite)
      .where(and(eq(favorite.subscriberId, subscriberId), eq(favorite.eventId, eventId)));
    return true;
  }
  const [visible] = await db
    .select({ id: event.id })
    .from(event)
    .where(and(eq(event.id, eventId), inArray(event.status, ['published', 'ended'])));
  if (!visible) return false;
  await db.insert(favorite).values({ subscriberId, eventId }).onConflictDoNothing();
  return true;
}

/** 收藏的活動 id（依收藏時間新到舊） */
export async function listFavoriteEventIds(db: DbOrTx, subscriberId: number): Promise<number[]> {
  const rows = await db
    .select({ eventId: favorite.eventId })
    .from(favorite)
    .innerJoin(event, eq(event.id, favorite.eventId))
    .where(
      and(eq(favorite.subscriberId, subscriberId), inArray(event.status, ['published', 'ended'])),
    )
    .orderBy(sql`${favorite.createdAt} desc`);
  return rows.map((r) => r.eventId);
}

// ── 標籤／類型訂閱 ───────────────────────────────────────

export async function setTagFollow(
  db: DbOrTx,
  subscriberId: number,
  ref: { kind: TagKind; slug: string },
  on: boolean,
): Promise<boolean> {
  const [t] = await db
    .select({ id: tag.id })
    .from(tag)
    .where(and(eq(tag.kind, ref.kind), eq(tag.slug, ref.slug)));
  if (!t) return false;
  if (on) {
    await db.insert(tagFollow).values({ subscriberId, tagId: t.id }).onConflictDoNothing();
  } else {
    await db
      .delete(tagFollow)
      .where(and(eq(tagFollow.subscriberId, subscriberId), eq(tagFollow.tagId, t.id)));
  }
  return true;
}

export async function setTypeFollow(
  db: DbOrTx,
  subscriberId: number,
  eventType: EventType,
  on: boolean,
): Promise<void> {
  if (on) {
    await db.insert(typeFollow).values({ subscriberId, eventType }).onConflictDoNothing();
  } else {
    await db
      .delete(typeFollow)
      .where(and(eq(typeFollow.subscriberId, subscriberId), eq(typeFollow.eventType, eventType)));
  }
}

export interface SubscriberFollowList {
  tags: PublicEventTag[];
  types: EventType[];
}

export async function getFollows(db: DbOrTx, subscriberId: number): Promise<SubscriberFollowList> {
  const [tags, types] = await Promise.all([
    db
      .select({ kind: tag.kind, slug: tag.slug, name: tag.name })
      .from(tagFollow)
      .innerJoin(tag, eq(tag.id, tagFollow.tagId))
      .where(eq(tagFollow.subscriberId, subscriberId))
      .orderBy(asc(tag.kind), asc(tag.name)),
    db
      .select({ t: typeFollow.eventType })
      .from(typeFollow)
      .where(eq(typeFollow.subscriberId, subscriberId))
      .orderBy(asc(typeFollow.eventType)),
  ]);
  return { tags, types: types.map((r) => r.t) };
}

// ── Web Push ─────────────────────────────────────────────

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/** 同一端點重新訂閱（換訪客身分或金鑰輪替）時覆寫 */
export async function savePushSubscription(
  db: DbOrTx,
  subscriberId: number,
  input: PushSubscriptionInput,
): Promise<void> {
  const values = {
    subscriberId,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    userAgent: input.userAgent ?? null,
  };
  await db
    .insert(pushSubscription)
    .values(values)
    .onConflictDoUpdate({ target: pushSubscription.endpoint, set: values });
}

export async function deletePushSubscription(
  db: DbOrTx,
  subscriberId: number,
  endpoint: string,
): Promise<void> {
  await db
    .delete(pushSubscription)
    .where(
      and(eq(pushSubscription.subscriberId, subscriberId), eq(pushSubscription.endpoint, endpoint)),
    );
}

export async function listPushEndpoints(db: DbOrTx, subscriberId: number): Promise<string[]> {
  const rows = await db
    .select({ endpoint: pushSubscription.endpoint })
    .from(pushSubscription)
    .where(eq(pushSubscription.subscriberId, subscriberId));
  return rows.map((r) => r.endpoint);
}

// ── LINE 綁定 ────────────────────────────────────────────

export async function setLineLinkCode(
  db: DbOrTx,
  subscriberId: number,
  code: string,
  expiresAt: Date,
): Promise<void> {
  await db
    .update(subscriber)
    .set({ lineLinkCode: code, lineLinkCodeExpiresAt: expiresAt })
    .where(eq(subscriber.id, subscriberId));
}

export type LineLinkResult = 'linked' | 'already_linked' | 'invalid_code';

/**
 * 以綁定碼連結 LINE userId。同一個 LINE 帳號只能綁定一個訪客：
 * 在新瀏覽器重新綁定時，舊的綁定會移到新的訪客（以最後一次為準）。
 */
export async function linkLineByCode(
  db: Database,
  code: string,
  lineUserId: string,
  now = new Date(),
): Promise<LineLinkResult> {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: subscriber.id, lineUserId: subscriber.lineUserId })
      .from(subscriber)
      .where(and(eq(subscriber.lineLinkCode, code), gt(subscriber.lineLinkCodeExpiresAt, now)))
      .for('update');
    if (!owner) return 'invalid_code';
    if (owner.lineUserId === lineUserId) {
      await tx
        .update(subscriber)
        .set({ lineLinkCode: null, lineLinkCodeExpiresAt: null })
        .where(eq(subscriber.id, owner.id));
      return 'already_linked';
    }
    await tx
      .update(subscriber)
      .set({ lineUserId: null, lineLinkedAt: null })
      .where(and(eq(subscriber.lineUserId, lineUserId), ne(subscriber.id, owner.id)));
    await tx
      .update(subscriber)
      .set({ lineUserId, lineLinkedAt: now, lineLinkCode: null, lineLinkCodeExpiresAt: null })
      .where(eq(subscriber.id, owner.id));
    return 'linked';
  });
}

/** 解除綁定（網站上按「解除」、LINE 傳「解除綁定」或封鎖官方帳號） */
export async function unlinkLine(
  db: DbOrTx,
  by: { subscriberId: number } | { lineUserId: string },
): Promise<boolean> {
  const rows = await db
    .update(subscriber)
    .set({ lineUserId: null, lineLinkedAt: null })
    .where(
      and(
        isNotNull(subscriber.lineUserId),
        'subscriberId' in by
          ? eq(subscriber.id, by.subscriberId)
          : eq(subscriber.lineUserId, by.lineUserId),
      ),
    )
    .returning({ id: subscriber.id });
  return rows.length > 0;
}

/** 清掉過期綁定碼（cleanup 排程） */
export async function clearExpiredLinkCodes(db: DbOrTx, now = new Date()): Promise<number> {
  const rows = await db
    .update(subscriber)
    .set({ lineLinkCode: null, lineLinkCodeExpiresAt: null })
    .where(lt(subscriber.lineLinkCodeExpiresAt, now))
    .returning({ id: subscriber.id });
  return rows.length;
}
