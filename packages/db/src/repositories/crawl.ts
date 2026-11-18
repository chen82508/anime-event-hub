import type { SourceId } from '@aeh/core';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { crawlRun, rawSnapshot, source } from '../schema';
import type { DbOrTx } from './types';

export async function listSources(db: DbOrTx) {
  return db.select().from(source).orderBy(source.id);
}

export async function getSource(db: DbOrTx, id: SourceId) {
  const [row] = await db.select().from(source).where(eq(source.id, id));
  return row ?? null;
}

export async function startCrawlRun(
  db: DbOrTx,
  sourceId: SourceId,
  dryRun: boolean,
): Promise<number> {
  const [row] = await db
    .insert(crawlRun)
    .values({ sourceId, dryRun })
    .returning({ id: crawlRun.id });
  return row!.id;
}

export interface CrawlCounters {
  itemsFound: number;
  itemsNew: number;
  itemsUpdated: number;
  itemsPendingReview: number;
  itemsSkipped: number;
  itemsMissingFields: number;
}

export async function finishCrawlRun(
  db: DbOrTx,
  id: number,
  result: { status: 'succeeded' | 'failed'; counters: CrawlCounters; error?: string | null },
): Promise<void> {
  await db
    .update(crawlRun)
    .set({
      status: result.status,
      finishedAt: new Date(),
      error: result.error ?? null,
      ...result.counters,
    })
    .where(eq(crawlRun.id, id));
}

/** 執行結果回寫來源：成功時更新 last_success_at；0 筆時累加 consecutive_empty_runs（告警依據） */
export async function updateSourceAfterRun(
  db: DbOrTx,
  sourceId: SourceId,
  r: { succeeded: boolean; itemsFound: number },
): Promise<{ consecutiveEmptyRuns: number }> {
  const [row] = await db
    .update(source)
    .set({
      ...(r.succeeded ? { lastSuccessAt: new Date() } : {}),
      consecutiveEmptyRuns: r.succeeded
        ? r.itemsFound === 0
          ? sql`${source.consecutiveEmptyRuns} + 1`
          : 0
        : source.consecutiveEmptyRuns,
    })
    .where(eq(source.id, sourceId))
    .returning({ consecutiveEmptyRuns: source.consecutiveEmptyRuns });
  return { consecutiveEmptyRuns: row?.consecutiveEmptyRuns ?? 0 };
}

/** 最近 n 次非 dry-run 的執行（新到舊） */
export async function recentCrawlRuns(db: DbOrTx, sourceId: SourceId, n: number) {
  return db
    .select()
    .from(crawlRun)
    .where(and(eq(crawlRun.sourceId, sourceId), eq(crawlRun.dryRun, false)))
    .orderBy(desc(crawlRun.startedAt), desc(crawlRun.id))
    .limit(n);
}

export type SnapshotInsert = typeof rawSnapshot.$inferInsert;

export async function insertSnapshot(db: DbOrTx, s: SnapshotInsert): Promise<number> {
  const [row] = await db.insert(rawSnapshot).values(s).returning({ id: rawSnapshot.id });
  return row!.id;
}

export async function getSnapshot(db: DbOrTx, id: number) {
  const [row] = await db.select().from(rawSnapshot).where(eq(rawSnapshot.id, id));
  return row ?? null;
}

/** 某來源最近一次成功、且有存快照的擷取（reparse 本身不存快照，會被略過） */
export async function snapshotsOfLatestRun(db: DbOrTx, sourceId: SourceId) {
  const [run] = await db
    .select({ id: crawlRun.id })
    .from(crawlRun)
    .where(
      and(
        eq(crawlRun.sourceId, sourceId),
        eq(crawlRun.status, 'succeeded'),
        eq(crawlRun.dryRun, false),
        sql`exists (select 1 from ${rawSnapshot} rs where rs.crawl_run_id = ${crawlRun.id})`,
      ),
    )
    .orderBy(desc(crawlRun.startedAt), desc(crawlRun.id))
    .limit(1);
  if (!run) return [];
  return db
    .select()
    .from(rawSnapshot)
    .where(eq(rawSnapshot.crawlRunId, run.id))
    .orderBy(rawSnapshot.id);
}

/** 刪除早於 cutoff 的快照登記（檔案由 SnapshotStore 清理），回傳刪除筆數 */
export async function deleteSnapshotsBefore(db: DbOrTx, cutoff: Date): Promise<number> {
  const rows = await db
    .delete(rawSnapshot)
    .where(lt(rawSnapshot.fetchedAt, cutoff))
    .returning({ id: rawSnapshot.id });
  return rows.length;
}

export async function snapshotsByIds(db: DbOrTx, ids: number[]) {
  if (ids.length === 0) return [];
  return db.select().from(rawSnapshot).where(inArray(rawSnapshot.id, ids));
}
