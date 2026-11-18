import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RegionsDictSchema,
  SourcesDictSchema,
  TAG_KINDS,
  TagsDictSchema,
  TypeKeywordsDictSchema,
  VenuesDictSchema,
  type RegionsDict,
  type SourceEntry,
  type TagKind,
  type TagsDict,
  type TypeKeywordGroup,
  type VenueEntry,
} from '@aeh/core';
import { parse } from 'yaml';
import { z } from 'zod';

export interface Dictionaries {
  regions: RegionsDict;
  venues: VenueEntry[];
  typeKeywords: TypeKeywordGroup[];
  tags: Record<TagKind, TagsDict['tags']>;
  sources: SourceEntry[];
}

/** 字典檔名 → 驗證 schema。tags 檔案可有多個，以檔內 `kind` 區分。 */
export const DICTIONARY_FILES = {
  regions: 'regions.yaml',
  venues: 'venues.yaml',
  typeKeywords: 'event-type-keywords.yaml',
  sources: 'sources.yaml',
  tags: ['tags-agency.yaml', 'tags-works.yaml', 'tags-voice-actors.yaml', 'tags-artists.yaml'],
} as const;

export class DictionaryError extends Error {
  override name = 'DictionaryError';
}

async function readYaml<S extends z.ZodType>(
  dir: string,
  file: string,
  schema: S,
): Promise<z.output<S>> {
  const path = join(dir, file);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new DictionaryError(`無法讀取字典 ${file}：${(err as Error).message}`);
  }
  let data: unknown;
  try {
    // uniqueKeys：同一 mapping 出現重複 key 視為錯誤
    data = parse(raw, { uniqueKeys: true, prettyErrors: true });
  } catch (err) {
    throw new DictionaryError(`${file} YAML 語法錯誤：${(err as Error).message}`);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new DictionaryError(`${file} 驗證失敗：\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * 讀取並驗證 data/dictionaries 下所有字典。任何錯誤皆拋出 DictionaryError（seed 會因此中止）。
 * 純讀檔，不碰 DB。
 */
export async function loadDictionaries(dir: string): Promise<Dictionaries> {
  const [regions, venues, typeKeywords, sources, ...tagDicts] = await Promise.all([
    readYaml(dir, DICTIONARY_FILES.regions, RegionsDictSchema),
    readYaml(dir, DICTIONARY_FILES.venues, VenuesDictSchema),
    readYaml(dir, DICTIONARY_FILES.typeKeywords, TypeKeywordsDictSchema),
    readYaml(dir, DICTIONARY_FILES.sources, SourcesDictSchema),
    ...DICTIONARY_FILES.tags.map((f) => readYaml(dir, f, TagsDictSchema)),
  ]);

  const tags = Object.fromEntries(
    TAG_KINDS.map((k) => [k, [] as TagsDict['tags']]),
  ) as Dictionaries['tags'];
  const kindFile = new Map<TagKind, string>();
  tagDicts.forEach((d, i) => {
    const file = DICTIONARY_FILES.tags[i]!;
    const prev = kindFile.get(d.kind);
    if (prev)
      throw new DictionaryError(`${file} 與 ${prev} 的 kind 皆為 ${d.kind}，請合併為一個檔案`);
    kindFile.set(d.kind, file);
    tags[d.kind] = d.tags;
  });

  return { regions, venues, typeKeywords, tags, sources };
}
