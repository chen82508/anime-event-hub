import type { Scraper } from '@aeh/scrapers';
import {
  applyAdminEdit,
  setEventStatus,
  auditLog,
  crawlRun,
  event,
  eventSource,
  eventTag,
  rawSnapshot,
  sourceItem,
  type DbHandle,
} from '@aeh/db';
import { dedupKey } from '@aeh/dedup';
import { normalizeTitle } from '@aeh/normalize';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, dedupExisting } from '../src/maintenance';
import { runSource, runSources } from '../src/pipeline';
import { WORKER_TEST_DB_URL, freshWorkerDb, html, makeDeps, scraperFixture } from './helpers';

const CWT_URL = 'https://www.comicworld.com.tw/Acts/tw';
const FF_URL = 'https://www.f-2.com.tw/';
const MM_URL = 'https://www.mightymedia.com.tw/blog-feed.xml';
const kktixUrl = (k: string) => `https://kktix.com/events.atom?search=${encodeURIComponent(k)}`;

const cwtHtml = scraperFixture('cwt', 'acts-tw-2026-11-18.html');
const ffHtml = scraperFixture('ff', 'home-2026-11-18.html');
const kktixAtom = scraperFixture('kktix', 'search-2026-11-18.atom');
const emptyAtom =
  '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>';

function routes(over: Record<string, () => Response> = {}) {
  return {
    [CWT_URL]: html(cwtHtml),
    [FF_URL]: html(ffHtml),
    [MM_URL]: html(
      scraperFixture('mightymedia', 'blog-feed-2026-11-18.xml'),
      'text/xml; charset=utf-8',
    ),
    // KKTIX 五個關鍵字：第一個回傳真實快照，其餘回傳同一份（測試跨列表頁去重）
    ...Object.fromEntries(
      ['動漫', '動畫', '聲優', '同人', 'cosplay'].map((k) => [
        kktixUrl(k),
        html(kktixAtom, 'application/atom+xml'),
      ]),
    ),
    ...over,
  };
}

if (!WORKER_TEST_DB_URL) console.warn('[worker] DATABASE_URL_TEST 未設定，略過管線整合測試');

describe.skipIf(!WORKER_TEST_DB_URL)('管線整合測試（Docker PostgreSQL ＋ 真實 fixture）', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await freshWorkerDb();
  });
  afterAll(async () => {
    await handle?.close();
  });
  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate event, source_item, raw_snapshot, crawl_run, audit_log, alert_state restart identity cascade`,
    );
    await handle.db.execute(
      sql`update source set consecutive_empty_runs = 0, last_success_at = null`,
    );
  });

  const events = () => handle.db.select().from(event).orderBy(asc(event.id));

  it('crawl：建立活動、主要來源、標籤、快照登記；可自動發布者直接發布', async () => {
    const h = await makeDeps(handle, routes());
    const [cwt, ff] = await runSources(h.deps, ['cwt', 'ff'], { kind: 'crawl', dryRun: false });
    expect(cwt?.status).toBe('succeeded');
    expect(cwt?.counters).toMatchObject({ itemsFound: 5, itemsNew: 5, itemsPendingReview: 0 });
    expect(ff?.counters).toMatchObject({ itemsFound: 5, itemsNew: 5, itemsPendingReview: 3 });

    const rows = await events();
    expect(rows).toHaveLength(10);
    const cwt74 = rows.find((e) => e.title === '【CWT-74】(台北場)')!;
    expect(cwt74).toMatchObject({
      status: 'published',
      type: 'doujin',
      allDay: true,
      reviewReasons: [],
    });
    expect(cwt74.publishedAt).not.toBeNull();
    expect(cwt74.dedupKey).toMatch(/^cwt74台北場\|2026-12-12\|v\d+$/);

    const lisani = rows.find((e) => e.title.startsWith('LISANI'))!;
    expect(lisani).toMatchObject({ status: 'pending_review', reviewReasons: ['type_unresolved'] });

    const sources = await handle.db.select().from(eventSource);
    expect(sources).toHaveLength(10);
    expect(sources.every((s) => s.isPrimary)).toBe(true);
    expect(await handle.db.select().from(rawSnapshot)).toHaveLength(2);
    await h.cleanupDir();
  });

  it('idempotent：同內容再擷取、以快照 reparse 都不產生變更', async () => {
    const h = await makeDeps(handle, routes());
    await runSource(h.deps, 'cwt', { kind: 'crawl', dryRun: false });
    const before = await events();

    const again = await runSource(h.deps, 'cwt', { kind: 'crawl', dryRun: false });
    expect(again.items.map((i) => i.action)).toEqual(Array(5).fill('unchanged'));

    h.deps.client = null; // reparse 不得打網路
    const re1 = await runSource(h.deps, 'cwt', { kind: 'reparse' });
    const re2 = await runSource(h.deps, 'cwt', { kind: 'reparse' });
    expect(re1.items.map((i) => i.action)).toEqual(Array(5).fill('unchanged'));
    expect(re2.items).toEqual(re1.items);
    expect(await events()).toEqual(before);
    expect(await handle.db.select().from(sourceItem)).toHaveLength(5);
    await h.cleanupDir();
  });

  it('dry-run：不寫入 DB', async () => {
    const h = await makeDeps(handle, routes());
    const r = await runSource(h.deps, 'cwt', { kind: 'crawl', dryRun: true });
    expect(r.items.every((i) => i.action === 'dry_run')).toBe(true);
    expect(await events()).toHaveLength(0);
    expect(await handle.db.select().from(crawlRun)).toHaveLength(0);
    await h.cleanupDir();
  });

  it('去重：同一場演唱會的多個票種頁 → 1 筆建立、其餘 possible_duplicate；跨關鍵字列表不重複建立', async () => {
    const h = await makeDeps(handle, routes());
    const r = await runSource(h.deps, 'kktix', { kind: 'crawl', dryRun: false });
    expect(r.counters.itemsFound).toBe(14);
    const eir = r.items.filter((i) => i.title?.includes('EIR AOI'));
    expect(eir.map((i) => i.action).sort()).toEqual([
      'created',
      'possible_duplicate',
      'possible_duplicate',
    ]);
    // 同日同店、標題相近的 1v1 見面會（不同場次）也進灰色區間：寧可人工確認，不自動合併
    const niji = r.items.filter((i) => i.title?.includes('NIJISANJI'));
    expect(niji.map((i) => i.action).sort()).toEqual([
      'created',
      'possible_duplicate',
      'possible_duplicate',
    ]);
    const dup = (await events()).filter((e) => e.reviewReasons.includes('possible_duplicate'));
    expect(dup).toHaveLength(4);
    expect(dup[0]?.reviewNotes.some((n) => n.startsWith('疑似與活動 #'))).toBe(true);

    // 有疑似重複時 reparse 也必須 idempotent（說明不得被洗掉）
    const before = await events();
    h.deps.client = null;
    const re = await runSource(h.deps, 'kktix', { kind: 'reparse' });
    expect(
      re.items
        .filter((i) => i.action === 'updated')
        .map((i) => [i.title, i.reviewReasons, i.notes]),
    ).toEqual([]);
    expect(await events()).toEqual(before);
    await h.cleanupDir();
  });

  it('去重：其它來源的同鍵活動 → 自動合併為一筆、保留兩個來源連結、不覆寫既有欄位', async () => {
    const h = await makeDeps(handle, routes());
    await runSource(h.deps, 'cwt', { kind: 'crawl', dryRun: false });
    const echo: Scraper = {
      id: 'muse',
      schedule: 'daily',
      fixtureStatus: 'real',
      listUrls: () => ['https://muse.test/news'],
      parseList: () => [
        {
          externalId: 'n1',
          url: 'https://muse.test/news/1',
          candidate: {
            sourceId: 'muse',
            externalId: 'n1',
            url: 'https://muse.test/news/1',
            title: '【CWT-74】（台北場）',
            dateText: '2026/12/12、12/13 10:00-16:00',
            venueText: '台大綜合體育館',
            priceText: '入場券 NT$250',
          },
        },
      ],
    };
    h.deps.scrapers = { ...h.deps.scrapers, muse: echo };
    h.deps.client = (
      await makeDeps(handle, { 'https://muse.test/news': html('<html></html>') })
    ).deps.client;
    const r = await runSource(h.deps, 'muse', { kind: 'crawl', dryRun: false });
    expect(r.items[0]?.action).toBe('merged');

    const rows = await events();
    expect(rows).toHaveLength(5);
    const merged = rows.find((e) => e.title === '【CWT-74】(台北場)')!;
    // 既有欄位不覆寫（全天活動維持），null 欄位補上（票價）
    expect(merged).toMatchObject({
      allDay: true,
      priceMin: 250,
      priceMax: 250,
      status: 'published',
    });
    const links = await handle.db
      .select()
      .from(eventSource)
      .where(eq(eventSource.eventId, merged.id));
    expect(links.map((l) => l.isPrimary).sort()).toEqual([false, true]);
    const tags = await handle.db.select().from(eventTag).where(eq(eventTag.eventId, merged.id));
    expect(tags.some((t) => t.origin === 'source')).toBe(true); // 木棉花來源推論標籤
    const audits = await handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'pipeline.merge'));
    expect(audits).toHaveLength(1);
    await h.cleanupDir();
  });

  it('locked_fields：人工修改的欄位不被重新擷取覆寫；來源變動 → source_changed 待審', async () => {
    const h = await makeDeps(handle, routes());
    await runSource(h.deps, 'cwt', { kind: 'crawl', dryRun: false });
    const target = (await events()).find((e) => e.title === '【CWT-74】(台北場)')!;
    await applyAdminEdit(handle.db, {
      id: target.id,
      actor: 'tester',
      changes: { title: 'CWT-74 台北場（人工修正）' },
      deriveTitleNormalized: normalizeTitle,
      deriveDedupKey: dedupKey,
    });

    // 1) 來源未變 → 標題維持人工值、不標 source_changed
    h.deps.client = null;
    await runSource(h.deps, 'cwt', { kind: 'reparse' });
    let cur = (await handle.db.select().from(event).where(eq(event.id, target.id)))[0]!;
    expect(cur).toMatchObject({
      title: 'CWT-74 台北場（人工修正）',
      lockedFields: ['title'],
      status: 'published',
      reviewReasons: [],
    });

    // 2) 來源標題變了 → 不覆寫，標 source_changed 並退回待審；未鎖定欄位（地址→場館）照常更新
    const changed = cwtHtml
      .toString('utf8')
      .replace('【CWT-74】(台北場)', '【CWT-74】(台北場) 改期公告');
    const h2 = await makeDeps(handle, routes({ [CWT_URL]: html(changed) }));
    await runSource(h2.deps, 'cwt', { kind: 'crawl', dryRun: false });
    cur = (await handle.db.select().from(event).where(eq(event.id, target.id)))[0]!;
    expect(cur.title).toBe('CWT-74 台北場（人工修正）');
    expect(cur.reviewReasons).toEqual(['source_changed']);
    expect(cur.status).toBe('pending_review');
    expect(cur.reviewNotes).toContain('來源變動的鎖定欄位：title');
    await h.cleanupDir();
    await h2.cleanupDir();
  });

  it('單一來源失敗不影響其它來源；失敗告警經 webhook 送出且節流', async () => {
    const h = await makeDeps(
      handle,
      routes({ [CWT_URL]: () => new Response('down', { status: 503 }) }),
      { webhook: true },
    );
    const [cwt, ff] = await runSources(h.deps, ['cwt', 'ff'], { kind: 'crawl', dryRun: false });
    expect(cwt?.status).toBe('failed');
    expect(cwt?.error).toContain('HTTP 503');
    expect(ff?.status).toBe('succeeded');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toContain('來源擷取失敗：cwt');

    await runSource(h.deps, 'cwt', { kind: 'crawl', dryRun: false });
    expect(h.alerts).toHaveLength(2); // 規則再次觸發
    expect(h.sent).toHaveLength(1); // 但節流中，未再送出
    const [run] = await handle.db
      .select()
      .from(crawlRun)
      .where(eq(crawlRun.sourceId, 'cwt'))
      .limit(1);
    expect(run?.status).toBe('failed');
    await h.cleanupDir();
  });

  it('連續 N 次 0 筆告警（預設 3）；恢復後清除節流', async () => {
    const empty = Object.fromEntries(
      ['動漫', '動畫', '聲優', '同人', 'cosplay'].map((k) => [
        kktixUrl(k),
        html(emptyAtom, 'application/atom+xml'),
      ]),
    );
    const h = await makeDeps(handle, routes(empty), { webhook: true });
    for (let i = 0; i < 3; i++) await runSource(h.deps, 'kktix', { kind: 'crawl', dryRun: false });
    expect(h.sent.map((s) => s.text.split('\n')[0])).toEqual([
      ':rotating_light: *[Anime Event Hub] 來源連續 3 次 0 筆：kktix*',
    ]);
    await runSource(h.deps, 'kktix', { kind: 'crawl', dryRun: false });
    expect(h.sent).toHaveLength(1); // 第 4 次：節流

    const h2 = await makeDeps(handle, routes(), { webhook: true });
    await runSource(h2.deps, 'kktix', { kind: 'crawl', dryRun: false });
    const state = await handle.db.execute(
      sql`select key from alert_state where key = 'empty:kktix'`,
    );
    expect(state).toHaveLength(0);
    await h.cleanupDir();
    await h2.cleanupDir();
  });

  it('結構未驗證的擷取器預設不執行', async () => {
    const h = await makeDeps(handle, routes());
    const r = await runSource(h.deps, 'muse', { kind: 'crawl', dryRun: false });
    expect(r).toMatchObject({ status: 'skipped', error: '擷取器結構未驗證' });
    await h.cleanupDir();
  });

  it('cleanup：刪除逾期快照（DB 與檔案）並標記已結束活動', async () => {
    const h = await makeDeps(handle, routes());
    await runSource(h.deps, 'cwt', { kind: 'crawl', dryRun: false });
    expect(await handle.db.select().from(rawSnapshot)).toHaveLength(1);
    // 31 天後
    const r = await cleanup(h.deps, { retentionDays: 30, now: new Date(Date.UTC(2026, 11, 20)) });
    expect(r.snapshotRows).toBe(1);
    expect(r.snapshotDirs).toEqual(['cwt/2026-11-18']);
    expect(r.endedEvents).toBe(1); // CWT-74（12/12–13）已結束
    expect(await handle.db.select().from(rawSnapshot)).toHaveLength(0);
    await h.cleanupDir();
  });

  it('dedup 指令：同鍵活動合併', async () => {
    const h = await makeDeps(handle, routes());
    await runSource(h.deps, 'cwt', { kind: 'crawl', dryRun: false });
    const [a, b] = await events();
    // 把 b 改成與 a 同鍵（模擬字典調整後兩筆變成同一活動）
    await handle.db
      .update(event)
      .set({
        title: a!.title,
        titleNormalized: a!.titleNormalized,
        startAt: a!.startAt,
        venueId: a!.venueId,
      })
      .where(eq(event.id, b!.id));
    const r = await dedupExisting(h.deps);
    expect(r.merged).toEqual([{ from: b!.id, into: a!.id }]);
    expect(await events()).toHaveLength(4);
    await h.cleanupDir();
  });

  it('人工退回待審後，reparse 不會自動改回已發布（H1）', async () => {
    const h = await makeDeps(handle, routes());
    await runSource(h.deps, 'cwt', { kind: 'crawl', dryRun: false });
    const target = (await events()).find((e) => e.title === '【CWT-74】(台北場)')!;
    await setEventStatus(handle.db, { id: target.id, actor: 'tester', status: 'pending_review' });
    h.deps.client = null;
    await runSource(h.deps, 'cwt', { kind: 'reparse' });
    const cur = (await handle.db.select().from(event).where(eq(event.id, target.id)))[0]!;
    expect(cur).toMatchObject({ status: 'pending_review', statusLocked: true });
    await h.cleanupDir();
  });

  it('詳細頁的回應也登記到 raw_snapshot（M2）', async () => {
    const detail: Scraper = {
      id: 'muse',
      schedule: 'daily',
      fixtureStatus: 'real',
      listUrls: () => ['https://muse.test/news'],
      parseList: () => [
        {
          externalId: 'd1',
          url: 'https://muse.test/news/d1',
          candidate: null,
          detailUrl: 'https://muse.test/news/d1',
        },
      ],
      parseDetail: (_body, url) => ({
        sourceId: 'muse',
        externalId: 'd1',
        url,
        title: '某作品 快閃店',
        dateText: '2026/12/20',
        venueText: '三創生活園區',
      }),
    };
    const h = await makeDeps(handle, {
      'https://muse.test/news': html('<html>list</html>'),
      'https://muse.test/news/d1': html('<html>detail</html>'),
    });
    h.deps.scrapers = { ...h.deps.scrapers, muse: detail };
    const r = await runSource(h.deps, 'muse', { kind: 'crawl', dryRun: false });
    expect(r.items[0]?.action).toBe('created');
    const snaps = await handle.db.select().from(rawSnapshot).orderBy(asc(rawSnapshot.id));
    expect(snaps.map((x) => x.url)).toEqual([
      'https://muse.test/news',
      'https://muse.test/news/d1',
    ]);
    expect(snaps.every((x) => x.crawlRunId === r.crawlRunId)).toBe(true);
    const [si] = await handle.db.select().from(sourceItem);
    expect(si?.lastSnapshotId).toBe(snaps[1]?.id);
    await h.cleanupDir();
  });

  it('同一來源同時只能有一個執行（M4）；逾時殘留的 run 會被釋放', async () => {
    const h = await makeDeps(handle, routes());
    await handle.db.insert(crawlRun).values({ sourceId: 'cwt', status: 'running' });
    const r = await runSource(h.deps, 'cwt', { kind: 'crawl', dryRun: false });
    expect(r).toMatchObject({ status: 'skipped' });
    expect(r.error).toContain('執行中');
    expect(h.alerts).toHaveLength(0);

    // 7 小時前開始、從未結束 → 視為殘留，標失敗後可正常執行
    await handle.db
      .update(crawlRun)
      .set({ startedAt: new Date(Date.now() - 7 * 3600_000) })
      .where(eq(crawlRun.status, 'running'));
    const r2 = await runSource(h.deps, 'cwt', { kind: 'crawl', dryRun: false });
    expect(r2.status).toBe('succeeded');
    const stale = await handle.db.select().from(crawlRun).where(eq(crawlRun.status, 'failed'));
    expect(stale).toHaveLength(1);
    await h.cleanupDir();
  });
});
