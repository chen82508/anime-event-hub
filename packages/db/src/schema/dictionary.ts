import type { TaiwanCity } from '@aeh/core';
import { sql } from 'drizzle-orm';
import { index, integer, pgTable, serial, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, textArray, updatedAt } from './_helpers';
import { eventTypeEnum, regionEnum, tagKindEnum } from './enums';

/** 縣市字典（regions.yaml）。地區對照以 @aeh/core CITY_REGION 為準（D3）。 */
export const city = pgTable('city', {
  name: text('name').$type<TaiwanCity>().primaryKey(),
  region: regionEnum('region').notNull(),
  aliases: textArray('aliases'),
});

/** 場館字典（venues.yaml ＋ 後台新增） */
export const venue = pgTable(
  'venue',
  {
    id: serial('id').primaryKey(),
    /** 穩定識別碼，seed 以此 upsert；後台新增時亦需給定 */
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    aliases: textArray('aliases'),
    city: text('city')
      .$type<TaiwanCity>()
      .notNull()
      .references(() => city.name, { onUpdate: 'cascade' }),
    /** 冗餘自 city，方便篩選；寫入時須與 city 一致 */
    region: regionEnum('region').notNull(),
    address: text('address'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('venue_aliases_gin_idx').using('gin', t.aliases),
    index('venue_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
  ],
);

/** 作品／代理商／聲優／歌手標籤（tags-*.yaml ＋ 後台新增）。未命中者不自動建立（C5）。 */
export const tag = pgTable(
  'tag',
  {
    id: serial('id').primaryKey(),
    kind: tagKindEnum('kind').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    aliases: textArray('aliases'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('tag_kind_slug_uq').on(t.kind, t.slug),
    index('tag_aliases_gin_idx').using('gin', t.aliases),
  ],
);

/** 類型關鍵字字典（event-type-keywords.yaml） */
export const typeKeyword = pgTable(
  'type_keyword',
  {
    id: serial('id').primaryKey(),
    eventType: eventTypeEnum('event_type').notNull(),
    keyword: text('keyword').notNull(),
    /** 數字越大越優先 */
    priority: integer('priority').notNull().default(0),
  },
  (t) => [
    // 同一關鍵字（不分大小寫）只能對應一種類型
    uniqueIndex('type_keyword_keyword_uq').on(sql`lower(${t.keyword})`),
  ],
);
