import { bigint, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { tstz } from './_helpers';

/** 人工操作追蹤（T10：每次後台操作皆寫入） */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    actor: text('actor').notNull(),
    /** 例：event.publish / event.update / tag.add_alias / event.merge */
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    /** { before, after } 或變更欄位 */
    diff: jsonb('diff'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_entity_idx').on(t.entity, t.entityId, t.at)],
);

/**
 * 告警節流狀態（T9）：同一告警鍵在節流期間內不重送。
 * 存 DB 是因為 CLI 與排程是不同 process，記憶體內的狀態無法共用。
 */
export const alertState = pgTable('alert_state', {
  key: text('key').primaryKey(),
  lastSentAt: tstz('last_sent_at').notNull(),
  /** 節流期間內被壓下的次數（下次送出時附註） */
  suppressed: integer('suppressed').notNull().default(0),
});
