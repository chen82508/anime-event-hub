/**
 * 維護作業：cleanup（快照保留 ≤ 30 天、結束活動標記）與 dedup（既有活動的去重重算）。
 */
import {
  deleteSnapshotsBefore,
  event,
  getEvent,
  markEndedEvents,
  mergeInto,
  updateEvent,
  writeAudit,
  type Database,
} from '@aeh/db';
import { dedupKey } from '@aeh/dedup';
import type { SnapshotStore } from '@aeh/http';
import { taipeiDateString } from '@aeh/normalize';
import { and, asc, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

export async function cleanup(
  deps: { db: Database; store: SnapshotStore; logger: Logger },
  opts: { retentionDays: number; now?: Date },
): Promise<{ snapshotRows: number; snapshotDirs: string[]; endedEvents: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.retentionDays * 86_400_000);
  // DB 先刪（source_item.last_snapshot_id 會被設為 NULL），再刪檔案；以台灣日期目錄為單位
  const snapshotRows = await deleteSnapshotsBefore(deps.db, cutoff);
  const snapshotDirs = await deps.store.removeDaysBefore(taipeiDateString(cutoff));
  const endedEvents = await markEndedEvents(deps.db, now);
  deps.logger.info(
    { snapshotRows, snapshotDirs: snapshotDirs.length, endedEvents, cutoff },
    'cleanup 完成',
  );
  return { snapshotRows, snapshotDirs, endedEvents };
}

/**
 * 重算所有活動的去重鍵，並自動合併同鍵者（保留 id 最小者）。
 * 用於字典或正規化規則調整之後；灰色區間不在此處理（新項目進管線時才標 possible_duplicate）。
 */
export async function dedupExisting(
  deps: { db: Database; logger: Logger },
  opts: { dryRun?: boolean } = {},
): Promise<{ rekeyed: number; merged: { from: number; into: number }[] }> {
  const rows = await deps.db
    .select()
    .from(event)
    .where(inArray(event.status, ['pending_review', 'published']))
    .orderBy(asc(event.id));
  let rekeyed = 0;
  for (const e of rows) {
    const key = dedupKey(e);
    if (key !== e.dedupKey) {
      rekeyed++;
      if (!opts.dryRun) await updateEvent(deps.db, e.id, { dedupKey: key });
    }
  }
  const groups = await deps.db
    .select({
      key: event.dedupKey,
      ids: sql<number[]>`array_agg(${event.id} order by ${event.id})`,
    })
    .from(event)
    .where(and(isNotNull(event.dedupKey), inArray(event.status, ['pending_review', 'published'])))
    .groupBy(event.dedupKey)
    .having(sql`count(*) > 1`);
  const merged: { from: number; into: number }[] = [];
  for (const g of groups) {
    const [intoId, ...fromIds] = g.ids.map(Number);
    for (const fromId of fromIds) {
      merged.push({ from: fromId, into: intoId! });
      if (opts.dryRun) continue;
      await deps.db.transaction(async (tx) => {
        const from = await getEvent(tx, fromId);
        const into = await getEvent(tx, intoId!);
        if (!from || !into) return;
        await mergeInto(tx, from, into);
        await writeAudit(tx, {
          actor: 'pipeline',
          action: 'pipeline.merge',
          entity: 'event',
          entityId: intoId!,
          diff: { rule: 'exact_key', key: g.key, mergedFrom: fromId },
        });
      });
    }
  }
  deps.logger.info({ rekeyed, merged: merged.length, dryRun: opts.dryRun ?? false }, 'dedup 完成');
  return { rekeyed, merged };
}
