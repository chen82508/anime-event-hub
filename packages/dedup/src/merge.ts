/**
 * 合併規則（tech-spec T8、R7）：合併與重新擷取都不得覆寫 `locked_fields`。
 *
 * - `fillMissing`：跨來源合併時，只補既有活動中為 null 的欄位
 * - `planSourceUpdate`：同一來源項目內容變動時
 *   - 主要來源：未鎖定欄位以新值覆寫；鎖定欄位保留，若新值不同 → source_changed 待審
 *   - 非主要來源：只補 null 欄位
 *   - 審核原因依新欄位重算；已隱藏/取消/結束的活動維持原狀態
 */
import {
  LOCKABLE_FIELDS,
  isAutoPublishable,
  pruneResolvedReasons,
  type EventStatus,
  type LockableField,
  type NormalizedEvent,
  type ReviewReason,
  REVIEW_REASONS,
} from '@aeh/core';

/** 可合併/覆寫的欄位：可鎖定欄位 ＋ 隨標題/場館衍生的欄位 */
export type EventFields = Pick<
  NormalizedEvent,
  LockableField | 'titleNormalized' | 'venueRaw' | 'yearInferred'
>;

/** 跟著某個可鎖定欄位一起變動的衍生欄位 */
const DERIVED: Partial<Record<LockableField, (keyof EventFields)[]>> = {
  title: ['titleNormalized'],
  venueId: ['venueRaw'],
  startAt: ['yearInferred'],
};

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function sortReasons(reasons: Iterable<ReviewReason>): ReviewReason[] {
  const set = new Set(reasons);
  return REVIEW_REASONS.filter((r) => set.has(r));
}

/** 跨來源合併：只補 null 欄位，不碰鎖定欄位 */
export function fillMissing(
  current: EventFields,
  incoming: EventFields,
  locked: readonly LockableField[],
): Partial<EventFields> {
  const patch: Partial<EventFields> = {};
  for (const f of LOCKABLE_FIELDS) {
    if (locked.includes(f)) continue;
    if (current[f] === null && incoming[f] !== null) {
      Object.assign(patch, { [f]: incoming[f] });
      for (const d of DERIVED[f] ?? []) Object.assign(patch, { [d]: incoming[d] });
    }
  }
  return patch;
}

export interface SourceUpdatePlan {
  patch: Partial<EventFields>;
  reviewReasons: ReviewReason[];
  status: EventStatus;
  /** 來源值較上次變動、但該欄位已被人工鎖定（→ source_changed） */
  lockedConflicts: LockableField[];
}

export function planSourceUpdate(input: {
  current: EventFields & { reviewReasons: ReviewReason[]; status: EventStatus };
  incoming: NormalizedEvent;
  locked: readonly LockableField[];
  isPrimary: boolean;
  /**
   * 同一來源項目上次解析的結果。鎖定欄位只有在「來源值相較上次有變」時才算衝突；
   * 人工值本來就與來源不同，不能因此每次都標 source_changed。沒有上次結果（新連結）時不判定衝突。
   */
  previous?: EventFields | null;
}): SourceUpdatePlan {
  const { current, incoming, locked, isPrimary, previous } = input;
  const lockedConflicts = previous
    ? LOCKABLE_FIELDS.filter(
        (f) =>
          locked.includes(f) && !same(previous[f], incoming[f]) && !same(current[f], incoming[f]),
      )
    : [];

  let patch: Partial<EventFields>;
  if (isPrimary) {
    patch = {};
    for (const f of LOCKABLE_FIELDS) {
      if (locked.includes(f) || same(current[f], incoming[f])) continue;
      Object.assign(patch, { [f]: incoming[f] });
      for (const d of DERIVED[f] ?? []) Object.assign(patch, { [d]: incoming[d] });
    }
    if (!locked.includes('title') && current.titleNormalized !== incoming.titleNormalized) {
      patch.titleNormalized = incoming.titleNormalized;
    }
  } else {
    patch = fillMissing(current, incoming, locked);
  }
  const merged = { ...current, ...patch };

  // 主要來源：以新解析的原因為準；非主要來源：沿用既有原因。兩者都保留人工才能解除的原因
  const base = isPrimary
    ? [
        ...incoming.reviewReasons,
        ...current.reviewReasons.filter(
          (r) => r === 'possible_duplicate' || r === 'source_changed',
        ),
      ]
    : current.reviewReasons;
  const reasons = pruneResolvedReasons(base, merged);
  if (lockedConflicts.length > 0) reasons.push('source_changed');
  const reviewReasons = sortReasons(reasons);

  let status = current.status;
  if (status === 'published' || status === 'pending_review') {
    const publishable = isAutoPublishable({ ...incoming, ...merged, reviewReasons });
    status = publishable ? 'published' : 'pending_review';
  }
  return { patch, reviewReasons, status, lockedConflicts };
}
