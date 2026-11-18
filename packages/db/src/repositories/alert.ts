import { eq, sql } from 'drizzle-orm';
import { alertState } from '../schema';
import type { Database } from '../client';

/**
 * 告警節流：同一 key 距上次送出未滿 throttleMs → 不送，累計壓下次數。
 * 回傳 { send, suppressed }：send 為 true 時，suppressed 是上次送出後被壓下的次數（附在訊息中）。
 */
export async function claimAlertSlot(
  db: Database,
  key: string,
  throttleMs: number,
  now: Date = new Date(),
): Promise<{ send: boolean; suppressed: number }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(alertState).where(eq(alertState.key, key)).for('update');
    if (!row) {
      await tx
        .insert(alertState)
        .values({ key, lastSentAt: now, suppressed: 0 })
        .onConflictDoNothing();
      return { send: true, suppressed: 0 };
    }
    if (now.getTime() - row.lastSentAt.getTime() < throttleMs) {
      await tx
        .update(alertState)
        .set({ suppressed: sql`${alertState.suppressed} + 1` })
        .where(eq(alertState.key, key));
      return { send: false, suppressed: row.suppressed + 1 };
    }
    await tx
      .update(alertState)
      .set({ lastSentAt: now, suppressed: 0 })
      .where(eq(alertState.key, key));
    return { send: true, suppressed: row.suppressed };
  });
}

/** 狀態恢復（如來源重新有資料）時清除，下次異常可立即告警 */
export async function resetAlertSlot(db: Database, key: string): Promise<void> {
  await db.delete(alertState).where(eq(alertState.key, key));
}
