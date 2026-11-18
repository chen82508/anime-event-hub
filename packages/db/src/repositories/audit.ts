import { and, desc, eq } from 'drizzle-orm';
import { auditLog } from '../schema';
import type { DbOrTx } from './types';

export interface AuditEntry {
  actor: string;
  /** 例：event.update / event.publish / event.merge / pipeline.merge */
  action: string;
  entity: string;
  entityId: string | number;
  diff?: unknown;
}

export async function writeAudit(db: DbOrTx, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actor: e.actor,
    action: e.action,
    entity: e.entity,
    entityId: String(e.entityId),
    diff: e.diff ?? null,
  });
}

export async function listAudit(db: DbOrTx, entity: string, entityId: string | number, limit = 20) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, String(entityId))))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit);
}
