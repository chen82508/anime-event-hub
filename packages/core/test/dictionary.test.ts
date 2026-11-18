import { describe, expect, it } from 'vitest';
import {
  CITY_REGION,
  RegionsDictSchema,
  SourcesDictSchema,
  TagsDictSchema,
  TypeKeywordsDictSchema,
  VenuesDictSchema,
  type Region,
  type TaiwanCity,
} from '../src';

function messages(r: { success: boolean; error?: { issues: { message: string }[] } }): string {
  return (r.error?.issues ?? []).map((i) => i.message).join('\n');
}

function fullRegions() {
  const dict: Record<Exclude<Region, 'online'>, { name: TaiwanCity; aliases: string[] }[]> = {
    north: [],
    central: [],
    south: [],
    east: [],
    islands: [],
  };
  for (const [city, region] of Object.entries(CITY_REGION) as [
    TaiwanCity,
    Exclude<Region, 'online'>,
  ][]) {
    dict[region].push({ name: city, aliases: [] });
  }
  return dict;
}

describe('RegionsDictSchema', () => {
  it('接受完整且符合 D3 的對照', () => {
    expect(RegionsDictSchema.safeParse(fullRegions()).success).toBe(true);
  });

  it('縣市放錯地區 → 錯誤', () => {
    const d = fullRegions();
    d.north = d.north.filter((c) => c.name !== '宜蘭縣');
    d.east.push({ name: '宜蘭縣', aliases: [] });
    const r = RegionsDictSchema.safeParse(d);
    expect(r.success).toBe(false);
    expect(messages(r)).toContain('宜蘭縣 應屬 north');
  });

  it('缺縣市 → 錯誤', () => {
    const d = fullRegions();
    d.islands = d.islands.filter((c) => c.name !== '連江縣');
    expect(messages(RegionsDictSchema.safeParse(d))).toContain('缺少縣市：連江縣');
  });

  it('縣市重複 → 錯誤', () => {
    const d = fullRegions();
    d.north.push({ name: '台北市', aliases: [] });
    expect(messages(RegionsDictSchema.safeParse(d))).toContain('台北市 重複');
  });

  it('非正規縣市名（臺北市）→ 錯誤', () => {
    const d = fullRegions();
    d.north.push({ name: '臺北市' as TaiwanCity, aliases: [] });
    expect(RegionsDictSchema.safeParse(d).success).toBe(false);
  });
});

describe('VenuesDictSchema', () => {
  const v = (slug: string, name: string, aliases: string[] = []) => ({
    slug,
    name,
    aliases,
    city: '台北市',
  });

  it('aliases 預設為空陣列', () => {
    const r = VenuesDictSchema.parse([{ slug: 'a', name: 'A', city: '台北市' }]);
    expect(r[0]?.aliases).toEqual([]);
  });

  it('slug 重複 → 錯誤', () => {
    expect(messages(VenuesDictSchema.safeParse([v('a', 'A'), v('a', 'B')]))).toContain(
      'slug「a」重複',
    );
  });

  it('別名指向兩個場館 → 錯誤（不分大小寫）', () => {
    const r = VenuesDictSchema.safeParse([v('a', 'A', ['TaiNEX']), v('b', 'B', ['tainex'])]);
    expect(messages(r)).toContain('同時屬於 a 與 b');
  });

  it.each([
    ['slug 格式錯誤', { slug: 'Bad Slug', name: 'X', city: '台北市' }],
    ['未知縣市', { slug: 'x', name: 'X', city: '東京都' }],
    ['未知欄位', { slug: 'x', name: 'X', city: '台北市', region: 'north' }],
    ['空名稱', { slug: 'x', name: ' ', city: '台北市' }],
  ])('拒絕：%s', (_l, entry) => {
    expect(VenuesDictSchema.safeParse([entry]).success).toBe(false);
  });
});

describe('TypeKeywordsDictSchema', () => {
  it('同一關鍵字跨類型 → 錯誤', () => {
    const r = TypeKeywordsDictSchema.safeParse([
      { type: 'popup_cafe', priority: 20, keywords: ['POP UP'] },
      { type: 'exhibition', priority: 10, keywords: ['pop up'] },
    ]);
    expect(messages(r)).toContain('同時屬於 popup_cafe 與 exhibition');
  });

  it('同類型內不分大小寫重複 → 錯誤', () => {
    const r = TypeKeywordsDictSchema.safeParse([
      { type: 'doujin', priority: 1, keywords: ['Only場', 'ONLY場'] },
    ]);
    expect(messages(r)).toContain('在 doujin 中重複');
  });

  it('不允許把關鍵字對應到 other', () => {
    expect(
      TypeKeywordsDictSchema.safeParse([{ type: 'other', priority: 1, keywords: ['x'] }]).success,
    ).toBe(false);
  });

  it('類型重複 → 錯誤', () => {
    const r = TypeKeywordsDictSchema.safeParse([
      { type: 'concert', priority: 1, keywords: ['a'] },
      { type: 'concert', priority: 2, keywords: ['b'] },
    ]);
    expect(messages(r)).toContain('type「concert」重複');
  });
});

describe('TagsDictSchema', () => {
  it('同一 kind 內別名衝突 → 錯誤', () => {
    const r = TagsDictSchema.safeParse({
      kind: 'work',
      tags: [
        { slug: 'a', name: '甲', aliases: ['共用'] },
        { slug: 'b', name: '共用' },
      ],
    });
    expect(messages(r)).toContain('同時屬於 a 與 b');
  });

  it('未知 kind → 錯誤', () => {
    expect(TagsDictSchema.safeParse({ kind: 'character', tags: [] }).success).toBe(false);
  });
});

describe('SourcesDictSchema', () => {
  const s = {
    id: 'kktix',
    name: 'KKTIX',
    kind: 'ticketing',
    base_url: 'https://kktix.com',
    schedule: 'daily',
    enabled: true,
  };
  it('接受 base_url 為 null（待 PoC 確認）', () => {
    expect(SourcesDictSchema.safeParse([{ ...s, base_url: null }]).success).toBe(true);
  });
  it('id 重複 → 錯誤', () => {
    expect(messages(SourcesDictSchema.safeParse([s, s]))).toContain('id「kktix」重複');
  });
  it('暫緩來源不可登記', () => {
    expect(SourcesDictSchema.safeParse([{ ...s, id: 'tixcraft' }]).success).toBe(false);
  });
});
