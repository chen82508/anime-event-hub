import { createECDH, randomBytes } from 'node:crypto';
import type { NormalizedEvent, NotifyChannel } from '@aeh/core';
import {
  createSubscriber,
  event,
  insertEvent,
  linkLineByCode,
  notification,
  notificationDelivery,
  pushSubscription,
  savePushSubscription,
  setFavorite,
  setLineLinkCode,
  setTypeFollow,
  venue,
  type DbHandle,
  type DeliveryOutcome,
  type DueDelivery,
} from '@aeh/db';
import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateRequestDetails, generateVAPIDKeys } from 'web-push';
import {
  consoleSender,
  createChannels,
  lineSender,
  retryKeyOf,
  webPushSender,
  type ChannelSender,
} from '../src/notify/channels';
import { DEFAULT_NOTIFY_CONFIG, runNotify, type NotifyDeps } from '../src/notify/job';
import { runSource } from '../src/pipeline';
import { WORKER_TEST_DB_URL, freshWorkerDb, html, makeDeps, scraperFixture } from './helpers';

const silent = pino({ level: 'silent' });
/** 台灣時間 → Date */
const tw = (s: string) => new Date(`${s}+08:00`);

function fakeDelivery(over: Partial<DueDelivery> = {}): DueDelivery {
  return {
    id: 7,
    channel: 'web_push',
    target: '1',
    attempts: 0,
    notification: { id: 1, title: '標題', body: '內文', path: '/events/1', dedupeKey: 'k' },
    push: { id: 1, endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'p', auth: 'a' },
    ...over,
  };
}

describe('推播管道（不需 DB）', () => {
  it('consoleSender：只寫 log，回傳 simulated', async () => {
    const s = consoleSender('line', silent, 'http://localhost:3000');
    expect(await s.send(fakeDelivery({ channel: 'line', target: 'U123' }))).toEqual({
      status: 'simulated',
    });
  });

  it('createChannels：console 模式全部模擬；live 缺金鑰的管道退回模擬', () => {
    const c = createChannels({ mode: 'console', baseUrl: 'http://x' }, silent);
    expect([c.web_push.mode, c.line.mode]).toEqual(['console', 'console']);
    const live = createChannels(
      { mode: 'live', baseUrl: 'http://x', lineAccessToken: 't' },
      silent,
    );
    expect([live.web_push.mode, live.line.mode]).toEqual(['console', 'live']);
  });

  it('webPushSender：成功／404・410 → gone／其它錯誤 → retry／端點不在白名單 → gone', async () => {
    const cfg = { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:ops@example.invalid' };
    const calls: unknown[][] = [];
    const ok = webPushSender(cfg, (async (...args: unknown[]) => {
      calls.push(args);
      return { statusCode: 201, body: '', headers: {} };
    }) as never);
    expect(await ok.send(fakeDelivery())).toEqual({ status: 'sent' });
    const [sub, payload, opts] = calls[0]!;
    expect(sub).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(JSON.parse(payload as string)).toEqual({
      title: '標題',
      body: '內文',
      url: '/events/1',
      tag: 'k',
    });
    expect(opts).toMatchObject({ TTL: 86400, urgency: 'normal', vapidDetails: cfg });

    const failWith = (statusCode?: number) =>
      webPushSender(cfg, (async () => {
        throw Object.assign(new Error('boom'), { statusCode });
      }) as never);
    expect((await failWith(410).send(fakeDelivery())).status).toBe('gone');
    expect((await failWith(404).send(fakeDelivery())).status).toBe('gone');
    expect((await failWith(500).send(fakeDelivery())).status).toBe('retry');
    expect((await failWith(undefined).send(fakeDelivery())).status).toBe('retry');
    expect((await ok.send(fakeDelivery({ push: null }))).status).toBe('gone');
    const ssrf = fakeDelivery({
      push: { id: 1, endpoint: 'https://169.254.169.254/x', p256dh: 'p', auth: 'a' },
    });
    expect((await ok.send(ssrf)).status).toBe('gone');
    expect(calls).toHaveLength(1);
  });

  it('web-push 實際加密／VAPID 簽章（不連網）：aes128gcm ＋ vapid Authorization', () => {
    const keys = generateVAPIDKeys();
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const req = generateRequestDetails(
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        keys: {
          p256dh: ecdh.getPublicKey().toString('base64url'),
          auth: randomBytes(16).toString('base64url'),
        },
      },
      '{"title":"測試"}',
      {
        vapidDetails: {
          subject: 'mailto:ops@example.invalid',
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
        TTL: 86400,
        urgency: 'normal',
      },
    );
    expect(req.method).toBe('POST');
    expect(req.headers['Content-Encoding']).toBe('aes128gcm');
    expect(String(req.headers.Authorization)).toMatch(/^vapid t=.+, k=/);
    expect(req.headers.TTL).toBe(86400);
  });

  it('retryKeyOf：同一投遞固定、UUID v4 格式', () => {
    expect(retryKeyOf(1)).toBe(retryKeyOf(1));
    expect(retryKeyOf(1)).not.toBe(retryKeyOf(2));
    expect(retryKeyOf(42)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('lineSender：push API 參數、409 視為已送、其它錯誤與網路錯誤 → retry', async () => {
    const reqs: { url: string; init: RequestInit }[] = [];
    const respond = (status: number) =>
      (async (url: string, init: RequestInit) => {
        reqs.push({ url, init });
        return new Response(status === 200 ? '{}' : 'err', { status });
      }) as unknown as typeof fetch;
    const d = fakeDelivery({ id: 5, channel: 'line', target: 'U999', push: null });
    const s = lineSender({ accessToken: 'TOKEN', baseUrl: 'https://aeh.example' }, respond(200));
    expect(await s.send(d)).toEqual({ status: 'sent' });
    const { url, init } = reqs[0]!;
    expect(url).toBe('https://api.line.me/v2/bot/message/push');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer TOKEN');
    expect(headers['x-line-retry-key']).toBe(retryKeyOf(5));
    expect(JSON.parse(String(init.body))).toEqual({
      to: 'U999',
      messages: [{ type: 'text', text: '標題\n內文\n\n👉 https://aeh.example/events/1' }],
    });
    expect(await lineSender({ accessToken: 't', baseUrl: 'x' }, respond(409)).send(d)).toEqual({
      status: 'sent',
    });
    expect(
      (await lineSender({ accessToken: 't', baseUrl: 'x' }, respond(500)).send(d)).status,
    ).toBe('retry');
    const offline = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await lineSender({ accessToken: 't', baseUrl: 'x' }, offline).send(d)).toEqual({
      status: 'retry',
      error: 'network: ECONNRESET',
    });
  });
});

if (!WORKER_TEST_DB_URL) console.warn('[worker] DATABASE_URL_TEST 未設定，略過 notify 整合測試');

describe.skipIf(!WORKER_TEST_DB_URL)('notify 工作（Docker PostgreSQL）', () => {
  let handle: DbHandle;
  let venueId: number;
  beforeAll(async () => {
    handle = await freshWorkerDb();
    venueId = (await handle.db.select().from(venue).where(eq(venue.slug, 'taipei-arena')))[0]!.id;
  });
  afterAll(async () => {
    await handle?.close();
  });
  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate event, source_item, raw_snapshot, crawl_run, subscriber restart identity cascade`,
    );
  });

  /** 假管道：記錄送出內容，可指定每次的結果 */
  function fakeChannels(outcome: (d: DueDelivery) => DeliveryOutcome = () => ({ status: 'sent' })) {
    const sent: { channel: NotifyChannel; target: string; title: string }[] = [];
    const make = (channel: NotifyChannel): ChannelSender => ({
      channel,
      mode: 'live',
      async send(d) {
        sent.push({ channel, target: d.target, title: d.notification.title });
        return outcome(d);
      },
    });
    return { sent, channels: { web_push: make('web_push'), line: make('line') } };
  }

  function deps(
    channels: NotifyDeps['channels'],
    over: Partial<NotifyDeps['config']> = {},
  ): NotifyDeps {
    return {
      db: handle.db,
      channels,
      logger: silent,
      config: { ...DEFAULT_NOTIFY_CONFIG, ...over },
    };
  }

  async function seedEvent(over: Partial<NormalizedEvent> = {}): Promise<number> {
    return insertEvent(handle.db, {
      normalized: {
        sourceId: 'kktix',
        externalId: 'x',
        sourceUrl: 'https://example.kktix.cc/events/x',
        title: '測試演唱會',
        titleNormalized: '測試演唱會',
        type: 'concert',
        startAt: tw('2026-12-20T19:00:00'),
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
        reviewReasons: [],
        ...over,
      },
      status: 'published',
      dedupKey: null,
      notes: [],
    });
  }

  /** 有 Web Push ＋ LINE 的訪客 */
  async function subscriberWithChannels(name: string) {
    const s = await createSubscriber(handle.db, `hash-${name}`);
    await savePushSubscription(handle.db, s.id, {
      endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
      p256dh: 'p',
      auth: 'a',
    });
    await setLineLinkCode(handle.db, s.id, 'ABC234', new Date(Date.now() + 600_000));
    await linkLineByCode(handle.db, 'ABC234', `U-${name}`);
    return s;
  }

  const notifications = () => handle.db.select().from(notification).orderBy(notification.id);
  const deliveries = () =>
    handle.db.select().from(notificationDelivery).orderBy(notificationDelivery.id);

  it('新活動上架：比對訂閱 → 通知匣＋兩個管道送出；重跑不重複（idempotent）', async () => {
    const s = await subscriberWithChannels('a');
    await setTypeFollow(handle.db, s.id, 'concert', true);
    const other = await createSubscriber(handle.db, 'no-follow');
    const e = await seedEvent({ title: 'LiSA LIVE' });
    const { sent, channels } = fakeChannels();

    const now = tw('2026-11-25T12:00:00');
    const r = await runNotify(deps(channels), { now });
    expect(r).toMatchObject({
      eventsChecked: 1,
      newEventNotifications: 1,
      deliveriesCreated: 2,
      delivered: { sent: 2, simulated: 0, retry: 0, gone: 0 },
    });
    const [n] = await notifications();
    expect(n).toMatchObject({
      subscriberId: s.id,
      kind: 'new_event',
      eventId: e,
      title: '新活動上架｜LiSA LIVE',
      path: `/events/${e}`,
    });
    expect(n!.body).toContain('符合你的訂閱：演唱會');
    expect(sent.map((x) => x.channel).sort()).toEqual(['line', 'web_push']);
    expect((await handle.db.select().from(event))[0]!.newEventNotifiedAt).toEqual(now);

    const again = await runNotify(deps(channels), { now: new Date(now.getTime() + 300_000) });
    expect(again).toMatchObject({
      eventsChecked: 0,
      newEventNotifications: 0,
      deliveriesCreated: 0,
    });
    expect(sent).toHaveLength(2);
    expect((await notifications()).filter((x) => x.subscriberId === other.id)).toEqual([]);
  });

  it('勿擾時段：凌晨產生的通知延到 08:00 才送出', async () => {
    const s = await subscriberWithChannels('q');
    await setTypeFollow(handle.db, s.id, 'concert', true);
    await seedEvent();
    const { sent, channels } = fakeChannels();

    await runNotify(deps(channels), { now: tw('2026-11-26T04:10:00') });
    expect(await notifications()).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect((await deliveries()).map((d) => [d.status, d.notBefore.toISOString()])).toEqual([
      ['pending', tw('2026-11-26T08:00:00').toISOString()],
      ['pending', tw('2026-11-26T08:00:00').toISOString()],
    ]);
    await runNotify(deps(channels), { now: tw('2026-11-26T07:55:00') });
    expect(sent).toHaveLength(0);
    await runNotify(deps(channels), { now: tw('2026-11-26T08:00:00') });
    expect(sent).toHaveLength(2);
  });

  it('勿擾時段的提醒：延後會超過開賣時間 → 立即送；來得及 → 延到 08:00', async () => {
    const s = await subscriberWithChannels('late');
    const midnight = await seedEvent({
      title: '午夜開賣',
      saleStartAt: tw('2026-11-27T00:00:00'),
    });
    const noon = await seedEvent({ title: '中午開賣', saleStartAt: tw('2026-11-27T12:00:00') });
    for (const e of [midnight, noon]) await setFavorite(handle.db, s.id, e, true);
    await handle.db.update(event).set({ newEventNotifiedAt: new Date() });
    const { sent, channels } = fakeChannels();

    await runNotify(deps(channels), { now: tw('2026-11-26T23:30:00') });
    expect(sent.map((x) => x.title)).toEqual(['開賣提醒｜午夜開賣', '開賣提醒｜午夜開賣']);
    const pending = (await deliveries()).filter((d) => d.status === 'pending');
    expect(pending).toHaveLength(2);
    expect(
      pending.every((d) => d.notBefore.getTime() === tw('2026-11-27T08:00:00').getTime()),
    ).toBe(true);
  });

  it('一次命中超過門檻 → 合併為一則摘要', async () => {
    const s = await createSubscriber(handle.db, 'digest');
    await setTypeFollow(handle.db, s.id, 'concert', true);
    for (let i = 1; i <= 4; i++) await seedEvent({ title: `演唱會 ${i}` });
    const { channels } = fakeChannels();
    await runNotify(deps(channels), { now: tw('2026-11-25T12:00:00') });
    const ns = await notifications();
    expect(ns.map((n) => [n.kind, n.title])).toEqual([
      ['new_event_digest', '4 個新活動符合你的訂閱'],
    ]);
  });

  it('收藏提醒：開賣前 24 小時、前一天 18:00；同一提醒只送一次；偏好關閉不送', async () => {
    const s = await subscriberWithChannels('fav');
    const e = await seedEvent({
      title: '收藏的演唱會',
      startAt: tw('2026-12-20T19:00:00'),
      saleStartAt: tw('2026-11-28T12:00:00'),
    });
    await setFavorite(handle.db, s.id, e, true);
    await handle.db.update(event).set({ newEventNotifiedAt: new Date() });
    const { sent, channels } = fakeChannels();

    await runNotify(deps(channels), { now: tw('2026-11-27T11:00:00') }); // 開賣前 25 小時
    expect(await notifications()).toHaveLength(0);
    await runNotify(deps(channels), { now: tw('2026-11-27T12:05:00') });
    await runNotify(deps(channels), { now: tw('2026-11-27T12:10:00') });
    expect((await notifications()).map((n) => [n.kind, n.title])).toEqual([
      ['sale_reminder', '開賣提醒｜收藏的演唱會'],
    ]);
    expect(sent).toHaveLength(2);

    await runNotify(deps(channels), { now: tw('2026-12-19T18:00:00') });
    expect((await notifications()).map((n) => n.kind)).toEqual(['sale_reminder', 'event_reminder']);

    // 改期 → 新的開始日會再提醒；但關閉偏好後不送
    await handle.db.execute(sql`update subscriber set notify_event_reminder = false`);
    await handle.db.update(event).set({ startAt: tw('2026-12-21T19:00:00') });
    await runNotify(deps(channels), { now: tw('2026-12-20T18:30:00') });
    expect(await notifications()).toHaveLength(2);
  });

  it('dry-run 不寫入任何資料', async () => {
    const s = await createSubscriber(handle.db, 'dry');
    await setTypeFollow(handle.db, s.id, 'concert', true);
    await seedEvent();
    const { channels } = fakeChannels();
    const r = await runNotify(deps(channels), { now: tw('2026-11-25T12:00:00'), dryRun: true });
    expect(r.newEventNotifications).toBe(1);
    expect(await notifications()).toHaveLength(0);
    expect((await handle.db.select().from(event))[0]!.newEventNotifiedAt).toBeNull();
  });

  it('管道失敗：例外 → 退避重試；推播端點失效 → 移除訂閱', async () => {
    const s = await subscriberWithChannels('fail');
    await setTypeFollow(handle.db, s.id, 'concert', true);
    await seedEvent();
    const { channels } = fakeChannels((d) =>
      d.channel === 'web_push' ? { status: 'gone', error: '410 Gone' } : { status: 'sent' },
    );
    channels.line.send = async () => {
      throw new Error('LINE API timeout');
    };
    const now = tw('2026-11-25T12:00:00');
    const r = await runNotify(deps(channels), { now });
    expect(r.delivered).toEqual({ sent: 0, simulated: 0, retry: 1, gone: 1 });
    expect(await handle.db.select().from(pushSubscription)).toHaveLength(0);
    const line = (await deliveries()).find((d) => d.channel === 'line')!;
    expect(line).toMatchObject({ status: 'pending', attempts: 1, lastError: 'LINE API timeout' });
    expect(line.notBefore.getTime()).toBe(now.getTime() + 5 * 60_000);
  });

  it('擷取 → 發布 → 通知：CWT 真實 fixture 發布的同人展會通知訂閱「同人展」的訪客', async () => {
    const s = await createSubscriber(handle.db, 'doujin-fan');
    await setTypeFollow(handle.db, s.id, 'doujin', true);
    const h = await makeDeps(handle, {
      'https://www.comicworld.com.tw/Acts/tw': html(
        scraperFixture('cwt', 'acts-tw-2026-11-18.html'),
      ),
    });
    await runSource(h.deps, 'cwt', { kind: 'crawl', dryRun: false });
    const published = await handle.db
      .select({ id: event.id, title: event.title })
      .from(event)
      .where(eq(event.status, 'published'));
    expect(published.length).toBeGreaterThan(0);

    const { channels } = fakeChannels();
    const r = await runNotify(deps(channels, { digestThreshold: 50 }), {
      now: tw('2026-11-18T12:30:00'),
    });
    expect(r.eventsChecked).toBe(published.length);
    const ns = await notifications();
    expect(ns.length).toBe(published.length);
    expect(ns.every((n) => n.kind === 'new_event' && n.body.includes('同人展'))).toBe(true);
    // 通知只導向站內活動頁（活動頁再導流官方連結，C8）
    expect(ns.every((n) => /^\/events\/\d+$/.test(n.path))).toBe(true);
    await h.cleanupDir();
  });
});
