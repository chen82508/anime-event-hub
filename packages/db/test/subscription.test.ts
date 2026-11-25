import type { NormalizedEvent } from '@aeh/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DICTIONARY_DIR,
  addEventTags,
  countUnread,
  createSubscriber,
  deleteOldNotifications,
  deleteSubscriber,
  event,
  findSubscriberByTokenHash,
  getFollows,
  getSubscriber,
  insertEvent,
  insertNotifications,
  linkLineByCode,
  listAllFollows,
  listDueDeliveries,
  listFavoriteEventIds,
  listFavoritesForReminders,
  listInbox,
  listPublicEvents,
  listPushEndpoints,
  listUnnotifiedEvents,
  loadDictionaries,
  markEventsNotified,
  markInboxRead,
  notificationDelivery,
  pushSubscription,
  recordDelivery,
  runMigrations,
  savePushSubscription,
  seedDictionaries,
  setFavorite,
  setLineLinkCode,
  setTagFollow,
  setTypeFollow,
  tag,
  unlinkLine,
  venue,
  type Database,
  type DbHandle,
  type NotificationInput,
} from '../src';
import { TEST_DB_URL, freshTestDb } from './helpers';

const NOW = new Date('2026-11-25T04:00:00Z'); // 台灣 12:00

describe.skipIf(!TEST_DB_URL)('訂閱與推播（Phase 3）', () => {
  let handle: DbHandle;
  let db: Database;
  let venueId: number;
  let tagA: {
    id: number;
    kind: 'work' | 'agency' | 'voice_actor' | 'artist';
    slug: string;
    name: string;
  };

  beforeAll(async () => {
    handle = await freshTestDb();
    db = handle.db;
    await runMigrations(db);
    await seedDictionaries(db, await loadDictionaries(DEFAULT_DICTIONARY_DIR));
    venueId = (await db.select().from(venue).where(eq(venue.slug, 'taipei-arena')))[0]!.id;
    const t = (await db.select().from(tag).limit(1))[0]!;
    tagA = { id: t.id, kind: t.kind, slug: t.slug, name: t.name };
  });
  afterAll(async () => {
    await handle?.close();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate event, subscriber restart identity cascade`);
  });

  async function seedEvent(
    over: Partial<NormalizedEvent> = {},
    status: 'published' | 'pending_review' = 'published',
  ): Promise<number> {
    return insertEvent(db, {
      normalized: {
        sourceId: 'kktix',
        externalId: 'x',
        sourceUrl: 'https://example.kktix.cc/events/x',
        title: '測試演唱會',
        titleNormalized: '測試演唱會',
        type: 'concert',
        startAt: new Date('2026-12-12T11:00:00Z'),
        endAt: null,
        allDay: false,
        yearInferred: false,
        venueId,
        venueRaw: null,
        isOnline: false,
        city: '台北市',
        region: 'north',
        priceMin: null,
        priceMax: null,
        isFree: false,
        saleStartAt: null,
        reviewReasons: status === 'pending_review' ? ['type_unresolved'] : [],
        ...over,
      },
      status,
      dedupKey: null,
      notes: [],
    });
  }

  const draft = (
    subscriberId: number,
    key: string,
    eventId: number | null = null,
  ): NotificationInput => ({
    subscriberId,
    kind: 'test',
    eventId,
    dedupeKey: key,
    title: 't',
    body: 'b',
    path: '/me',
  });

  it('訪客：以 token hash 查詢、刪除時一併刪除收藏與推播端點', async () => {
    const s = await createSubscriber(db, 'hash-1');
    expect((await findSubscriberByTokenHash(db, 'hash-1'))?.id).toBe(s.id);
    expect(await findSubscriberByTokenHash(db, 'nope')).toBeNull();
    const e = await seedEvent();
    await setFavorite(db, s.id, e, true);
    await savePushSubscription(db, s.id, {
      endpoint: 'https://fcm.googleapis.com/a',
      p256dh: 'p',
      auth: 'a',
    });
    await deleteSubscriber(db, s.id);
    expect(await db.select().from(pushSubscription)).toHaveLength(0);
    expect(await getSubscriber(db, s.id)).toBeNull();
  });

  it('收藏：只接受前台可見的活動；可重複執行；依收藏時間新到舊', async () => {
    const s = await createSubscriber(db, 'h');
    const a = await seedEvent({ title: 'A' });
    const b = await seedEvent({ title: 'B' });
    const pending = await seedEvent({ title: '待審' }, 'pending_review');
    expect(await setFavorite(db, s.id, a, true)).toBe(true);
    expect(await setFavorite(db, s.id, a, true)).toBe(true);
    await db.execute(sql`update favorite set created_at = now() - interval '1 hour'`);
    expect(await setFavorite(db, s.id, b, true)).toBe(true);
    expect(await setFavorite(db, s.id, pending, true)).toBe(false);
    expect(await setFavorite(db, s.id, 999_999, true)).toBe(false);
    expect(await listFavoriteEventIds(db, s.id)).toEqual([b, a]);
    // 收藏頁：ids 篩選（含已結束）；空陣列 → 0 筆
    expect(
      (await listPublicEvents(db, { ids: [a], includeEnded: true })).rows.map((r) => r.id),
    ).toEqual([a]);
    expect((await listPublicEvents(db, { ids: [] })).total).toBe(0);
    await setFavorite(db, s.id, a, false);
    expect(await listFavoriteEventIds(db, s.id)).toEqual([b]);
  });

  it('標籤／類型訂閱', async () => {
    const s = await createSubscriber(db, 'h');
    expect(await setTagFollow(db, s.id, tagA, true)).toBe(true);
    expect(await setTagFollow(db, s.id, { kind: 'work', slug: 'no-such-tag' }, true)).toBe(false);
    await setTypeFollow(db, s.id, 'doujin', true);
    await setTypeFollow(db, s.id, 'concert', true);
    await setTypeFollow(db, s.id, 'concert', true);
    expect(await getFollows(db, s.id)).toEqual({
      tags: [{ kind: tagA.kind, slug: tagA.slug, name: tagA.name }],
      types: ['concert', 'doujin'],
    });
    const other = await createSubscriber(db, 'h2'); // 沒有訂閱 → 不出現在比對清單
    expect(await listAllFollows(db)).toEqual([
      { subscriberId: s.id, notifyNewEvent: true, tagIds: [tagA.id], types: ['concert', 'doujin'] },
    ]);
    expect(other.id).toBeGreaterThan(s.id);
    await setTypeFollow(db, s.id, 'concert', false);
    await setTagFollow(db, s.id, tagA, false);
    expect(await getFollows(db, s.id)).toEqual({ tags: [], types: ['doujin'] });
  });

  it('Web Push：同一端點重新訂閱時轉移給新訪客', async () => {
    const s1 = await createSubscriber(db, 'h1');
    const s2 = await createSubscriber(db, 'h2');
    const ep = { endpoint: 'https://fcm.googleapis.com/x', p256dh: 'p', auth: 'a' };
    await savePushSubscription(db, s1.id, ep);
    await savePushSubscription(db, s2.id, { ...ep, auth: 'b' });
    expect(await listPushEndpoints(db, s1.id)).toEqual([]);
    expect(await listPushEndpoints(db, s2.id)).toEqual([ep.endpoint]);
  });

  it('LINE 綁定：綁定碼過期／錯誤、重複綁定、換瀏覽器重新綁定、解除', async () => {
    const s1 = await createSubscriber(db, 'h1');
    const s2 = await createSubscriber(db, 'h2');
    const later = new Date(NOW.getTime() + 600_000);
    await setLineLinkCode(db, s1.id, 'ABC234', later);
    expect(await linkLineByCode(db, 'ZZZ999', 'U1', NOW)).toBe('invalid_code');
    expect(await linkLineByCode(db, 'ABC234', 'U1', new Date(later.getTime() + 1))).toBe(
      'invalid_code',
    );
    expect(await linkLineByCode(db, 'ABC234', 'U1', NOW)).toBe('linked');
    expect((await getSubscriber(db, s1.id))!.lineLinkCode).toBeNull();
    // 綁定碼用過即失效
    expect(await linkLineByCode(db, 'ABC234', 'U1', NOW)).toBe('invalid_code');
    await setLineLinkCode(db, s1.id, 'DEF234', later);
    expect(await linkLineByCode(db, 'DEF234', 'U1', NOW)).toBe('already_linked');
    // 同一 LINE 帳號在另一個瀏覽器綁定 → 移轉
    await setLineLinkCode(db, s2.id, 'GHJ234', later);
    expect(await linkLineByCode(db, 'GHJ234', 'U1', NOW)).toBe('linked');
    expect((await getSubscriber(db, s1.id))!.lineUserId).toBeNull();
    expect((await getSubscriber(db, s2.id))!.lineUserId).toBe('U1');
    expect(await unlinkLine(db, { lineUserId: 'U1' })).toBe(true);
    expect(await unlinkLine(db, { subscriberId: s2.id })).toBe(false);
  });

  it('新活動上架：只列已發布且未通知者，標記後不再出現', async () => {
    const a = await seedEvent({ title: 'A' });
    await seedEvent({ title: '待審' }, 'pending_review');
    await addEventTags(db, a, [{ tagId: tagA.id, origin: 'dict', matchedBy: null }]);
    const list = await listUnnotifiedEvents(db);
    expect(list.map((e) => [e.id, e.venueName, e.tags])).toEqual([
      [a, expect.any(String), [{ id: tagA.id, name: tagA.name }]],
    ]);
    await markEventsNotified(db, [a], NOW);
    expect(await listUnnotifiedEvents(db)).toEqual([]);
  });

  it('寫入通知：dedupe_key 去重、依訪客的管道建立投遞', async () => {
    const s = await createSubscriber(db, 'h');
    const bare = await createSubscriber(db, 'h2');
    await savePushSubscription(db, s.id, {
      endpoint: 'https://fcm.googleapis.com/1',
      p256dh: 'p',
      auth: 'a',
    });
    await savePushSubscription(db, s.id, {
      endpoint: 'https://fcm.googleapis.com/2',
      p256dh: 'p',
      auth: 'a',
    });
    await setLineLinkCode(db, s.id, 'ABC234', new Date(NOW.getTime() + 60_000));
    await linkLineByCode(db, 'ABC234', 'U1', NOW);

    const notBefore = new Date(NOW.getTime() + 3600_000);
    const r1 = await insertNotifications(db, [draft(s.id, 'k1'), draft(bare.id, 'k2')], {
      notBefore,
    });
    expect(r1).toEqual({ notifications: 2, deliveries: 3 }); // 2 個推播端點 + LINE；bare 只有通知匣
    expect(await insertNotifications(db, [draft(s.id, 'k1')])).toEqual({
      notifications: 0,
      deliveries: 0,
    });
    expect(await countUnread(db, s.id)).toBe(1);

    // 勿擾：notBefore 之前不會被取出
    expect(await listDueDeliveries(db, NOW)).toEqual([]);
    const due = await listDueDeliveries(db, notBefore);
    expect(due.map((d) => d.channel).sort()).toEqual(['line', 'web_push', 'web_push']);
    expect(due.find((d) => d.channel === 'line')!.target).toBe('U1');
    expect(due.find((d) => d.channel === 'web_push')!.push?.endpoint).toMatch(/^https:\/\/fcm/);

    // 只建立指定管道
    const r2 = await insertNotifications(db, [draft(s.id, 'k3')], { channels: ['line'] });
    expect(r2.deliveries).toBe(1);
  });

  it('投遞結果：sent／retry 退避後 failed／gone 移除端點並停止同目標待送', async () => {
    const s = await createSubscriber(db, 'h');
    await savePushSubscription(db, s.id, {
      endpoint: 'https://fcm.googleapis.com/1',
      p256dh: 'p',
      auth: 'a',
    });
    await insertNotifications(db, [draft(s.id, 'a'), draft(s.id, 'b'), draft(s.id, 'c')], {
      notBefore: NOW,
    });
    const [d1, d2, d3] = await listDueDeliveries(db, NOW);

    await recordDelivery(db, d1!, { status: 'sent' }, NOW);
    const [row1] = await db
      .select()
      .from(notificationDelivery)
      .where(eq(notificationDelivery.id, d1!.id));
    expect(row1).toMatchObject({ status: 'sent', attempts: 1 });
    expect((await db.select().from(pushSubscription))[0]!.lastSuccessAt).toEqual(NOW);

    // retry：5 分鐘 → 10 分鐘 → 第 3 次失敗即 failed
    let d = d2!;
    for (const [i, minutes] of [
      [1, 5],
      [2, 10],
    ] as const) {
      await recordDelivery(db, d, { status: 'retry', error: '503' }, NOW);
      const [row] = await db
        .select()
        .from(notificationDelivery)
        .where(eq(notificationDelivery.id, d.id));
      expect(row).toMatchObject({ status: 'pending', attempts: i, lastError: '503' });
      expect(row!.notBefore.getTime() - NOW.getTime()).toBe(minutes * 60_000);
      d = { ...d, attempts: i };
    }
    await recordDelivery(db, d, { status: 'retry', error: '503' }, NOW);
    expect(
      (await db.select().from(notificationDelivery).where(eq(notificationDelivery.id, d.id)))[0]!
        .status,
    ).toBe('failed');

    // gone：端點刪除，同目標的其他待送也標記 gone
    await db
      .update(notificationDelivery)
      .set({ status: 'pending', attempts: 0 })
      .where(eq(notificationDelivery.id, d2!.id));
    await recordDelivery(db, d3!, { status: 'gone', error: '410' }, NOW);
    expect(await db.select().from(pushSubscription)).toHaveLength(0);
    const statuses = (await db.select().from(notificationDelivery)).map((r) => [r.id, r.status]);
    expect(statuses).toEqual(
      expect.arrayContaining([
        [d1!.id, 'sent'],
        [d2!.id, 'gone'],
        [d3!.id, 'gone'],
      ]),
    );
  });

  it('LINE 投遞 gone → 解除綁定', async () => {
    const s = await createSubscriber(db, 'h');
    await setLineLinkCode(db, s.id, 'ABC234', new Date(NOW.getTime() + 60_000));
    await linkLineByCode(db, 'ABC234', 'U1', NOW);
    await insertNotifications(db, [draft(s.id, 'a')], { notBefore: NOW });
    const [d] = await listDueDeliveries(db, NOW);
    await recordDelivery(db, d!, { status: 'gone', error: 'blocked' }, NOW);
    expect((await getSubscriber(db, s.id))!.lineUserId).toBeNull();
  });

  it('提醒候選：只含已發布、偏好開啟、開賣或開始時間在範圍內的收藏', async () => {
    const s = await createSubscriber(db, 'h');
    const soonSale = await seedEvent({
      title: '快開賣',
      saleStartAt: new Date(NOW.getTime() + 3600_000),
    });
    const far = await seedEvent({ title: '很久以後', startAt: new Date('2027-06-01T10:00:00Z') });
    const tomorrow = await seedEvent({
      title: '明天',
      startAt: new Date(NOW.getTime() + 26 * 3600_000),
    });
    for (const e of [soonSale, far, tomorrow]) await setFavorite(db, s.id, e, true);
    const horizon = 48 * 3600_000;
    const ids = async () =>
      (await listFavoritesForReminders(db, NOW, horizon))
        .map((f) => f.event.id)
        .sort((a, b) => a - b);
    expect(await ids()).toEqual([soonSale, tomorrow]);
    await db.update(event).set({ status: 'cancelled' }).where(eq(event.id, tomorrow));
    expect(await ids()).toEqual([soonSale]);
    await db.execute(sql`update subscriber set notify_sale_reminder = false`);
    expect(await ids()).toEqual([]);
  });

  it('通知匣：新到舊、標為已讀、過舊刪除', async () => {
    const s = await createSubscriber(db, 'h');
    await insertNotifications(db, [draft(s.id, 'old'), draft(s.id, 'new')]);
    await db.execute(
      sql`update notification set created_at = now() - interval '100 days' where dedupe_key = 'old'`,
    );
    expect((await listInbox(db, s.id)).map((n) => n.title)).toHaveLength(2);
    await markInboxRead(db, s.id, NOW);
    expect(await countUnread(db, s.id)).toBe(0);
    expect(await deleteOldNotifications(db, new Date(Date.now() - 90 * 86_400_000))).toBe(1);
    expect(await listInbox(db, s.id)).toHaveLength(1);
  });
});
