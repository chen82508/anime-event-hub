import type { NormalizedEvent } from '@aeh/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DICTIONARY_DIR,
  addEventTags,
  attachEventSource,
  getPublicEvent,
  insertEvent,
  listPublicEvents,
  listPublicTagFacets,
  loadDictionaries,
  runMigrations,
  seedDictionaries,
  tag,
  upsertSourceItem,
  venue,
  type Database,
  type DbHandle,
} from '../src';
import { TEST_DB_URL, freshTestDb } from './helpers';

const NOW = new Date('2026-11-18T04:00:00Z');

describe.skipIf(!TEST_DB_URL)('前台查詢（Phase 2）', () => {
  let handle: DbHandle;
  let db: Database;
  let taipeiVenue: number;
  let kaohsiungVenue: number;
  let tagId: number;
  let tagRef: { kind: 'work' | 'agency' | 'voice_actor' | 'artist'; slug: string; name: string };
  let seq = 0;

  beforeAll(async () => {
    handle = await freshTestDb();
    db = handle.db;
    await runMigrations(db);
    await seedDictionaries(db, await loadDictionaries(DEFAULT_DICTIONARY_DIR));
    taipeiVenue = (await db.select().from(venue).where(eq(venue.slug, 'taipei-arena')))[0]!.id;
    kaohsiungVenue = (await db.select().from(venue).where(eq(venue.region, 'south')).limit(1))[0]!
      .id;
    const t = (await db.select().from(tag).limit(1))[0]!;
    tagId = t.id;
    tagRef = { kind: t.kind, slug: t.slug, name: t.name };
  });
  afterAll(async () => {
    await handle?.close();
  });
  beforeEach(async () => {
    await db.execute(
      sql`truncate event, source_item, raw_snapshot, crawl_run, audit_log, alert_state restart identity cascade`,
    );
  });

  async function seed(
    over: Partial<NormalizedEvent> = {},
    status: 'published' | 'pending_review' | 'ended' | 'hidden' = 'published',
  ) {
    const n: NormalizedEvent = {
      sourceId: 'kktix',
      externalId: 'x',
      sourceUrl: 'https://example.kktix.cc/events/x',
      title: '測試演唱會',
      titleNormalized: '測試演唱會',
      type: 'concert',
      startAt: new Date('2026-12-20T11:00:00Z'),
      endAt: null,
      allDay: false,
      yearInferred: false,
      venueId: taipeiVenue,
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
    };
    const id = await insertEvent(db, {
      normalized: n,
      status: status === 'pending_review' ? 'pending_review' : 'published',
      dedupKey: null,
      notes: [],
    });
    if (status === 'ended' || status === 'hidden') {
      await db.execute(sql`update event set status = ${status} where id = ${id}`);
    }
    const url = `https://example.kktix.cc/events/p${++seq}`;
    const si = await upsertSourceItem(db, {
      sourceId: 'kktix',
      externalId: `p${seq}`,
      url,
      contentHash: 'h',
      parsed: { secret: '不應外流' },
      snapshotId: null,
      skipReason: null,
    });
    await attachEventSource(db, { eventId: id, sourceItemId: si.id, url, isPrimary: true });
    return id;
  }

  it('只回傳已發布且未結束的活動，依開始時間排序', async () => {
    const later = await seed({ title: 'B', startAt: new Date('2027-01-05T10:00:00Z') });
    const sooner = await seed({ title: 'A', startAt: new Date('2026-12-01T10:00:00Z') });
    await seed({ title: '待審' }, 'pending_review');
    await seed({ title: '隱藏' }, 'hidden');
    await seed({ title: '已結束' }, 'ended');
    await seed({ title: '過去', startAt: new Date('2026-10-01T10:00:00Z') });

    const { rows, total } = await listPublicEvents(db, { from: NOW, now: NOW });
    expect(rows.map((r) => r.id)).toEqual([sooner, later]);
    expect(total).toBe(2);
  });

  it('進行中的多日活動仍列出（結束時間判定同 markEndedEvents）', async () => {
    const id = await seed({
      title: '長期展覽',
      type: 'exhibition',
      startAt: new Date('2026-11-01T02:00:00Z'),
      endAt: new Date('2026-12-31T15:59:59Z'),
      allDay: true,
    });
    const { rows } = await listPublicEvents(db, { from: NOW, now: NOW });
    expect(rows.map((r) => r.id)).toEqual([id]);
  });

  it('地區、類型、標籤、關鍵字、日期、開賣狀態可組合篩選', async () => {
    const north = await seed({
      title: 'Xylophone Night LIVE',
      titleNormalized: 'xylophone night live',
      saleStartAt: new Date('2026-11-01T04:00:00Z'),
    });
    const south = await seed({
      title: '高雄見面會',
      type: 'fan_meeting',
      venueId: kaohsiungVenue,
      region: 'south',
      city: '高雄市',
      saleStartAt: new Date('2026-12-01T04:00:00Z'),
      startAt: new Date('2027-02-01T10:00:00Z'),
    });
    await addEventTags(db, south, [{ tagId, origin: 'dict', matchedBy: 'test' }]);

    const ids = async (f: Parameters<typeof listPublicEvents>[1]) =>
      (await listPublicEvents(db, { from: NOW, now: NOW, ...f })).rows.map((r) => r.id);

    expect(await ids({ regions: ['south'] })).toEqual([south]);
    expect(await ids({ regions: ['north', 'south'] })).toEqual([north, south]);
    expect(await ids({ types: ['concert'] })).toEqual([north]);
    expect(await ids({ tags: [tagRef] })).toEqual([south]);
    expect(await ids({ q: 'Night' })).toEqual([north]);
    // 全形關鍵字原文比不到，靠正規化版本命中
    expect(await ids({ q: 'Ｘｙｌｏｐｈｏｎｅ', qNormalized: 'xylophone' })).toEqual([north]);
    expect(await ids({ q: tagRef.name })).toEqual([south]);
    expect(await ids({ q: '100%' })).toEqual([]);
    expect(await ids({ sale: 'on_sale' })).toEqual([north]);
    expect(await ids({ sale: 'upcoming' })).toEqual([south]);
    expect(await ids({ to: new Date('2027-01-01T00:00:00+08:00') })).toEqual([north]);
    expect(await ids({ regions: ['south'], types: ['concert'] })).toEqual([]);
  });

  it('月曆檢視 includeEnded 會包含已結束活動', async () => {
    const ended = await seed({ startAt: new Date('2026-11-02T10:00:00Z') }, 'ended');
    const monthStart = new Date('2026-11-01T00:00:00+08:00');
    const monthEnd = new Date('2026-12-01T00:00:00+08:00');
    const r = await listPublicEvents(db, { from: monthStart, to: monthEnd, includeEnded: true });
    expect(r.rows.map((x) => x.id)).toEqual([ended]);
  });

  it('標籤選項只計入未結束的已發布活動', async () => {
    const a = await seed();
    const p = await seed({}, 'pending_review');
    await addEventTags(db, a, [{ tagId, origin: 'dict', matchedBy: 't' }]);
    await addEventTags(db, p, [{ tagId, origin: 'dict', matchedBy: 't' }]);
    const facets = await listPublicTagFacets(db, NOW);
    expect(facets).toEqual([{ ...tagRef, count: 1 }]);
  });

  it('詳情：不回傳待審活動，也不外流來源解析內容', async () => {
    const id = await seed();
    const pending = await seed({}, 'pending_review');
    expect(await getPublicEvent(db, pending)).toBeNull();
    const d = await getPublicEvent(db, id);
    expect(d?.venue?.city).toBe('台北市');
    expect(d?.sources).toHaveLength(1);
    expect(d?.sources[0]).toMatchObject({ sourceId: 'kktix', isPrimary: true });
    expect(JSON.stringify(d)).not.toContain('不應外流');
  });
});
