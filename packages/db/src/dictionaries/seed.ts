import { CITY_REGION, type TagKind } from '@aeh/core';
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Database } from '../client';
import { city, source, tag, typeKeyword, venue } from '../schema';
import type { Dictionaries } from './load';

export interface SeedResult {
  cities: number;
  venues: number;
  tags: number;
  typeKeywords: number;
  sources: number;
}

/**
 * 既有別名 ＋ YAML 中尚未存在的別名（保留既有順序，新別名依 YAML 順序附加於後）。
 * 後台新增的別名（T10）不會因重新 seed 而遺失；重複執行不會改變結果。
 */
function mergeAliases(column: PgColumn): SQL {
  return sql`${column} || array(
    select a from unnest(excluded.aliases) with ordinality as x(a, i)
    where a <> all(${column}) order by i)`;
}

/**
 * 將字典 upsert 進 DB（單一 transaction，可重複執行）。
 *
 * 語意：
 * - 以 slug / name / id 為 key upsert；名稱、城市、地址等以 YAML 為準
 * - 別名取聯集，保留後台新增者
 * - **不刪除** YAML 中已不存在的列（可能是後台新增或已被活動引用）
 * - source.enabled 只在首次建立時套用，之後由營運者控制
 */
export async function seedDictionaries(db: Database, dicts: Dictionaries): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    // ── city ──
    const cityRows = Object.values(dicts.regions)
      .flat()
      .map((c) => ({ name: c.name, region: CITY_REGION[c.name], aliases: c.aliases }));
    await tx
      .insert(city)
      .values(cityRows)
      .onConflictDoUpdate({
        target: city.name,
        set: { region: sql`excluded.region`, aliases: mergeAliases(city.aliases) },
      });

    // ── venue ──
    const venueRows = dicts.venues.map((v) => ({
      slug: v.slug,
      name: v.name,
      aliases: v.aliases,
      city: v.city,
      region: CITY_REGION[v.city],
      address: v.address ?? null,
    }));
    if (venueRows.length > 0) {
      await tx
        .insert(venue)
        .values(venueRows)
        .onConflictDoUpdate({
          target: venue.slug,
          set: {
            name: sql`excluded.name`,
            city: sql`excluded.city`,
            region: sql`excluded.region`,
            address: sql`coalesce(excluded.address, ${venue.address})`,
            aliases: mergeAliases(venue.aliases),
            updatedAt: sql`now()`,
          },
        });
    }

    // ── tag ──
    const tagRows = Object.entries(dicts.tags).flatMap(([kind, entries]) =>
      entries.map((t) => ({
        kind: kind as TagKind,
        slug: t.slug,
        name: t.name,
        aliases: t.aliases,
      })),
    );
    if (tagRows.length > 0) {
      await tx
        .insert(tag)
        .values(tagRows)
        .onConflictDoUpdate({
          target: [tag.kind, tag.slug],
          set: {
            name: sql`excluded.name`,
            aliases: mergeAliases(tag.aliases),
            updatedAt: sql`now()`,
          },
        });
    }

    // ── type_keyword ──（唯一鍵為 lower(keyword)；關鍵字改歸屬類型時也會更新）
    const kwRows = dicts.typeKeywords.flatMap((g) =>
      g.keywords.map((keyword) => ({ eventType: g.type, keyword, priority: g.priority })),
    );
    if (kwRows.length > 0) {
      // drizzle 的 onConflict target 不支援運算式索引，這裡改用原生 SQL
      const values = sql.join(
        kwRows.map((r) => sql`(${r.eventType}::event_type, ${r.keyword}, ${r.priority})`),
        sql`, `,
      );
      await tx.execute(sql`
        insert into ${typeKeyword} (event_type, keyword, priority)
        values ${values}
        on conflict (lower(keyword)) do update
          set event_type = excluded.event_type,
              keyword = excluded.keyword,
              priority = excluded.priority`);
    }

    // ── source ──
    const sourceRows = dicts.sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      baseUrl: s.base_url,
      schedule: s.schedule,
      enabled: s.enabled,
    }));
    if (sourceRows.length > 0) {
      await tx
        .insert(source)
        .values(sourceRows)
        .onConflictDoUpdate({
          target: source.id,
          set: {
            name: sql`excluded.name`,
            kind: sql`excluded.kind`,
            baseUrl: sql`excluded.base_url`,
            schedule: sql`excluded.schedule`,
            updatedAt: sql`now()`,
          },
        });
    }

    return {
      cities: cityRows.length,
      venues: venueRows.length,
      tags: tagRows.length,
      typeKeywords: kwRows.length,
      sources: sourceRows.length,
    };
  });
}
