import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TAIWAN_CITIES } from '@aeh/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DICTIONARY_DIR, DictionaryError, loadDictionaries } from '../src';

describe('data/dictionaries（實際字典檔）', async () => {
  const dicts = await loadDictionaries(DEFAULT_DICTIONARY_DIR);

  it('通過全部驗證', () => {
    expect(dicts.venues.length).toBeGreaterThanOrEqual(30);
    expect(Object.values(dicts.regions).flat()).toHaveLength(TAIWAN_CITIES.length);
  });

  // T3 DoD：主要場館皆有條目
  it.each([
    '台北世貿一館',
    '南港展覽館1館',
    '南港展覽館2館',
    '花博爭艷館',
    '台中國際展覽館',
    '高雄展覽館',
    'Legacy Taipei',
    'Zepp New Taipei',
  ])('包含主要場館：%s', (name) => {
    const hit = dicts.venues.find((v) => v.name === name || v.aliases.includes(name));
    expect(hit, `${name} 未出現在 venues.yaml`).toBeDefined();
  });

  it('每種標籤都有資料', () => {
    for (const [kind, tags] of Object.entries(dicts.tags)) {
      expect(tags.length, kind).toBeGreaterThan(0);
    }
  });

  it('所有 6 種非 other 類型都有關鍵字', () => {
    expect(dicts.typeKeywords.map((g) => g.type).sort()).toEqual([
      'concert',
      'doujin',
      'exhibition',
      'expo',
      'fan_meeting',
      'popup_cafe',
    ]);
  });

  it('PoC 三個來源（D6）預設啟用，其餘關閉', () => {
    const enabled = dicts.sources
      .filter((s) => s.enabled)
      .map((s) => s.id)
      .sort();
    expect(enabled).toEqual(['cwt', 'kktix', 'muse']);
  });

  it('作品別名可對應日文原名（企劃 §3 範例）', () => {
    const bocchi = dicts.tags.work.find((t) => t.slug === 'bocchi-the-rock');
    expect(bocchi?.aliases).toContain('ぼっち・ざ・ろっく！');
    expect(bocchi?.aliases).toContain('孤獨搖滾');
  });
});

describe('loadDictionaries 錯誤處理', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function copyWith(file: string, content: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'aeh-dict-'));
    await cp(DEFAULT_DICTIONARY_DIR, dir, { recursive: true });
    await writeFile(join(dir, file), content);
    return dir;
  }

  it('YAML 語法錯誤 → DictionaryError 並指出檔名', async () => {
    const d = await copyWith('venues.yaml', '- slug: a\n  name: [unclosed\n');
    await expect(loadDictionaries(d)).rejects.toThrow(/venues\.yaml YAML 語法錯誤/);
  });

  it('YAML 重複 key → 錯誤', async () => {
    const d = await copyWith('tags-agency.yaml', 'kind: agency\nkind: work\ntags: []\n');
    await expect(loadDictionaries(d)).rejects.toBeInstanceOf(DictionaryError);
  });

  it('schema 驗證失敗 → 錯誤訊息包含原因', async () => {
    const d = await copyWith(
      'venues.yaml',
      '- { slug: a, name: A, city: 台北市 }\n- { slug: a, name: B, city: 台北市 }\n',
    );
    await expect(loadDictionaries(d)).rejects.toThrow(/venues\.yaml 驗證失敗[\s\S]*slug「a」重複/);
  });

  it('兩個 tags 檔使用相同 kind → 錯誤', async () => {
    const d = await copyWith('tags-artists.yaml', 'kind: work\ntags: []\n');
    await expect(loadDictionaries(d)).rejects.toThrow(/kind 皆為 work/);
  });

  it('缺檔 → 錯誤', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aeh-dict-'));
    await expect(loadDictionaries(dir)).rejects.toThrow(/無法讀取字典/);
  });
});
