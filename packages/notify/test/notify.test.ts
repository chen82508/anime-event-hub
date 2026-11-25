import { describe, expect, it } from 'vitest';
import {
  LINE_REPLY,
  buildNewEventNotifications,
  cleanTitle,
  dueReminders,
  eventReminderOpensAt,
  generateLinkCode,
  isAllowedPushEndpoint,
  isLinkCode,
  isQuietHour,
  matchNewEvents,
  nextDeliveryTime,
  parseLineCommand,
  parseQuietHours,
  relativeDay,
  renderEventReminder,
  renderNewEvent,
  renderNewEventDigest,
  renderSaleReminder,
  renderTest,
  signLineBody,
  toLineText,
  toPushPayload,
  verifyLineSignature,
  type FavoriteForReminder,
  type NewEventCandidate,
  type NotifyEvent,
  type SubscriberFollows,
} from '../src';

/** 台灣時間 → Date（+08:00） */
const tw = (s: string) => new Date(`${s}+08:00`);
const NOW = tw('2026-11-25T12:00:00'); // 週三

function ev(over: Partial<NewEventCandidate> = {}): NewEventCandidate {
  return {
    id: 1,
    title: 'LiSA LIVE in TAIPEI',
    type: 'concert',
    startAt: tw('2026-12-12T19:00:00'),
    endAt: null,
    allDay: false,
    isOnline: false,
    venueName: 'Legacy Max',
    city: '台北市',
    saleStartAt: tw('2026-11-28T12:00:00'),
    tags: [],
    ...over,
  };
}

describe('templates（固定模板，C3）', () => {
  it('cleanTitle：去除換行／控制／零寬字元、合併空白、以 code point 截斷', () => {
    expect(cleanTitle('  A\nB​\tC  ')).toBe('A B C');
    expect(cleanTitle('一二三四五', 4)).toBe('一二三…');
    expect(cleanTitle('😀😀😀😀', 3)).toBe('😀😀…');
    expect(cleanTitle('剛好四字', 4)).toBe('剛好四字');
  });

  it('新活動上架：標題保留原文、含類型／時間／地點／訂閱原因、連到站內活動頁', () => {
    const m = renderNewEvent(ev({ title: 'ぼっち・ざ・ろっく！ 展' }), ['孤獨搖滾', '演唱會'], NOW);
    expect(m).toEqual({
      title: '新活動上架｜ぼっち・ざ・ろっく！ 展',
      body: '［演唱會］12/12（六） 19:00・Legacy Max（台北市）\n符合你的訂閱：孤獨搖滾、演唱會',
      path: '/events/1',
    });
  });

  it('新活動上架：類型 other 不顯示、線上活動', () => {
    const m = renderNewEvent(
      ev({ type: 'other', isOnline: true, venueName: null, city: null }),
      [],
      NOW,
    );
    expect(m.body).toBe('12/12（六） 19:00・線上活動');
  });

  it('同一輸入必得同一輸出', () => {
    expect(renderNewEvent(ev(), ['x'], NOW)).toEqual(renderNewEvent(ev(), ['x'], NOW));
  });

  it('摘要：最多預覽 3 筆，其餘以「等共 N 個」表示', () => {
    const events = [1, 2, 3, 4, 5].map((id) => ev({ id, title: `活動${id}` }));
    const m = renderNewEventDigest(events);
    expect(m.title).toBe('5 個新活動符合你的訂閱');
    expect(m.body).toBe('・活動1\n・活動2\n・活動3\n…等共 5 個活動');
    expect(m.path).toBe('/me#inbox');
    expect(renderNewEventDigest(events.slice(0, 2)).body).toBe('・活動1\n・活動2');
  });

  it('relativeDay：今天／明天／其它日期（台灣時間跨日）', () => {
    expect(relativeDay(tw('2026-11-25T23:59:00'), NOW)).toBe('今天');
    expect(relativeDay(tw('2026-11-26T00:00:00'), NOW)).toBe('明天');
    expect(relativeDay(tw('2026-11-27T10:00:00'), NOW)).toBe('11/27（五）');
    // 月底跨月
    expect(relativeDay(tw('2026-12-01T09:00:00'), tw('2026-11-30T20:00:00'))).toBe('明天');
  });

  it('開賣提醒與活動前一天提醒', () => {
    const now = tw('2026-11-27T12:30:00');
    expect(renderSaleReminder(ev(), now)).toEqual({
      title: '開賣提醒｜LiSA LIVE in TAIPEI',
      body: '明天 12:00 開賣，記得準時搶票！\nLegacy Max（台北市）・實際購票方式請以官方公告為準',
      path: '/events/1',
    });
    const r = renderEventReminder(ev(), tw('2026-12-11T18:00:00'));
    expect(r.title).toBe('明天就是活動日｜LiSA LIVE in TAIPEI');
    expect(r.body).toBe('明天 19:00 開始・Legacy Max（台北市）\n出發前請再確認官方公告的入場資訊');
    // 全天活動不顯示時刻
    expect(
      renderEventReminder(
        ev({ allDay: true, startAt: tw('2026-12-12T00:00:00') }),
        tw('2026-12-11T18:00:00'),
      ).body,
    ).toMatch(/^明天 開始/);
  });

  it('管道格式：Web Push JSON、LINE 文字附完整網址', () => {
    const m = { ...renderTest(), tag: 'test:1:1' };
    expect(JSON.parse(toPushPayload(m))).toEqual({
      title: m.title,
      body: m.body,
      url: '/me',
      tag: 'test:1:1',
    });
    expect(toLineText(m, 'https://aeh.example/')).toBe(
      `${m.title}\n${m.body}\n\n👉 https://aeh.example/me`,
    );
    expect(toLineText({ ...m, body: 'x'.repeat(6000) }, 'https://a').length).toBe(5000);
  });
});

describe('matchNewEvents / buildNewEventNotifications', () => {
  const tags = [
    { id: 10, name: '孤獨搖滾' },
    { id: 20, name: '木棉花' },
  ];
  const follows: SubscriberFollows[] = [
    { subscriberId: 2, notifyNewEvent: true, tagIds: [10, 20], types: ['concert'] },
    { subscriberId: 1, notifyNewEvent: true, tagIds: [], types: ['doujin'] },
    { subscriberId: 3, notifyNewEvent: false, tagIds: [10], types: [] },
    { subscriberId: 4, notifyNewEvent: true, tagIds: [99], types: [] },
  ];

  it('標籤或類型命中即通知；原因依活動標籤順序、類型放最後；關閉通知者略過', () => {
    const e1 = ev({ id: 1, tags });
    const e2 = ev({ id: 2, type: 'doujin', tags: [] });
    const m = matchNewEvents([e2, e1], follows, NOW);
    expect([...m.keys()]).toEqual([1, 2]);
    expect(m.get(2)!.map((x) => [x.event.id, x.reasons])).toEqual([
      [1, ['孤獨搖滾', '木棉花', '演唱會']],
    ]);
    expect(m.get(1)!.map((x) => x.event.id)).toEqual([2]);
    expect(m.has(3)).toBe(false);
    expect(m.has(4)).toBe(false);
  });

  it('已結束的活動不通知', () => {
    const past = ev({ startAt: tw('2026-11-01T10:00:00'), tags });
    expect(matchNewEvents([past], follows, NOW).size).toBe(0);
  });

  it('命中 ≤ 門檻：每筆一則；超過：合併為一則摘要（dedupeKey 穩定）', () => {
    const events = [1, 2, 3, 4].map((id) => ev({ id, tags }));
    const few = buildNewEventNotifications(matchNewEvents(events.slice(0, 3), follows, NOW), NOW);
    expect(few.map((d) => [d.kind, d.dedupeKey])).toEqual([
      ['new_event', 'new_event:2:1'],
      ['new_event', 'new_event:2:2'],
      ['new_event', 'new_event:2:3'],
    ]);
    const many = buildNewEventNotifications(matchNewEvents(events, follows, NOW), NOW);
    expect(many).toHaveLength(1);
    expect(many[0]).toMatchObject({
      subscriberId: 2,
      kind: 'new_event_digest',
      eventId: null,
      dedupeKey: 'new_event_digest:2:1,2,3,4',
    });
    expect(
      buildNewEventNotifications(matchNewEvents(events, follows, NOW), NOW, {
        digestThreshold: 10,
      }),
    ).toHaveLength(4);
  });
});

describe('dueReminders（開賣前／舉辦前一天）', () => {
  const e: NotifyEvent = ev();
  const fav = (over: Partial<FavoriteForReminder> = {}): FavoriteForReminder => ({
    subscriberId: 1,
    notifySaleReminder: true,
    notifyEventReminder: true,
    event: e,
    ...over,
  });

  it('開賣提醒：開賣前 24 小時內（含起點、不含開賣時刻）', () => {
    const sale = e.saleStartAt!.getTime();
    const at = (ms: number) => dueReminders([fav()], new Date(ms)).map((d) => d.kind);
    expect(at(sale - 24 * 3600_000 - 1)).toEqual([]);
    expect(at(sale - 24 * 3600_000)).toEqual(['sale_reminder']);
    expect(at(sale - 1)).toEqual(['sale_reminder']);
    expect(at(sale)).toEqual([]);
    const [d] = dueReminders([fav()], new Date(sale - 3600_000));
    expect(d!.dedupeKey).toBe(`sale_reminder:1:1:${e.saleStartAt!.toISOString()}`);
  });

  it('自訂提前時數', () => {
    const sale = e.saleStartAt!.getTime();
    expect(
      dueReminders([fav()], new Date(sale - 30 * 3600_000), { saleLeadHours: 48 }),
    ).toHaveLength(1);
  });

  it('活動提醒：開始日前一天 18:00（台灣時間）起，到開始時間前', () => {
    expect(eventReminderOpensAt(e.startAt!).toISOString()).toBe(
      tw('2026-12-11T18:00:00').toISOString(),
    );
    expect(eventReminderOpensAt(e.startAt!, 9).toISOString()).toBe(
      tw('2026-12-11T09:00:00').toISOString(),
    );
    const kinds = (s: string) => dueReminders([fav()], tw(s)).map((d) => d.kind);
    expect(kinds('2026-12-11T17:59:00')).toEqual([]);
    expect(kinds('2026-12-11T18:00:00')).toEqual(['event_reminder']);
    expect(kinds('2026-12-12T18:59:00')).toEqual(['event_reminder']);
    expect(kinds('2026-12-12T19:00:00')).toEqual([]);
    const [d] = dueReminders([fav()], tw('2026-12-11T20:00:00'));
    expect(d!.dedupeKey).toBe('event_reminder:1:1:2026-12-12');
  });

  it('跨月：12/1 的活動在 11/30 18:00 提醒', () => {
    const dec1 = { ...e, startAt: tw('2026-12-01T10:00:00'), saleStartAt: null };
    expect(dueReminders([fav({ event: dec1 })], tw('2026-11-30T18:00:00'))).toHaveLength(1);
  });

  it('依偏好關閉；沒有開賣時間者不做開賣提醒；輸出依訪客、活動排序', () => {
    const now = new Date(e.saleStartAt!.getTime() - 3600_000);
    expect(dueReminders([fav({ notifySaleReminder: false })], now)).toEqual([]);
    expect(dueReminders([fav({ event: { ...e, saleStartAt: null } })], now)).toEqual([]);
    const out = dueReminders(
      [
        fav({ subscriberId: 3 }),
        fav({ subscriberId: 2, event: { ...e, id: 9 } }),
        fav({ subscriberId: 2 }),
      ],
      now,
    );
    expect(out.map((d) => `${d.subscriberId}:${d.eventId}`)).toEqual(['2:1', '2:9', '3:1']);
  });
});

describe('勿擾時段', () => {
  it('parseQuietHours', () => {
    expect(parseQuietHours('23-8')).toEqual({ start: 23, end: 8 });
    expect(parseQuietHours(' 1 - 6 ')).toEqual({ start: 1, end: 6 });
    expect(parseQuietHours('')).toBeNull();
    expect(parseQuietHours(undefined)).toBeNull();
    expect(parseQuietHours('5-5')).toBeNull();
    expect(() => parseQuietHours('23~8')).toThrow();
    expect(() => parseQuietHours('25-8')).toThrow();
  });

  it('跨午夜區間與一般區間', () => {
    const qh = { start: 23, end: 8 };
    expect(isQuietHour(tw('2026-11-25T22:59:00'), qh)).toBe(false);
    expect(isQuietHour(tw('2026-11-25T23:00:00'), qh)).toBe(true);
    expect(isQuietHour(tw('2026-11-26T07:59:00'), qh)).toBe(true);
    expect(isQuietHour(tw('2026-11-26T08:00:00'), qh)).toBe(false);
    expect(isQuietHour(tw('2026-11-26T03:00:00'), { start: 1, end: 6 })).toBe(true);
    expect(isQuietHour(tw('2026-11-26T07:00:00'), { start: 1, end: 6 })).toBe(false);
    expect(isQuietHour(NOW, null)).toBe(false);
  });

  it('nextDeliveryTime：勿擾中延到結束時刻（當天或隔天）', () => {
    const qh = { start: 23, end: 8 };
    expect(nextDeliveryTime(NOW, qh)).toBe(NOW);
    expect(nextDeliveryTime(tw('2026-11-25T23:30:00'), qh).toISOString()).toBe(
      tw('2026-11-26T08:00:00').toISOString(),
    );
    expect(nextDeliveryTime(tw('2026-11-26T04:00:00'), qh).toISOString()).toBe(
      tw('2026-11-26T08:00:00').toISOString(),
    );
    expect(nextDeliveryTime(tw('2026-11-26T04:00:00'), null).toISOString()).toBe(
      tw('2026-11-26T04:00:00').toISOString(),
    );
  });
});

describe('LINE', () => {
  it('generateLinkCode：6 碼、不含易混淆字元、由隨機位元組決定', () => {
    const code = generateLinkCode(new Uint8Array([0, 1, 2, 30, 31, 255, 9]));
    expect(code).toBe('ABC9AH'); // 字母表 31 字：30→9、31→A、255→H
    expect(isLinkCode(code)).toBe(true);
    expect(isLinkCode('ABC10O')).toBe(false);
    expect(() => generateLinkCode(new Uint8Array(3))).toThrow();
  });

  it('parseLineCommand：綁定（全形／小寫／無空白／只有碼）、解除、說明', () => {
    expect(parseLineCommand('綁定 ABC234')).toEqual({ kind: 'link', code: 'ABC234' });
    expect(parseLineCommand('綁定ａｂｃ２３４')).toEqual({ kind: 'link', code: 'ABC234' });
    expect(parseLineCommand('  link  abc234 ')).toEqual({ kind: 'link', code: 'ABC234' });
    expect(parseLineCommand('abc234')).toEqual({ kind: 'link', code: 'ABC234' });
    expect(parseLineCommand('解除綁定')).toEqual({ kind: 'unlink' });
    expect(parseLineCommand('UNLINK')).toEqual({ kind: 'unlink' });
    expect(parseLineCommand('綁定 ABC10O')).toEqual({ kind: 'help' });
    expect(parseLineCommand('你好')).toEqual({ kind: 'help' });
    expect(LINE_REPLY.help).toContain('綁定');
  });

  it('verifyLineSignature：HMAC-SHA256／base64，竄改或缺簽章即失敗', () => {
    const body = '{"events":[]}';
    const sig = signLineBody(body, 'secret');
    expect(verifyLineSignature(body, sig, 'secret')).toBe(true);
    expect(verifyLineSignature(`${body} `, sig, 'secret')).toBe(false);
    expect(verifyLineSignature(body, sig, 'other')).toBe(false);
    expect(verifyLineSignature(body, null, 'secret')).toBe(false);
    expect(verifyLineSignature(body, 'short', 'secret')).toBe(false);
    expect(verifyLineSignature(body, sig, '')).toBe(false);
  });
});

describe('isAllowedPushEndpoint（防 SSRF）', () => {
  it('只接受主要瀏覽器推播服務的 https 端點', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QH',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ])
      expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://169.254.169.254/latest',
      'https://localhost/x',
      'https://evilfcm.googleapis.com.attacker.net/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x',
      'not a url',
    ])
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
  });
});
