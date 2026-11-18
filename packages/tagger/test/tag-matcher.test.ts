import { describe, expect, it } from 'vitest';
import { TagMatcher, Tagger, type TagRecord } from '../src';
import { tags, typeKeywords } from './dictionaries';

const matcher = new TagMatcher(tags);
const slugs = (texts: string[], sourceId?: Parameters<typeof matcher.match>[0]['sourceId']) =>
  matcher.match({ texts, sourceId }).map((h) => `${h.tag.kind}:${h.tag.slug}`);

describe('TagMatcher（data/dictionaries/tags-*.yaml）', () => {
  it.each([
    ['孤獨搖滾！POP UP STORE', ['work:bocchi-the-rock']],
    ['ぼっち・ざ・ろっく！ コラボカフェ', ['work:bocchi-the-rock']],
    ['Bocchi the Rock! Exhibition', ['work:bocchi-the-rock']],
    ['【推しの子】展', ['work:oshi-no-ko']],
    ['SPY×FAMILY 間諜家家酒 特展', ['work:spy-family']],
    ['鬼滅之刃 全集中展', ['work:kimetsu-no-yaiba']],
    ['鬼滅の刃 柱展', ['work:kimetsu-no-yaiba']],
    ['葬送のフリーレン 原畫展', ['work:frieren']],
  ])('%s', (title, expected) => {
    expect(slugs([title])).toEqual(expected);
  });

  it('最長匹配：「鬼滅之刃」只算一次，不會再命中「鬼滅」', () => {
    const hits = matcher.match({ texts: ['鬼滅之刃 快閃店'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchedBy).toBe('name:鬼滅之刃');
  });

  it('白名單短別名可不需邊界：鬼滅快閃店 → 鬼滅之刃', () => {
    expect(slugs(['鬼滅快閃店'])).toEqual(['work:kimetsu-no-yaiba']);
  });

  it('非白名單短別名需邊界：「尖端科技展」不會標成尖端出版', () => {
    expect(slugs(['尖端科技展'])).toEqual([]);
    expect(slugs(['尖端 簽名會'])).toEqual(['agency:sharp-point']);
  });

  it('拉丁字母別名需整詞邊界：EVA', () => {
    expect(slugs(['EVA 展'])).toContain('work:evangelion');
    expect(slugs(['EVA展'])).toContain('work:evangelion');
    expect(slugs(['Evaluation Day'])).toEqual([]);
    expect(slugs(['Ado LIVE'])).toEqual(['artist:ado']);
    expect(slugs(['Adore Festival'])).toEqual([]);
  });

  it('多種標籤同時命中，輸出依 種類 → slug 排序', () => {
    expect(slugs(['木棉花 × 孤獨搖滾！ 見面會 青山吉能'])).toEqual(
      expect.arrayContaining(['agency:muse', 'work:bocchi-the-rock']),
    );
    const out = slugs(['木棉花 × 孤獨搖滾！']);
    expect(out[0]).toBe('agency:muse');
  });

  it('來源推論：木棉花官網 → 代理商「木棉花」（origin = source）', () => {
    const hits = matcher.match({ texts: ['某某作品 快閃店'], sourceId: 'muse' });
    expect(hits).toEqual([
      expect.objectContaining({
        origin: 'source',
        matchedBy: 'source:muse',
        tag: expect.objectContaining({ slug: 'muse' }),
      }),
    ]);
    expect(slugs(['某某作品'], 'mightymedia')).toEqual(['agency:mighty-media']);
  });

  it('來源推論與字典同時命中時保留來源推論', () => {
    const hits = matcher.match({ texts: ['木棉花 主辦'], sourceId: 'muse' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.origin).toBe('source');
  });

  it('字典沒有就不標（不自動建立標籤）', () => {
    expect(slugs(['完全不在字典裡的作品 快閃店'])).toEqual([]);
  });

  it('多段文字分開比對，不會跨段命中', () => {
    const m = new TagMatcher([{ kind: 'work', slug: 'ab', name: '甲乙丙', aliases: [] }]);
    expect(m.match({ texts: ['甲乙', '丙'] })).toEqual([]);
    expect(m.match({ texts: ['甲乙丙'] })).toHaveLength(1);
  });

  it('同名不同種類的條目都會標上', () => {
    const m = new TagMatcher<TagRecord>([
      { kind: 'work', slug: 'x-work', name: 'Starlight', aliases: [] },
      { kind: 'artist', slug: 'x-artist', name: 'STARLIGHT', aliases: [] },
    ]);
    expect(m.match({ texts: ['starlight live'] }).map((h) => h.tag.slug)).toEqual([
      'x-work',
      'x-artist',
    ]);
  });

  it('記錄需要邊界的短別名，方便字典維護', () => {
    expect(matcher.boundaryPatterns.has('eva')).toBe(true);
    expect(matcher.boundaryPatterns.has('尖端')).toBe(true);
    expect(matcher.boundaryPatterns.has('鬼滅')).toBe(false);
  });
});

describe('Tagger（類型 ＋ 標籤）', () => {
  const tagger = new Tagger({ typeKeywords, tags });

  it('一次回傳類型、標籤與審核原因', () => {
    const r = tagger.tag({ title: '【推しの子】POP UP STORE in 台北', sourceId: 'kktix' });
    expect(r.type.type).toBe('popup_cafe');
    expect(r.tags.map((t) => t.tag.slug)).toEqual(['oshi-no-ko']);
    expect(r.reviewReasons).toEqual([]);
  });

  it('類型無法判定 → type_unresolved', () => {
    const r = tagger.tag({ title: '某某作品 15 週年', sourceId: 'kktix' });
    expect(r.reviewReasons).toEqual(['type_unresolved']);
  });

  it('extraTexts 也參與標籤比對', () => {
    const r = tagger.tag({ title: 'XX 見面會', extraTexts: ['出演：Ado'] });
    expect(r.tags.map((t) => t.tag.slug)).toEqual(['ado']);
  });
});
