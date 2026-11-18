// 測試用：直接讀取 repo 的字典 YAML 並以 core schema 驗證（src 為純函式，不讀檔）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TagsDictSchema, TypeKeywordsDictSchema } from '@aeh/core';
import { parse } from 'yaml';
import type { TagRecord } from '../src';

const DIR = fileURLToPath(new URL('../../../data/dictionaries/', import.meta.url));
const load = (file: string): unknown => parse(readFileSync(DIR + file, 'utf8'));

export const typeKeywords = TypeKeywordsDictSchema.parse(load('event-type-keywords.yaml'));
export const tags: TagRecord[] = [
  'tags-agency.yaml',
  'tags-works.yaml',
  'tags-voice-actors.yaml',
  'tags-artists.yaml',
].flatMap((f) => {
  const d = TagsDictSchema.parse(load(f));
  return d.tags.map((t) => ({ kind: d.kind, ...t }));
});
