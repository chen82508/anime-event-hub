/**
 * 去重鍵（tech-spec T8）：正規化標題（去空白）＋ 開始日期（台灣日曆日）＋ 場館。
 * 完全相同 → 視為同一活動，自動合併。缺開始日或場館（且非線上）時沒有鍵，不自動合併。
 */
import { taipeiDateString } from '@aeh/normalize';

export interface DedupKeyInput {
  titleNormalized: string;
  startAt: Date | null;
  venueId: number | null;
  isOnline: boolean;
}

export function dedupKey(e: DedupKeyInput): string | null {
  if (e.startAt === null) return null;
  const place = e.venueId !== null ? `v${e.venueId}` : e.isOnline ? 'online' : null;
  if (place === null) return null;
  const title = e.titleNormalized.replaceAll(' ', '');
  if (title.length === 0) return null;
  return `${title}|${taipeiDateString(e.startAt)}|${place}`;
}
