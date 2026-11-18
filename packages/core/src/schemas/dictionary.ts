import { z } from 'zod';
import { CITY_REGION, type Region, type TaiwanCity, TAIWAN_CITIES } from '../enums';
import {
  CrawlScheduleSchema,
  EventTypeSchema,
  SourceIdSchema,
  SourceKindSchema,
  TaiwanCitySchema,
  TagKindSchema,
} from './common';

/**
 * data/dictionaries/*.yaml 的驗證 schema。seed 時驗證失敗即中止（T3 DoD）。
 * 欄位命名沿用 YAML 的 snake_case。
 */

const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug 須為小寫英數與連字號');
const NonEmpty = z.string().trim().min(1);
const Aliases = z.array(NonEmpty).default([]);

/** 檢查陣列中某個 key 不重複，回報重複者 */
function uniqueBy<T>(
  items: readonly T[],
  key: (t: T) => string,
  label: string,
  ctx: z.RefinementCtx,
) {
  const seen = new Map<string, number>();
  items.forEach((item, i) => {
    const k = key(item);
    const prev = seen.get(k);
    if (prev !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [i],
        message: `${label}「${k}」重複（與第 ${prev} 筆）`,
      });
    } else {
      seen.set(k, i);
    }
  });
}

/** 名稱與別名在同一字典內不可指向兩個不同條目（避免比對歧義） */
function uniqueNames<T extends { slug: string; name: string; aliases: string[] }>(
  items: readonly T[],
  label: string,
  ctx: z.RefinementCtx,
) {
  const owner = new Map<string, string>();
  items.forEach((item, i) => {
    for (const n of [item.name, ...item.aliases]) {
      const k = n.toLowerCase();
      const prev = owner.get(k);
      if (prev !== undefined && prev !== item.slug) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message: `${label}名稱/別名「${n}」同時屬於 ${prev} 與 ${item.slug}`,
        });
      }
      owner.set(k, item.slug);
    }
  });
}

// ── regions.yaml ─────────────────────────────────────────
const CityEntrySchema = z.object({ name: TaiwanCitySchema, aliases: Aliases }).strict();

export const RegionsDictSchema = z
  .object({
    north: z.array(CityEntrySchema),
    central: z.array(CityEntrySchema),
    south: z.array(CityEntrySchema),
    east: z.array(CityEntrySchema),
    islands: z.array(CityEntrySchema),
  })
  .strict()
  .superRefine((dict, ctx) => {
    const seen = new Set<TaiwanCity>();
    for (const [region, cities] of Object.entries(dict) as [
      Region,
      z.infer<typeof CityEntrySchema>[],
    ][]) {
      cities.forEach((c, i) => {
        if (CITY_REGION[c.name] !== region) {
          ctx.addIssue({
            code: 'custom',
            path: [region, i, 'name'],
            message: `${c.name} 應屬 ${CITY_REGION[c.name]}（D3），不是 ${region}`,
          });
        }
        if (seen.has(c.name)) {
          ctx.addIssue({ code: 'custom', path: [region, i, 'name'], message: `${c.name} 重複` });
        }
        seen.add(c.name);
      });
    }
    const missing = TAIWAN_CITIES.filter((c) => !seen.has(c));
    if (missing.length > 0) {
      ctx.addIssue({ code: 'custom', path: [], message: `缺少縣市：${missing.join('、')}` });
    }
  });
export type RegionsDict = z.infer<typeof RegionsDictSchema>;

// ── venues.yaml ──────────────────────────────────────────
export const VenueEntrySchema = z
  .object({
    slug: Slug,
    name: NonEmpty,
    aliases: Aliases,
    city: TaiwanCitySchema,
    address: NonEmpty.optional(),
  })
  .strict();
export type VenueEntry = z.infer<typeof VenueEntrySchema>;

export const VenuesDictSchema = z.array(VenueEntrySchema).superRefine((items, ctx) => {
  uniqueBy(items, (v) => v.slug, 'slug', ctx);
  uniqueNames(items, '場館', ctx);
});

// ── event-type-keywords.yaml ─────────────────────────────
export const TypeKeywordGroupSchema = z
  .object({
    type: EventTypeSchema.exclude(['other']),
    /** 數字越大越優先（同一標題命中多類型時） */
    priority: z.number().int().min(0).max(1000),
    keywords: z.array(NonEmpty).min(1),
  })
  .strict();
export type TypeKeywordGroup = z.infer<typeof TypeKeywordGroupSchema>;

export const TypeKeywordsDictSchema = z.array(TypeKeywordGroupSchema).superRefine((groups, ctx) => {
  uniqueBy(groups, (g) => g.type, 'type', ctx);
  const owner = new Map<string, string>();
  groups.forEach((g, i) => {
    for (const kw of g.keywords) {
      const k = kw.toLowerCase();
      const prev = owner.get(k);
      if (prev !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message:
            prev === g.type
              ? `關鍵字「${kw}」在 ${g.type} 中重複（不分大小寫）`
              : `關鍵字「${kw}」同時屬於 ${prev} 與 ${g.type}`,
        });
      }
      owner.set(k, g.type);
    }
  });
});

// ── tags-*.yaml ──────────────────────────────────────────
export const TagEntrySchema = z
  .object({
    slug: Slug,
    name: NonEmpty,
    aliases: Aliases,
  })
  .strict();
export type TagEntry = z.infer<typeof TagEntrySchema>;

export const TagsDictSchema = z
  .object({
    kind: TagKindSchema,
    tags: z.array(TagEntrySchema),
  })
  .strict()
  .superRefine((dict, ctx) => {
    uniqueBy(dict.tags, (t) => t.slug, 'slug', ctx);
    uniqueNames(dict.tags, '標籤', ctx);
  });
export type TagsDict = z.infer<typeof TagsDictSchema>;

// ── sources.yaml ─────────────────────────────────────────
export const SourceEntrySchema = z
  .object({
    id: SourceIdSchema,
    name: NonEmpty,
    kind: SourceKindSchema,
    /** 未經 PoC 確認者留空 */
    base_url: z.url({ protocol: /^https?$/ }).nullable(),
    schedule: CrawlScheduleSchema,
    /** 只在首次建立時套用；之後由營運者在 DB 切換 */
    enabled: z.boolean(),
  })
  .strict();
export type SourceEntry = z.infer<typeof SourceEntrySchema>;

export const SourcesDictSchema = z.array(SourceEntrySchema).superRefine((items, ctx) => {
  uniqueBy(items, (s) => s.id, 'id', ctx);
});
