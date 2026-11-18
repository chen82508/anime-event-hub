// 測試用：以 repo 字典建立 normalize 所需的比對器（模擬 DB 載入後的 id）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RegionsDictSchema,
  TagsDictSchema,
  TypeKeywordsDictSchema,
  VenuesDictSchema,
} from '@aeh/core';
import { VenueResolver, cityEntriesFromRegionsDict } from '@aeh/normalize';
import { Tagger, type TagRecord } from '@aeh/tagger';
import { parse } from 'yaml';

const DIR = fileURLToPath(new URL('../../../data/dictionaries/', import.meta.url));
const load = (file: string): unknown => parse(readFileSync(DIR + file, 'utf8'));

export const venues = VenuesDictSchema.parse(load('venues.yaml')).map((v, i) => ({
  id: i + 1,
  ...v,
}));
const cities = cityEntriesFromRegionsDict(RegionsDictSchema.parse(load('regions.yaml')));
const tags: (TagRecord & { id: number })[] = [
  'tags-agency.yaml',
  'tags-works.yaml',
  'tags-voice-actors.yaml',
  'tags-artists.yaml',
]
  .flatMap((f) => {
    const d = TagsDictSchema.parse(load(f));
    return d.tags.map((t) => ({ kind: d.kind, ...t }));
  })
  .map((t, i) => ({ id: i + 1, ...t }));

export const venueResolver = new VenueResolver(venues, cities);
export const tagger = new Tagger({
  typeKeywords: TypeKeywordsDictSchema.parse(load('event-type-keywords.yaml')),
  tags,
});

export function fixture(dir: string, name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/${dir}/fixtures/${name}`, import.meta.url)),
    'utf8',
  );
}

export const venueSlug = (id: number | null) => venues.find((v) => v.id === id)?.slug ?? null;
