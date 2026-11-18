// 審核後台的伺服器端邏輯（Server Action 共用）
import {
  addEventTags,
  getEvent,
  loadMatchingDictionaries,
  pendingEventsForRetag,
  primarySourceOf,
  updateEvent,
  writeAudit,
} from '@aeh/db';
import { pruneResolvedReasons, type SourceId } from '@aeh/core';
import { Tagger } from '@aeh/tagger';
import { headers } from 'next/headers';
import { getDb } from './db';

/** 操作者（proxy.ts 驗證 Basic Auth 後放入） */
export async function currentActor(): Promise<string> {
  return (await headers()).get('x-admin-user') ?? 'unknown';
}

/**
 * 新增別名後，對所有待審活動重新比對標籤；類型尚未判定（且未被人工鎖定）者一併重新判定。
 * 只新增，不移除既有標籤（人工標籤不受影響）。
 */
export async function retagPendingEvents(
  actor: string,
): Promise<{ events: number; tagsAdded: number; typed: number }> {
  const db = getDb();
  const dicts = await loadMatchingDictionaries(db);
  const tagger = new Tagger({ typeKeywords: dicts.typeKeywords, tags: dicts.tags });
  const pending = await pendingEventsForRetag(db);
  let tagsAdded = 0;
  let typed = 0;
  for (const p of pending) {
    const sourceId: SourceId | null = await primarySourceOf(db, p.id);
    const r = tagger.tag({ title: p.title, ...(sourceId ? { sourceId } : {}) });
    await db.transaction(async (tx) => {
      tagsAdded += await addEventTags(
        tx,
        p.id,
        r.tags.map((t) => ({ tagId: t.tag.id, origin: t.origin, matchedBy: t.matchedBy })),
      );
      const ev = await getEvent(tx, p.id);
      if (ev && ev.type === null && r.type.type !== null && !ev.lockedFields.includes('type')) {
        const merged = { ...ev, type: r.type.type };
        await updateEvent(tx, p.id, {
          type: r.type.type,
          reviewReasons: pruneResolvedReasons(ev.reviewReasons, merged),
        });
        typed++;
      }
    });
  }
  await writeAudit(db, {
    actor,
    action: 'event.retag_pending',
    entity: 'event',
    entityId: '*',
    diff: { events: pending.length, tagsAdded, typed },
  });
  return { events: pending.length, tagsAdded, typed };
}
