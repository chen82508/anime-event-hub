import type { NormalizedEvent } from '@aeh/core';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CrawlInProgressError,
  DEFAULT_DICTIONARY_DIR,
  PublishBlockedError,
  addAlias,
  applyAdminEdit,
  attachEventSource,
  auditLog,
  claimAlertSlot,
  createVenue,
  eventSource,
  findDedupCandidates,
  finishCrawlRun,
  getEvent,
  insertEvent,
  loadDictionaries,
  loadMatchingDictionaries,
  markEndedEvents,
  mergeEvents,
  publishEvent,
  resolveReviewReasons,
  runMigrations,
  seedDictionaries,
  setEventStatus,
  splitEventSource,
  startCrawlRun,
  tag,
  upsertSourceItem,
  venue,
  type Database,
  type DbHandle,
} from '../src';
import { TEST_DB_URL, freshTestDb } from './helpers';

const deriveTitleNormalized = (t: string) => t.toLowerCase();
const deriveDedupKey = (e: {
  titleNormalized: string;
  startAt: Date | null;
  venueId: number | null;
}) =>
  e.startAt && e.venueId
    ? `${e.titleNormalized}|${e.startAt.toISOString().slice(0, 10)}|v${e.venueId}`
    : null;

describe.skipIf(!TEST_DB_URL)('repository 整合測試（T2）', () => {
  let handle: DbHandle;
  let db: Database;
  let venueId: number;
  let itemSeq = 0;

  beforeAll(async () => {
    handle = await freshTestDb();
    db = handle.db;
    await runMigrations(db);
    await seedDictionaries(db, await loadDictionaries(DEFAULT_DICTIONARY_DIR));
    venueId = (await db.select().from(venue).where(eq(venue.slug, 'taipei-arena')))[0]!.id;
  });
  afterAll(async () => {
    await handle?.close();
  });
  beforeEach(async () => {
    await db.execute(
      sql`truncate event, source_item, raw_snapshot, crawl_run, audit_log, alert_state restart identity cascade`,
    );
  });

  const normalized = (over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
    sourceId: 'kktix',
    externalId: 'x',
    sourceUrl: 'https://example.kktix.cc/events/x',
    title: '孤獨搖滾 演唱會',
    titleNormalized: '孤獨搖滾 演唱會',
    type: 'concert',
    startAt: new Date('2026-12-20T11:00:00Z'),
    endAt: null,
    allDay: false,
    yearInferred: false,
    venueId,
    venueRaw: '台北小巨蛋',
    isOnline: false,
    city: '台北市',
    region: 'north',
    priceMin: null,
    priceMax: null,
    isFree: false,
    saleStartAt: null,
    reviewReasons: [],
    ...over,
  });

  /** 建立活動並連上一個來源項目 */
  async function seedEvent(
    over: Partial<NormalizedEvent> = {},
    status: 'published' | 'pending_review' = 'published',
  ) {
    const n = normalized(over);
    const id = await insertEvent(db, {
      normalized: n,
      status,
      dedupKey: deriveDedupKey(n),
      notes: [],
    });
    const si = await upsertSourceItem(db, {
      sourceId: 'kktix',
      externalId: `e${++itemSeq}`,
      url: `https://example.kktix.cc/events/e${itemSeq}`,
      contentHash: 'h',
      parsed: { title: n.title },
      snapshotId: null,
      skipReason: null,
    });
    await attachEventSource(db, {
      eventId: id,
      sourceItemId: si.id,
      url: `https://example.kktix.cc/events/e${itemSeq}`,
      isPrimary: true,
    });
    return { id, sourceItemId: si.id };
  }

  it('upsertSourceItem：以內容 hash 判斷變動，保留上次 parsed', async () => {
    const base = {
      sourceId: 'cwt' as const,
      externalId: '1',
      url: 'https://x/1',
      snapshotId: null,
      skipReason: null,
    };
    const a = await upsertSourceItem(db, { ...base, contentHash: 'h1', parsed: { v: 1 } });
    const b = await upsertSourceItem(db, { ...base, contentHash: 'h1', parsed: { v: 1 } });
    const c = await upsertSourceItem(db, { ...base, contentHash: 'h2', parsed: { v: 2 } });
    expect([a.isNew, a.changed, b.changed, c.changed]).toEqual([true, true, false, true]);
    expect(c.previousParsed).toEqual({ v: 1 });
  });

  it('findDedupCandidates：同去重鍵、或日期相近且中文標題 trigram 相似', async () => {
    const { id } = await seedEvent();
    await seedEvent({ title: '別的活動', titleNormalized: '完全不同的標題' });
    const byKey = await findDedupCandidates(db, {
      titleNormalized: '孤獨搖滾 演唱會',
      startAt: new Date('2026-12-20T11:00:00Z'),
      dedupKey: deriveDedupKey(normalized()),
      windowDays: 1,
      minSimilarity: 0.45,
    });
    expect(byKey.map((c) => c.eventId)).toEqual([id]);
    const bySim = await findDedupCandidates(db, {
      titleNormalized: '孤獨搖滾 演唱會 台北場',
      startAt: new Date('2026-12-21T02:00:00Z'),
      dedupKey: null,
      windowDays: 1,
      minSimilarity: 0.3,
    });
    expect(bySim[0]?.eventId).toBe(id);
    expect(bySim[0]?.similarity).toBeGreaterThan(0.3);
  });

  it('publishEvent：有審核原因時擋下；齊全時發布並解除狀態鎖', async () => {
    const { id } = await seedEvent(
      { reviewReasons: ['unknown_venue'], venueId: null },
      'pending_review',
    );
    const err = await publishEvent(db, { id, actor: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishBlockedError);
    expect((err as PublishBlockedError).reasons).toEqual(['missing_venue', 'unknown_venue']);

    await applyAdminEdit(db, {
      id,
      actor: 't',
      changes: { venueId },
      deriveTitleNormalized,
      deriveDedupKey,
    });
    await setEventStatus(db, { id, actor: 't', status: 'pending_review' });
    expect((await getEvent(db, id))?.statusLocked).toBe(true);
    await publishEvent(db, { id, actor: 't' });
    const e = (await getEvent(db, id))!;
    expect(e).toMatchObject({ status: 'published', statusLocked: false, reviewReasons: [] });
    expect(e.publishedAt).not.toBeNull();
  });

  it('applyAdminEdit：只鎖定實際改動的欄位、帶入場館縣市、移除已解決原因、寫 audit_log', async () => {
    const { id } = await seedEvent(
      {
        venueId: null,
        city: null,
        region: null,
        type: null,
        reviewReasons: ['unknown_venue', 'type_unresolved'],
      },
      'pending_review',
    );
    const kh = (await db.select().from(venue).where(eq(venue.slug, 'kaohsiung-arena')))[0]!;
    const r = await applyAdminEdit(db, {
      id,
      actor: 'admin',
      changes: { title: '孤獨搖滾 演唱會', venueId: kh.id, type: 'concert' },
      deriveTitleNormalized,
      deriveDedupKey,
    });
    expect(r.changed.sort()).toEqual(['city', 'region', 'type', 'venueId']);
    const e = (await getEvent(db, id))!;
    expect(e).toMatchObject({ city: '高雄市', region: 'south', reviewReasons: [], venueId: kh.id });
    expect(e.dedupKey).toContain(`v${kh.id}`);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'event.update'));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toBe('admin');
  });

  it('applyAdminEdit：已發布活動被清空開始日 → 自動退回待審並補上原因（M3）', async () => {
    const { id } = await seedEvent();
    const r = await applyAdminEdit(db, {
      id,
      actor: 't',
      changes: { startAt: null },
      deriveTitleNormalized,
      deriveDedupKey,
    });
    expect(r).toMatchObject({ demoted: true, reviewReasons: ['missing_date'] });
    expect((await getEvent(db, id))?.status).toBe('pending_review');
  });

  it('resolveReviewReasons：人工解除指定原因', async () => {
    const { id } = await seedEvent(
      { reviewReasons: ['possible_duplicate', 'source_changed'] },
      'pending_review',
    );
    await resolveReviewReasons(db, { id, actor: 't', reasons: ['possible_duplicate'] });
    expect((await getEvent(db, id))?.reviewReasons).toEqual(['source_changed']);
  });

  it('mergeEvents 與 splitEventSource：來源搬移、主要來源遞補、拆分後為待審且鎖定狀態', async () => {
    const a = await seedEvent();
    const b = await seedEvent({
      priceMin: 800,
      priceMax: 1500,
      title: '孤獨搖滾 演唱會 VIP',
      titleNormalized: '孤獨搖滾 演唱會 vip',
    });
    await mergeEvents(db, { fromId: b.id, intoId: a.id, actor: 't', deriveDedupKey });
    expect(await getEvent(db, b.id)).toBeNull();
    expect(await getEvent(db, a.id)).toMatchObject({ priceMin: 800, priceMax: 1500 });
    let links = await db
      .select()
      .from(eventSource)
      .where(eq(eventSource.eventId, a.id))
      .orderBy(asc(eventSource.sourceItemId));
    expect(links.map((l) => l.isPrimary)).toEqual([true, false]);

    // 把原本的主要來源拆出去 → 剩下的來源遞補為主要
    const newId = await splitEventSource(db, {
      eventId: a.id,
      sourceItemId: a.sourceItemId,
      actor: 't',
      newEvent: { normalized: normalized(), dedupKey: null, notes: [] },
      tags: [],
    });
    expect(await getEvent(db, newId)).toMatchObject({
      status: 'pending_review',
      statusLocked: true,
    });
    links = await db.select().from(eventSource).where(eq(eventSource.eventId, a.id));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ sourceItemId: b.sourceItemId, isPrimary: true });
    await expect(
      splitEventSource(db, {
        eventId: a.id,
        sourceItemId: b.sourceItemId,
        actor: 't',
        newEvent: { normalized: normalized(), dedupKey: null, notes: [] },
        tags: [],
      }),
    ).rejects.toThrow('只有一個來源');
  });

  it('startCrawlRun：同來源同時只能一個執行中（M4）；結束後可再開', async () => {
    const id = await startCrawlRun(db, 'cwt', false);
    await expect(startCrawlRun(db, 'cwt', false)).rejects.toBeInstanceOf(CrawlInProgressError);
    await startCrawlRun(db, 'ff', false); // 不同來源互不影響
    await finishCrawlRun(db, id, {
      status: 'succeeded',
      counters: {
        itemsFound: 0,
        itemsNew: 0,
        itemsUpdated: 0,
        itemsPendingReview: 0,
        itemsSkipped: 0,
        itemsMissingFields: 0,
      },
    });
    await expect(startCrawlRun(db, 'cwt', false)).resolves.toBeGreaterThan(0);
  });

  it('claimAlertSlot：節流期間不重送並累計次數', async () => {
    const t0 = new Date('2026-11-18T00:00:00Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    expect(await claimAlertSlot(db, 'k', 60 * 60_000, t0)).toEqual({ send: true, suppressed: 0 });
    expect(await claimAlertSlot(db, 'k', 60 * 60_000, at(10))).toEqual({
      send: false,
      suppressed: 1,
    });
    expect(await claimAlertSlot(db, 'k', 60 * 60_000, at(20))).toEqual({
      send: false,
      suppressed: 2,
    });
    expect(await claimAlertSlot(db, 'k', 60 * 60_000, at(61))).toEqual({
      send: true,
      suppressed: 2,
    });
  });

  it('markEndedEvents：已發布且已結束 → ended', async () => {
    const { id } = await seedEvent({ startAt: new Date('2026-01-01T00:00:00Z') });
    expect(await markEndedEvents(db, new Date('2026-11-18T00:00:00Z'))).toBe(1);
    expect((await getEvent(db, id))?.status).toBe('ended');
  });

  it('字典快捷操作：新增別名（不重複）、新增場館，比對字典即時反映', async () => {
    const t = (await db.select().from(tag).where(eq(tag.slug, 'frieren')))[0]!;
    await addAlias(db, { entity: 'tag', id: t.id, alias: 'フリーレン', actor: 't' });
    await addAlias(db, { entity: 'tag', id: t.id, alias: 'フリーレン', actor: 't' });
    const after = (await db.select().from(tag).where(eq(tag.id, t.id)))[0]!;
    expect(after.aliases.filter((a) => a === 'フリーレン')).toHaveLength(1);

    await createVenue(db, { slug: 'test-hall', name: '測試展演廳', city: '台南市', actor: 't' });
    const dicts = await loadMatchingDictionaries(db);
    expect(dicts.venues.find((v) => v.slug === 'test-hall')).toMatchObject({ city: '台南市' });
    expect(dicts.typeKeywords.length).toBeGreaterThan(0);
  });
});
