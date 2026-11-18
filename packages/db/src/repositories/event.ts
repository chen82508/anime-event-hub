/**
 * 活動 repository：管線寫入（新增、更新、合併、去重候選）與審核後台操作（補欄位、發布、合併）。
 *
 * 規則（C4 / R7）：
 * - 人工改過的欄位寫入 locked_fields，管線不得覆寫（由 @aeh/dedup 的 planSourceUpdate 判定）
 * - 發布前必要欄位須齊全、審核原因須清空（DB CHECK 約束 event_published_requirements 為最後防線）
 * - 每個後台操作都寫 audit_log
 */
import {
  LOCKABLE_FIELDS,
  REVIEW_REASONS,
  pruneResolvedReasons,
  requiredFieldReasons,
  type EventStatus,
  type LockableField,
  type NormalizedEvent,
  type ReviewReason,
  type SourceId,
  type TagOrigin,
} from '@aeh/core';
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { event, eventSource, eventTag, source, sourceItem, tag, venue } from '../schema';
import { writeAudit } from './audit';
import type { DbOrTx, Tx } from './types';
import type { Database } from '../client';

export type EventRow = typeof event.$inferSelect;
type EventPatch = Partial<typeof event.$inferInsert>;

function sortReasons(reasons: Iterable<ReviewReason>): ReviewReason[] {
  const set = new Set(reasons);
  return REVIEW_REASONS.filter((r) => set.has(r));
}

// ── 管線 ──────────────────────────────────────────────────

export async function insertEvent(
  tx: DbOrTx,
  input: {
    normalized: NormalizedEvent;
    status: EventStatus;
    dedupKey: string | null;
    notes: string[];
  },
): Promise<number> {
  const n = input.normalized;
  const [row] = await tx
    .insert(event)
    .values({
      title: n.title,
      titleNormalized: n.titleNormalized,
      type: n.type,
      startAt: n.startAt,
      endAt: n.endAt,
      allDay: n.allDay,
      yearInferred: n.yearInferred,
      venueId: n.venueId,
      venueRaw: n.venueRaw,
      isOnline: n.isOnline,
      city: n.city,
      region: n.region,
      priceMin: n.priceMin,
      priceMax: n.priceMax,
      isFree: n.isFree,
      saleStartAt: n.saleStartAt,
      status: input.status,
      reviewReasons: n.reviewReasons,
      reviewNotes: input.notes,
      dedupKey: input.dedupKey,
      publishedAt: input.status === 'published' ? new Date() : null,
    })
    .returning({ id: event.id });
  return row!.id;
}

export async function getEvent(tx: DbOrTx, id: number): Promise<EventRow | null> {
  const [row] = await tx.select().from(event).where(eq(event.id, id));
  return row ?? null;
}

/** 更新欄位；狀態轉為 published 時補上 published_at */
export async function updateEvent(tx: DbOrTx, id: number, patch: EventPatch): Promise<void> {
  const publishedAt =
    patch.status === 'published' && patch.publishedAt === undefined
      ? { publishedAt: sql`coalesce(${event.publishedAt}, now())` }
      : {};
  await tx
    .update(event)
    .set({ ...patch, ...publishedAt })
    .where(eq(event.id, id));
}

export async function attachEventSource(
  tx: DbOrTx,
  s: { eventId: number; sourceItemId: number; url: string; isPrimary: boolean },
): Promise<void> {
  await tx.insert(eventSource).values(s).onConflictDoNothing();
  await tx.update(sourceItem).set({ eventId: s.eventId }).where(eq(sourceItem.id, s.sourceItemId));
}

export async function isPrimarySource(
  tx: DbOrTx,
  eventId: number,
  sourceItemId: number,
): Promise<boolean> {
  const [row] = await tx
    .select({ isPrimary: eventSource.isPrimary })
    .from(eventSource)
    .where(and(eq(eventSource.eventId, eventId), eq(eventSource.sourceItemId, sourceItemId)));
  return row?.isPrimary ?? false;
}

export interface DedupCandidateRow {
  eventId: number;
  titleNormalized: string;
  startAt: Date | null;
  venueId: number | null;
  isOnline: boolean;
  similarity: number;
}

/**
 * 去重候選（pg_trgm）：去重鍵相同者，或開始日期在 ±windowDays 內且標題相似度 ≥ minSimilarity 者。
 * 不含已隱藏/取消的活動。
 */
export async function findDedupCandidates(
  tx: DbOrTx,
  q: {
    titleNormalized: string;
    startAt: Date | null;
    dedupKey: string | null;
    windowDays: number;
    minSimilarity: number;
    excludeEventIds?: number[];
    limit?: number;
  },
): Promise<DedupCandidateRow[]> {
  const sim = sql<number>`similarity(${event.titleNormalized}, ${q.titleNormalized})`;
  const conds: SQL[] = [];
  if (q.dedupKey) conds.push(eq(event.dedupKey, q.dedupKey));
  if (q.startAt) {
    const from = new Date(q.startAt.getTime() - q.windowDays * 86_400_000);
    const to = new Date(q.startAt.getTime() + q.windowDays * 86_400_000);
    conds.push(
      and(gte(event.startAt, from), lte(event.startAt, to), gte(sim, q.minSimilarity)) as SQL,
    );
  }
  if (conds.length === 0) return [];
  const exclude = q.excludeEventIds ?? [];
  const rows = await tx
    .select({
      eventId: event.id,
      titleNormalized: event.titleNormalized,
      startAt: event.startAt,
      venueId: event.venueId,
      isOnline: event.isOnline,
      similarity: sim,
    })
    .from(event)
    .where(
      and(
        or(...conds),
        inArray(event.status, ['pending_review', 'published']),
        exclude.length > 0 ? sql`${event.id} not in ${exclude}` : undefined,
      ),
    )
    .orderBy(desc(sim), asc(event.id))
    .limit(q.limit ?? 20);
  return rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
}

/** 新增標籤（已存在者略過），回傳實際新增的數量 */
export async function addEventTags(
  tx: DbOrTx,
  eventId: number,
  tags: { tagId: number; origin: TagOrigin; matchedBy: string | null }[],
): Promise<number> {
  if (tags.length === 0) return 0;
  const rows = await tx
    .insert(eventTag)
    .values(tags.map((t) => ({ eventId, ...t })))
    .onConflictDoNothing()
    .returning({ tagId: eventTag.tagId });
  return rows.length;
}

/** 已發布且已結束的活動 → ended（全天單日活動以開始日隔天為準） */
export async function markEndedEvents(db: DbOrTx, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(event)
    .set({ status: 'ended' })
    .where(
      and(
        eq(event.status, 'published'),
        sql`coalesce(${event.endAt}, ${event.startAt} + interval '1 day') < ${now.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: event.id });
  return rows.length;
}

// ── 審核後台 ──────────────────────────────────────────────

export interface ReviewListFilter {
  status?: EventStatus;
  reason?: ReviewReason;
  sourceId?: SourceId;
  /** 標題關鍵字（原文或正規化標題） */
  q?: string;
  limit?: number;
  offset?: number;
}

export async function listEventsForReview(db: DbOrTx, f: ReviewListFilter) {
  const conds: (SQL | undefined)[] = [
    f.status ? eq(event.status, f.status) : undefined,
    f.reason ? arrayContains(event.reviewReasons, [f.reason]) : undefined,
    f.q
      ? or(ilike(event.title, `%${f.q}%`), ilike(event.titleNormalized, `%${f.q.toLowerCase()}%`))
      : undefined,
    f.sourceId
      ? sql`exists (select 1 from ${eventSource} es join ${sourceItem} si on si.id = es.source_item_id
             where es.event_id = ${event.id} and si.source_id = ${f.sourceId})`
      : undefined,
  ];
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: event.id,
        title: event.title,
        type: event.type,
        status: event.status,
        startAt: event.startAt,
        allDay: event.allDay,
        venueName: venue.name,
        venueRaw: event.venueRaw,
        isOnline: event.isOnline,
        city: event.city,
        reviewReasons: event.reviewReasons,
        lockedFields: event.lockedFields,
        updatedAt: event.updatedAt,
        sources: sql<SourceId[]>`array(select distinct si.source_id from ${eventSource} es
          join ${sourceItem} si on si.id = es.source_item_id where es.event_id = ${event.id})`,
      })
      .from(event)
      .leftJoin(venue, eq(venue.id, event.venueId))
      .where(where)
      .orderBy(asc(sql`${event.startAt} is null`), asc(event.startAt), asc(event.id))
      .limit(f.limit ?? 50)
      .offset(f.offset ?? 0),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(event)
      .where(where),
  ]);
  return { rows, total: count?.n ?? 0 };
}

export async function getEventDetail(db: DbOrTx, id: number) {
  const ev = await getEvent(db, id);
  if (!ev) return null;
  const [venueRow, sources, tags] = await Promise.all([
    ev.venueId
      ? db
          .select()
          .from(venue)
          .where(eq(venue.id, ev.venueId))
          .then((r) => r[0] ?? null)
      : null,
    db
      .select({
        sourceItemId: sourceItem.id,
        sourceId: sourceItem.sourceId,
        sourceName: source.name,
        externalId: sourceItem.externalId,
        url: eventSource.url,
        isPrimary: eventSource.isPrimary,
        parsed: sourceItem.parsed,
        lastSeenAt: sourceItem.lastSeenAt,
      })
      .from(eventSource)
      .innerJoin(sourceItem, eq(sourceItem.id, eventSource.sourceItemId))
      .innerJoin(source, eq(source.id, sourceItem.sourceId))
      .where(eq(eventSource.eventId, id))
      .orderBy(desc(eventSource.isPrimary), asc(sourceItem.id)),
    db
      .select({
        id: tag.id,
        kind: tag.kind,
        slug: tag.slug,
        name: tag.name,
        origin: eventTag.origin,
        matchedBy: eventTag.matchedBy,
      })
      .from(eventTag)
      .innerJoin(tag, eq(tag.id, eventTag.tagId))
      .where(eq(eventTag.eventId, id))
      .orderBy(asc(tag.kind), asc(tag.slug)),
  ]);
  return { event: ev, venue: venueRow, sources, tags };
}

export class PublishBlockedError extends Error {
  override name = 'PublishBlockedError';
  constructor(readonly reasons: string[]) {
    super(`無法發布：${reasons.join('、')}`);
  }
}

export type AdminFieldChanges = Partial<{
  title: string;
  type: EventRow['type'];
  startAt: Date | null;
  endAt: Date | null;
  allDay: boolean;
  venueId: number | null;
  isOnline: boolean;
  city: EventRow['city'];
  region: EventRow['region'];
  priceMin: number | null;
  priceMax: number | null;
  isFree: boolean;
  saleStartAt: Date | null;
}>;

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/**
 * 後台補齊/修正欄位：實際有變的欄位寫入 locked_fields、移除已解決的審核原因、重算去重鍵、寫 audit_log。
 * 指定場館時一併帶入場館的縣市/地區；改為線上時清除場館。
 */
export async function applyAdminEdit(
  db: Database,
  input: {
    id: number;
    actor: string;
    changes: AdminFieldChanges;
    /** 由呼叫端提供（@aeh/normalize、@aeh/dedup），db 套件不依賴解析邏輯 */
    deriveTitleNormalized: (title: string) => string;
    deriveDedupKey: (
      e: Pick<EventRow, 'titleNormalized' | 'startAt' | 'venueId' | 'isOnline'>,
    ) => string | null;
  },
): Promise<{ changed: LockableField[]; demoted: boolean; reviewReasons: ReviewReason[] }> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(event).where(eq(event.id, input.id)).for('update');
    if (!cur) throw new Error(`活動不存在：${input.id}`);
    const changes: AdminFieldChanges = { ...input.changes };

    if (changes.venueId !== undefined && changes.venueId !== null) {
      const [v] = await tx.select().from(venue).where(eq(venue.id, changes.venueId));
      if (!v) throw new Error(`場館不存在：${changes.venueId}`);
      changes.city = v.city;
      changes.region = v.region;
      changes.isOnline = false;
    }
    if (changes.isOnline === true) {
      changes.venueId = null;
      changes.region = 'online';
      changes.city = null;
    }

    const changed = LOCKABLE_FIELDS.filter(
      (f) => changes[f] !== undefined && !sameValue(changes[f], cur[f]),
    );
    if (changed.length === 0) return { changed, demoted: false, reviewReasons: cur.reviewReasons };

    const patch: EventPatch = {};
    for (const f of changed) Object.assign(patch, { [f]: changes[f] });
    if (patch.title !== undefined) patch.titleNormalized = input.deriveTitleNormalized(patch.title);
    const merged = { ...cur, ...patch } as EventRow;
    // 移除已解決的原因；人工清空必要欄位時補上對應原因（不與既有的場館類原因重複）
    const reasons = pruneResolvedReasons(cur.reviewReasons, cur, merged);
    const venueReasonExists = reasons.some((r) => r === 'unknown_venue' || r === 'outside_taiwan');
    for (const r of requiredFieldReasons(merged)) {
      if (r === 'missing_venue' && venueReasonExists) continue;
      reasons.push(r);
    }
    if (merged.type === null) reasons.push('type_unresolved');
    patch.reviewReasons = sortReasons(reasons);
    // 已發布活動被改成不符合發布條件 → 自動退回待審（C4；否則會違反 DB CHECK 約束）
    const demoted = cur.status === 'published' && patch.reviewReasons.length > 0;
    if (demoted) patch.status = 'pending_review';
    patch.dedupKey = input.deriveDedupKey(merged);
    patch.lockedFields = [...new Set([...cur.lockedFields, ...changed])];

    await tx.update(event).set(patch).where(eq(event.id, input.id));
    await writeAudit(tx, {
      actor: input.actor,
      action: 'event.update',
      entity: 'event',
      entityId: input.id,
      diff: {
        before: Object.fromEntries(changed.map((f) => [f, cur[f]])),
        after: Object.fromEntries(changed.map((f) => [f, patch[f]])),
        resolvedReasons: cur.reviewReasons.filter((r) => !patch.reviewReasons!.includes(r)),
        ...(demoted ? { demotedTo: 'pending_review' } : {}),
      },
    });
    return { changed, demoted, reviewReasons: patch.reviewReasons };
  });
}

/** 人工解除審核原因（如「確認不是重複」「已確認來源變動」「保留未達門檻的活動」） */
export async function resolveReviewReasons(
  db: Database,
  input: { id: number; actor: string; reasons: ReviewReason[] },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(event).where(eq(event.id, input.id)).for('update');
    if (!cur) throw new Error(`活動不存在：${input.id}`);
    const next = cur.reviewReasons.filter((r) => !input.reasons.includes(r));
    if (next.length === cur.reviewReasons.length) return;
    await tx.update(event).set({ reviewReasons: next }).where(eq(event.id, input.id));
    await writeAudit(tx, {
      actor: input.actor,
      action: 'event.resolve_reasons',
      entity: 'event',
      entityId: input.id,
      diff: { resolved: input.reasons.filter((r) => cur.reviewReasons.includes(r)) },
    });
  });
}

/** 手動發布：必要欄位齊全、無審核原因、已有類型（C4） */
export async function publishEvent(
  db: Database,
  input: { id: number; actor: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(event).where(eq(event.id, input.id)).for('update');
    if (!cur) throw new Error(`活動不存在：${input.id}`);
    const blockers: string[] = [...requiredFieldReasons(cur), ...cur.reviewReasons];
    if (cur.type === null) blockers.push('type_unresolved');
    if (blockers.length > 0) throw new PublishBlockedError([...new Set(blockers)]);
    await tx
      .update(event)
      .set({ status: 'published', publishedAt: cur.publishedAt ?? new Date(), statusLocked: false })
      .where(eq(event.id, input.id));
    await writeAudit(tx, {
      actor: input.actor,
      action: 'event.publish',
      entity: 'event',
      entityId: input.id,
      diff: { from: cur.status },
    });
  });
}

/** 隱藏 / 取消 / 退回待審 / 結束。設定 status_locked，管線之後不會自動改變狀態（含自動發布） */
export async function setEventStatus(
  db: Database,
  input: { id: number; actor: string; status: Exclude<EventStatus, 'published'> },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [cur] = await tx
      .select({ status: event.status, statusLocked: event.statusLocked })
      .from(event)
      .where(eq(event.id, input.id))
      .for('update');
    if (!cur) throw new Error(`活動不存在：${input.id}`);
    if (cur.status === input.status && cur.statusLocked) return;
    await tx
      .update(event)
      .set({ status: input.status, statusLocked: true })
      .where(eq(event.id, input.id));
    await writeAudit(tx, {
      actor: input.actor,
      action: `event.status`,
      entity: 'event',
      entityId: input.id,
      diff: { from: cur.status, to: input.status },
    });
  });
}

export async function addManualTag(
  db: Database,
  input: { eventId: number; tagId: number; actor: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(eventTag)
      .values({
        eventId: input.eventId,
        tagId: input.tagId,
        origin: 'manual',
        matchedBy: `manual:${input.actor}`,
      })
      .onConflictDoNothing();
    await writeAudit(tx, {
      actor: input.actor,
      action: 'event.add_tag',
      entity: 'event',
      entityId: input.eventId,
      diff: { tagId: input.tagId },
    });
  });
}

export async function removeTag(
  db: Database,
  input: { eventId: number; tagId: number; actor: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(eventTag)
      .where(and(eq(eventTag.eventId, input.eventId), eq(eventTag.tagId, input.tagId)));
    await writeAudit(tx, {
      actor: input.actor,
      action: 'event.remove_tag',
      entity: 'event',
      entityId: input.eventId,
      diff: { tagId: input.tagId },
    });
  });
}

/**
 * 合併疑似重複：from 的來源與標籤移到 into、補 into 為 null 的未鎖定欄位、刪除 from。
 * into 的 possible_duplicate 在沒有其它疑似對象時由審核者另行解除。
 */
export async function mergeEvents(
  db: Database,
  input: {
    fromId: number;
    intoId: number;
    actor: string;
    deriveDedupKey: (e: EventRow) => string | null;
  },
): Promise<void> {
  if (input.fromId === input.intoId) throw new Error('不能合併到自己');
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(event)
      .where(inArray(event.id, [input.fromId, input.intoId]))
      .for('update');
    const from = rows.find((r) => r.id === input.fromId);
    const into = rows.find((r) => r.id === input.intoId);
    if (!from || !into) throw new Error('活動不存在');

    await mergeInto(tx, from, into);
    const fresh = (await getEvent(tx, into.id))!;
    await tx
      .update(event)
      .set({ dedupKey: input.deriveDedupKey(fresh) })
      .where(eq(event.id, into.id));
    await writeAudit(tx, {
      actor: input.actor,
      action: 'event.merge',
      entity: 'event',
      entityId: into.id,
      diff: { mergedFrom: from.id, fromTitle: from.title },
    });
  });
}

/** 合併核心（管線與後台共用）：搬移來源與標籤、補空欄位、刪除 from */
export async function mergeInto(tx: Tx, from: EventRow, into: EventRow): Promise<void> {
  const fill: EventPatch = {};
  for (const f of LOCKABLE_FIELDS) {
    if (into.lockedFields.includes(f)) continue;
    if (into[f] === null && from[f] !== null) Object.assign(fill, { [f]: from[f] });
  }
  if (fill.venueId !== undefined) fill.venueRaw = from.venueRaw;
  const merged = { ...into, ...fill };
  fill.reviewReasons = sortReasons(pruneResolvedReasons(into.reviewReasons, into, merged));
  fill.reviewNotes = [...new Set([...into.reviewNotes, ...from.reviewNotes])];

  await tx.update(eventSource).set({ isPrimary: false }).where(eq(eventSource.eventId, from.id));
  await tx.update(eventSource).set({ eventId: into.id }).where(eq(eventSource.eventId, from.id));
  await tx.update(sourceItem).set({ eventId: into.id }).where(eq(sourceItem.eventId, from.id));
  await tx.execute(sql`
    insert into event_tag (event_id, tag_id, origin, matched_by)
    select ${into.id}, tag_id, origin, matched_by from event_tag where event_id = ${from.id}
    on conflict do nothing`);
  await tx.update(event).set(fill).where(eq(event.id, into.id));
  await tx.delete(event).where(eq(event.id, from.id));
}

/** 疑似重複的對象（後台顯示用）：同去重鍵或相似標題、日期相近 */
export async function possibleDuplicatesOf(
  db: DbOrTx,
  ev: EventRow,
  opts: { windowDays: number; minSimilarity: number },
) {
  const cands = await findDedupCandidates(db, {
    titleNormalized: ev.titleNormalized,
    startAt: ev.startAt,
    dedupKey: ev.dedupKey,
    windowDays: opts.windowDays,
    minSimilarity: opts.minSimilarity,
    excludeEventIds: [ev.id],
    limit: 10,
  });
  if (cands.length === 0) return [];
  const titles = await db
    .select({ id: event.id, title: event.title, status: event.status })
    .from(event)
    .where(
      inArray(
        event.id,
        cands.map((c) => c.eventId),
      ),
    );
  return cands.map((c) => ({ ...c, ...titles.find((t) => t.id === c.eventId)! }));
}

/** 待審活動（重新標籤用） */
export async function pendingEventsForRetag(db: DbOrTx) {
  return db
    .select({ id: event.id, title: event.title })
    .from(event)
    .where(and(eq(event.status, 'pending_review'), ne(event.title, '')));
}

/** 活動所屬來源（重新標籤時做來源推論） */
export async function primarySourceOf(db: DbOrTx, eventId: number): Promise<SourceId | null> {
  const [row] = await db
    .select({ sourceId: sourceItem.sourceId })
    .from(eventSource)
    .innerJoin(sourceItem, eq(sourceItem.id, eventSource.sourceItemId))
    .where(eq(eventSource.eventId, eventId))
    .orderBy(desc(eventSource.isPrimary))
    .limit(1);
  return row?.sourceId ?? null;
}

/**
 * 拆分（T10）：把活動中的某個來源拆成獨立的新活動（例如被誤合併的不同場次）。
 * 新活動的欄位由呼叫端以該來源的 parsed 重新正規化後傳入，一律為待審、狀態鎖定。
 */
export async function splitEventSource(
  db: Database,
  input: {
    eventId: number;
    sourceItemId: number;
    actor: string;
    newEvent: { normalized: NormalizedEvent; dedupKey: string | null; notes: string[] };
    tags: { tagId: number; origin: TagOrigin; matchedBy: string | null }[];
  },
): Promise<number> {
  return db.transaction(async (tx) => {
    const links = await tx
      .select()
      .from(eventSource)
      .where(eq(eventSource.eventId, input.eventId))
      .for('update');
    const link = links.find((l) => l.sourceItemId === input.sourceItemId);
    if (!link) throw new Error('此來源不屬於這個活動');
    if (links.length < 2) throw new Error('活動只有一個來源，無法拆分');

    const newId = await insertEvent(tx, {
      normalized: input.newEvent.normalized,
      status: 'pending_review',
      dedupKey: input.newEvent.dedupKey,
      notes: [...input.newEvent.notes, `由活動 #${input.eventId} 拆分`],
    });
    await tx.update(event).set({ statusLocked: true }).where(eq(event.id, newId));
    await tx
      .delete(eventSource)
      .where(
        and(
          eq(eventSource.eventId, input.eventId),
          eq(eventSource.sourceItemId, input.sourceItemId),
        ),
      );
    await tx
      .insert(eventSource)
      .values({ eventId: newId, sourceItemId: input.sourceItemId, url: link.url, isPrimary: true });
    await tx
      .update(sourceItem)
      .set({ eventId: newId })
      .where(eq(sourceItem.id, input.sourceItemId));
    if (link.isPrimary) {
      const next = links
        .filter((l) => l.sourceItemId !== input.sourceItemId)
        .sort((a, b) => a.sourceItemId - b.sourceItemId)[0]!;
      await tx
        .update(eventSource)
        .set({ isPrimary: true })
        .where(
          and(
            eq(eventSource.eventId, input.eventId),
            eq(eventSource.sourceItemId, next.sourceItemId),
          ),
        );
    }
    await addEventTags(tx, newId, input.tags);
    await writeAudit(tx, {
      actor: input.actor,
      action: 'event.split',
      entity: 'event',
      entityId: input.eventId,
      diff: { sourceItemId: input.sourceItemId, newEventId: newId },
    });
    return newId;
  });
}
