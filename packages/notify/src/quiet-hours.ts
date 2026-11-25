/**
 * 勿擾時段（台灣時間）：站外推播延到時段結束再送；站內通知匣不受影響。
 * 例：擷取排程在凌晨 4 點跑完，新活動推播會延到早上 8 點。
 */
export interface QuietHours {
  /** 開始（含），0–23 */
  start: number;
  /** 結束（不含），0–23 */
  end: number;
}

/** "23-8" → { start: 23, end: 8 }；空字串 → null（不設勿擾）；格式錯誤拋錯 */
export function parseQuietHours(spec: string | undefined): QuietHours | null {
  const s = spec?.trim();
  if (!s) return null;
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(s);
  if (!m) throw new Error(`勿擾時段格式應為「起-迄」小時，如 23-8：${spec}`);
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 23) throw new Error(`勿擾時段小時須介於 0–23：${spec}`);
  if (start === end) return null;
  return { start, end };
}

const HOUR = 3_600_000;
const TAIPEI_OFFSET = 8 * HOUR;

function taipeiHour(at: Date): number {
  return new Date(at.getTime() + TAIPEI_OFFSET).getUTCHours();
}

export function isQuietHour(at: Date, qh: QuietHours | null): boolean {
  if (!qh) return false;
  const h = taipeiHour(at);
  return qh.start < qh.end ? h >= qh.start && h < qh.end : h >= qh.start || h < qh.end;
}

/** 最早可推播的時間：不在勿擾時段 → now；否則 → 下一個 end:00（台灣時間） */
export function nextDeliveryTime(now: Date, qh: QuietHours | null): Date {
  if (!qh || !isQuietHour(now, qh)) return now;
  const local = new Date(now.getTime() + TAIPEI_OFFSET);
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), qh.end);
  const next = target > local.getTime() ? target : target + 24 * HOUR;
  return new Date(next - TAIPEI_OFFSET);
}
