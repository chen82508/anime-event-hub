import {
  CITY_REGION,
  type EventType,
  type TagKind,
  type TaiwanCity,
  type TypeKeywordGroup,
} from '@aeh/core';
import { asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { writeAudit } from './audit';
import { city, tag, typeKeyword, venue } from '../schema';
import type { DbOrTx } from './types';

/** 比對用字典（含後台新增的別名）；形狀與 @aeh/normalize、@aeh/tagger 的輸入相容 */
export interface MatchingDictionaries {
  venues: { id: number; slug: string; name: string; aliases: string[]; city: TaiwanCity }[];
  cities: { name: TaiwanCity; aliases: string[] }[];
  tags: { id: number; kind: TagKind; slug: string; name: string; aliases: string[] }[];
  typeKeywords: TypeKeywordGroup[];
}

export async function loadMatchingDictionaries(db: DbOrTx): Promise<MatchingDictionaries> {
  const [venues, cities, tags, keywords] = await Promise.all([
    db
      .select({
        id: venue.id,
        slug: venue.slug,
        name: venue.name,
        aliases: venue.aliases,
        city: venue.city,
      })
      .from(venue)
      .orderBy(asc(venue.id)),
    db.select({ name: city.name, aliases: city.aliases }).from(city).orderBy(asc(city.name)),
    db
      .select({ id: tag.id, kind: tag.kind, slug: tag.slug, name: tag.name, aliases: tag.aliases })
      .from(tag)
      .orderBy(asc(tag.id)),
    db.select().from(typeKeyword).orderBy(asc(typeKeyword.id)),
  ]);
  const groups = new Map<EventType, TypeKeywordGroup>();
  for (const k of keywords) {
    if (k.eventType === 'other') continue;
    const g = groups.get(k.eventType) ?? { type: k.eventType, priority: k.priority, keywords: [] };
    g.priority = Math.max(g.priority, k.priority);
    g.keywords.push(k.keyword);
    groups.set(k.eventType, g);
  }
  return { venues, cities, tags, typeKeywords: [...groups.values()] };
}

// ── 後台字典快捷操作（T10）──────────────────────────────

export async function listVenues(db: DbOrTx) {
  return db.select().from(venue).orderBy(asc(venue.city), asc(venue.name));
}

export async function listTags(db: DbOrTx) {
  return db.select().from(tag).orderBy(asc(tag.kind), asc(tag.name));
}

/** 追加別名（已存在則不變）；寫 audit_log */
export async function addAlias(
  db: Database,
  input: { entity: 'tag' | 'venue'; id: number; alias: string; actor: string },
): Promise<void> {
  const alias = input.alias.trim();
  if (!alias) throw new Error('別名不可為空');
  const table = input.entity === 'tag' ? tag : venue;
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(table)
      .set({
        aliases: sql`case when ${alias} = any(${table.aliases}) then ${table.aliases} else array_append(${table.aliases}, ${alias}) end`,
      })
      .where(eq(table.id, input.id))
      .returning({ id: table.id });
    if (rows.length === 0) throw new Error(`${input.entity} 不存在：${input.id}`);
    await writeAudit(tx, {
      actor: input.actor,
      action: `${input.entity}.add_alias`,
      entity: input.entity,
      entityId: input.id,
      diff: { alias },
    });
  });
}

/** 新增場館（地區由縣市推得，D3） */
export async function createVenue(
  db: Database,
  input: {
    slug: string;
    name: string;
    city: TaiwanCity;
    address?: string | null;
    aliases?: string[];
    actor: string;
  },
): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(venue)
      .values({
        slug: input.slug,
        name: input.name,
        city: input.city,
        region: CITY_REGION[input.city],
        address: input.address ?? null,
        aliases: input.aliases ?? [],
      })
      .returning({ id: venue.id });
    await writeAudit(tx, {
      actor: input.actor,
      action: 'venue.create',
      entity: 'venue',
      entityId: row!.id,
      diff: { slug: input.slug, name: input.name, city: input.city },
    });
    return row!.id;
  });
}
