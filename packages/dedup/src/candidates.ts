/**
 * 去重判定（tech-spec T8、R6）：寧可漏合併（進待審），不要誤合併。
 *
 * - 去重鍵完全相同 → merge（自動合併，新增 event_source）
 * - 開始日期相差 ≤ dateWindowDays、場館不衝突、標題 trigram 相似度 ≥ possibleMin → possible（標 possible_duplicate 待審）
 * - 其它 → new
 *
 * 「場館不衝突」：兩邊都有場館時必須相同（巡迴快閃不同城市 → 不同活動）；任一邊沒有場館時不排除。
 */
import { dedupKey, type DedupKeyInput } from './key';

export interface DedupThresholds {
  /** 灰色區間下限（pg_trgm similarity），預設 0.45；PoC 後校正（R15） */
  possibleMin: number;
  /** 開始日期容許差距（天），預設 1 */
  dateWindowDays: number;
}

export const DEFAULT_DEDUP_THRESHOLDS: DedupThresholds = { possibleMin: 0.45, dateWindowDays: 1 };

export interface DedupCandidate extends DedupKeyInput {
  eventId: number;
  /** DB 端 pg_trgm similarity(title_normalized, 輸入標題) */
  similarity: number;
}

export type DedupDecision =
  | { kind: 'merge'; eventId: number; rule: 'exact_key'; key: string }
  | { kind: 'possible'; eventIds: number[]; best: { eventId: number; similarity: number } }
  | { kind: 'new' };

const DAY_MS = 86_400_000;

export function decideDuplicate(
  incoming: DedupKeyInput,
  candidates: readonly DedupCandidate[],
  thresholds: DedupThresholds = DEFAULT_DEDUP_THRESHOLDS,
): DedupDecision {
  const key = dedupKey(incoming);
  if (key !== null) {
    // 多筆同鍵時取 id 最小者（最早建立），結果穩定
    const exact = candidates
      .filter((c) => dedupKey(c) === key)
      .sort((a, b) => a.eventId - b.eventId)[0];
    if (exact) return { kind: 'merge', eventId: exact.eventId, rule: 'exact_key', key };
  }
  if (incoming.startAt === null) return { kind: 'new' };

  const possible = candidates
    .filter((c) => {
      if (c.startAt === null) return false;
      if (
        Math.abs(c.startAt.getTime() - incoming.startAt!.getTime()) >
        thresholds.dateWindowDays * DAY_MS
      )
        return false;
      if (c.venueId !== null && incoming.venueId !== null && c.venueId !== incoming.venueId)
        return false;
      return c.similarity >= thresholds.possibleMin;
    })
    .sort((a, b) => b.similarity - a.similarity || a.eventId - b.eventId);
  const best = possible[0];
  if (!best) return { kind: 'new' };
  return {
    kind: 'possible',
    eventIds: possible.map((c) => c.eventId),
    best: { eventId: best.eventId, similarity: best.similarity },
  };
}
