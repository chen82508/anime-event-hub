import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_DICTIONARY_DIR,
  event,
  eventSource,
  loadDictionaries,
  runMigrations,
  seedDictionaries,
  source,
  sourceItem,
  tag,
  venue,
  type Database,
  type DbHandle,
  type Dictionaries,
} from '../src';
import { TEST_DB_URL, freshTestDb } from './helpers';

if (!TEST_DB_URL) {
  console.warn('[db] DATABASE_URL_TEST 未設定，略過整合測試（cp .env.example .env && pnpm db:up）');
}

describe.skipIf(!TEST_DB_URL)('DB 整合測試（Docker PostgreSQL）', () => {
  let handle: DbHandle;
  let db: Database;
  let dicts: Dictionaries;

  beforeAll(async () => {
    handle = await freshTestDb();
    db = handle.db;
    dicts = await loadDictionaries(DEFAULT_DICTIONARY_DIR);
  });
  afterAll(async () => {
    await handle?.close();
  });

  /** Drizzle 會把 PostgreSQL 錯誤包在 cause 裡；以約束名稱比對 */
  const expectViolation = async (p: Promise<unknown>, constraint: string) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e as { cause?: { constraint_name?: string } },
    );
    expect(err, `預期違反 ${constraint}，但寫入成功`).not.toBeNull();
    expect(err?.cause?.constraint_name).toBe(constraint);
  };

  const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

  describe('migration', () => {
    it('可在空 DB 上套用，且重套不報錯', async () => {
      await runMigrations(db);
      await runMigrations(db);
      const applied = await rows<{ n: number }>(
        sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
      );
      expect(applied[0]?.n).toBeGreaterThanOrEqual(1);
    });

    it('pg_trgm 已啟用', async () => {
      const ext = await rows<{ extname: string }>(
        sql`select extname from pg_extension where extname = 'pg_trgm'`,
      );
      expect(ext).toHaveLength(1);
    });

    it('建立 §5 的所有資料表', async () => {
      const tables = await rows<{ table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
      );
      expect(tables.map((t) => t.table_name)).toEqual(
        expect.arrayContaining([
          'source',
          'crawl_run',
          'raw_snapshot',
          'source_item',
          'event',
          'event_source',
          'venue',
          'tag',
          'event_tag',
          'type_keyword',
          'audit_log',
          'city',
        ]),
      );
    });

    it('trigram 索引與 UNIQUE(source_id, external_id) 存在', async () => {
      const idx = await rows<{ indexdef: string }>(
        sql`select indexdef from pg_indexes where indexname = 'event_title_normalized_trgm_idx'`,
      );
      expect(idx[0]?.indexdef).toMatch(/gin .*gin_trgm_ops/i);
      const uq = await rows<{ def: string }>(
        sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'source_item_source_external_uq'`,
      );
      expect(uq[0]?.def).toBe('UNIQUE (source_id, external_id)');
    });
  });

  describe('seed', () => {
    it('匯入全部字典，數量與 YAML 一致', async () => {
      const r = await seedDictionaries(db, dicts);
      const count = async (t: string) =>
        (await rows<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(t)}`))[0]?.n;
      expect(await count('city')).toBe(22);
      expect(await count('venue')).toBe(r.venues);
      expect(await count('tag')).toBe(r.tags);
      expect(await count('type_keyword')).toBe(r.typeKeywords);
      expect(await count('source')).toBe(r.sources);
    });

    it('venue.region 由 city 推得（D3）', async () => {
      const [v] = await db
        .select()
        .from(venue)
        .where(eq(venue.slug, 'kaohsiung-exhibition-center'));
      expect(v).toMatchObject({ city: '高雄市', region: 'south' });
    });

    it('重複執行結果相同（idempotent）', async () => {
      const before = await db.select().from(tag).orderBy(tag.id);
      await seedDictionaries(db, dicts);
      const after = await db.select().from(tag).orderBy(tag.id);
      expect(after.map(({ updatedAt: _u, ...t }) => t)).toEqual(
        before.map(({ updatedAt: _u, ...t }) => t),
      );
    });

    it('保留後台新增的別名與營運者的來源開關', async () => {
      await db
        .update(tag)
        .set({ aliases: sql`array_append(${tag.aliases}, '後台新增別名')` })
        .where(eq(tag.slug, 'frieren'));
      await db.update(source).set({ enabled: false }).where(eq(source.id, 'kktix'));

      await seedDictionaries(db, dicts);

      const [frieren] = await db.select().from(tag).where(eq(tag.slug, 'frieren'));
      const yamlAliases = dicts.tags.work.find((t) => t.slug === 'frieren')!.aliases;
      expect(frieren?.aliases).toEqual([...yamlAliases, '後台新增別名']);
      const [kktix] = await db.select().from(source).where(eq(source.id, 'kktix'));
      expect(kktix?.enabled).toBe(false);
    });

    it('type_keyword 不分大小寫唯一', async () => {
      await expectViolation(
        db.execute(
          sql`insert into type_keyword (event_type, keyword, priority) values ('concert', 'pop up', 1)`,
        ),
        'type_keyword_keyword_uq',
      );
    });
  });

  describe('約束', () => {
    let venueId: number;
    beforeAll(async () => {
      const [v] = await db.select({ id: venue.id }).from(venue).limit(1);
      venueId = v!.id;
    });

    const baseEvent = () => ({
      title: '測試活動',
      titleNormalized: '測試活動',
      type: 'exhibition' as const,
      startAt: new Date('2026-12-01T02:00:00Z'),
      venueId,
    });

    it('UNIQUE(source_id, external_id)：重複 upsert 不會重複建檔', async () => {
      const item = {
        sourceId: 'kktix' as const,
        externalId: 'e-1',
        url: 'https://kktix.com/events/e-1',
        contentHash: 'h1',
        parsed: {},
      };
      await db.insert(sourceItem).values(item);
      await expectViolation(db.insert(sourceItem).values(item), 'source_item_source_external_uq');
      await db
        .insert(sourceItem)
        .values({ ...item, contentHash: 'h2' })
        .onConflictDoUpdate({
          target: [sourceItem.sourceId, sourceItem.externalId],
          set: { contentHash: 'h2' },
        });
      const items = await db.select().from(sourceItem).where(eq(sourceItem.externalId, 'e-1'));
      expect(items).toHaveLength(1);
      expect(items[0]?.contentHash).toBe('h2');
    });

    it('待審活動可缺必要欄位，預設狀態為 pending_review', async () => {
      const [e] = await db
        .insert(event)
        .values({
          title: '缺日期',
          titleNormalized: '缺日期',
          reviewReasons: ['missing_date', 'missing_venue'],
        })
        .returning();
      expect(e).toMatchObject({
        status: 'pending_review',
        startAt: null,
        reviewReasons: ['missing_date', 'missing_venue'],
      });
    });

    it.each([
      ['缺開始時間', { startAt: null }],
      ['無場館且非線上', { venueId: null }],
      ['類型未判定', { type: null }],
      ['仍有審核原因', { reviewReasons: ['possible_duplicate' as const] }],
      ['缺 published_at', { publishedAt: null }],
    ])('published 必須齊全（C4）：%s → 拒絕', async (_l, patch) => {
      await expectViolation(
        db
          .insert(event)
          .values({ ...baseEvent(), status: 'published', publishedAt: new Date(), ...patch }),
        'event_published_requirements',
      );
    });

    it('齊全的活動可以 published', async () => {
      const [e] = await db
        .insert(event)
        .values({ ...baseEvent(), status: 'published', publishedAt: new Date() })
        .returning();
      expect(e?.status).toBe('published');
    });

    it('timestamptz 以絕對時間保存（R1）', async () => {
      const startAt = new Date('2026-11-16T19:30:00+08:00');
      const [e] = await db
        .insert(event)
        .values({ ...baseEvent(), startAt })
        .returning();
      expect(e?.startAt?.toISOString()).toBe('2026-11-16T11:30:00.000Z');
    });

    it.each([
      ['結束早於開始', { endAt: new Date('2026-11-01T00:00:00Z') }, 'event_end_after_start'],
      ['票價區間顛倒', { priceMin: 1500, priceMax: 800 }, 'event_price_range'],
      ['負票價', { priceMin: -1 }, 'event_price_nonnegative'],
      ['實體活動標 online', { region: 'online' as const }, 'event_online_region'],
    ])('拒絕：%s', async (_l, patch, constraint) => {
      await expectViolation(db.insert(event).values({ ...baseEvent(), ...patch }), constraint);
    });

    it('event_source：每個活動最多一個主要來源、一個來源項目只屬於一個活動', async () => {
      const [e1] = await db.insert(event).values(baseEvent()).returning();
      const [e2] = await db.insert(event).values(baseEvent()).returning();
      const mk = (externalId: string) =>
        db
          .insert(sourceItem)
          .values({
            sourceId: 'muse',
            externalId,
            url: `https://example.com/${externalId}`,
            contentHash: 'x',
            parsed: {},
          })
          .returning();
      const [i1] = await mk('m-1');
      const [i2] = await mk('m-2');

      await db
        .insert(eventSource)
        .values({ eventId: e1!.id, sourceItemId: i1!.id, url: i1!.url, isPrimary: true });
      await expectViolation(
        db
          .insert(eventSource)
          .values({ eventId: e1!.id, sourceItemId: i2!.id, url: i2!.url, isPrimary: true }),
        'event_source_one_primary_uq',
      );
      await db
        .insert(eventSource)
        .values({ eventId: e1!.id, sourceItemId: i2!.id, url: i2!.url, isPrimary: false });
      await expectViolation(
        db.insert(eventSource).values({ eventId: e2!.id, sourceItemId: i1!.id, url: i1!.url }),
        'event_source_source_item_uq',
      );
    });

    it('pg_trgm 相似度可用於去重候選查詢', async () => {
      await db.insert(event).values({
        ...baseEvent(),
        title: '孤獨搖滾 POP UP STORE',
        titleNormalized: '孤獨搖滾 pop up store',
      });
      const hits = await rows<{ title: string; sim: number }>(sql`
        select title, similarity(title_normalized, '孤獨搖滾 pop up store 台北') as sim
        from event where title_normalized % '孤獨搖滾 pop up store 台北' order by sim desc`);
      expect(hits[0]?.title).toBe('孤獨搖滾 POP UP STORE');
    });
  });
});
