import { sql } from 'drizzle-orm';
import { text, timestamp } from 'drizzle-orm/pg-core';

/** 一律 timestamptz（UTC 儲存，tech-spec §5 / R1） */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => tstz('created_at').notNull().defaultNow();
export const updatedAt = () =>
  tstz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** text[] NOT NULL DEFAULT '{}' */
export const textArray = (name: string) =>
  text(name)
    .array()
    .notNull()
    .default(sql`'{}'::text[]`);
