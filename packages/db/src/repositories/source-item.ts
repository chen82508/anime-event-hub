import type { SourceId } from '@aeh/core';
import { and, eq } from 'drizzle-orm';
import { sourceItem } from '../schema';
import type { DbOrTx } from './types';

export interface SourceItemUpsert {
  sourceId: SourceId;
  externalId: string;
  url: string;
  /** parsed 內容的 hash；不變 → 不重新處理（idempotent） */
  contentHash: string;
  parsed: unknown;
  snapshotId: number | null;
  skipReason: string | null;
}

export interface SourceItemUpsertResult {
  id: number;
  eventId: number | null;
  isNew: boolean;
  changed: boolean;
  /** 更新前保存的 parsed（判斷鎖定欄位的來源值是否變動，R7） */
  previousParsed: unknown;
}

export async function upsertSourceItem(
  tx: DbOrTx,
  item: SourceItemUpsert,
): Promise<SourceItemUpsertResult> {
  const [prev] = await tx
    .select({
      id: sourceItem.id,
      contentHash: sourceItem.contentHash,
      eventId: sourceItem.eventId,
      parsed: sourceItem.parsed,
    })
    .from(sourceItem)
    .where(and(eq(sourceItem.sourceId, item.sourceId), eq(sourceItem.externalId, item.externalId)))
    .for('update');
  const now = new Date();
  if (!prev) {
    const [row] = await tx
      .insert(sourceItem)
      .values({
        sourceId: item.sourceId,
        externalId: item.externalId,
        url: item.url,
        contentHash: item.contentHash,
        parsed: item.parsed,
        lastSnapshotId: item.snapshotId,
        skipReason: item.skipReason,
      })
      .returning({ id: sourceItem.id });
    return { id: row!.id, eventId: null, isNew: true, changed: true, previousParsed: null };
  }
  const changed = prev.contentHash !== item.contentHash;
  await tx
    .update(sourceItem)
    .set({
      url: item.url,
      lastSeenAt: now,
      lastSnapshotId: item.snapshotId,
      skipReason: item.skipReason,
      ...(changed ? { contentHash: item.contentHash, parsed: item.parsed } : {}),
    })
    .where(eq(sourceItem.id, prev.id));
  return { id: prev.id, eventId: prev.eventId, isNew: false, changed, previousParsed: prev.parsed };
}

export async function linkSourceItemToEvent(
  tx: DbOrTx,
  sourceItemId: number,
  eventId: number,
): Promise<void> {
  await tx.update(sourceItem).set({ eventId }).where(eq(sourceItem.id, sourceItemId));
}
