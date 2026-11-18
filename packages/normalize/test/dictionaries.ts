// 測試用：直接讀取 repo 的字典 YAML 並以 core schema 驗證（src 為純函式，不讀檔）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RegionsDictSchema, VenuesDictSchema } from '@aeh/core';
import { parse } from 'yaml';

const DIR = fileURLToPath(new URL('../../../data/dictionaries/', import.meta.url));
const load = (file: string): unknown => parse(readFileSync(DIR + file, 'utf8'));

export const regionsDict = RegionsDictSchema.parse(load('regions.yaml'));
export const venuesDict = VenuesDictSchema.parse(load('venues.yaml'));
