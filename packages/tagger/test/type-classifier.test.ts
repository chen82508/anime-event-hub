import { describe, expect, it } from 'vitest';
import { TypeClassifier, describeTypeRule } from '../src';
import { typeKeywords } from './dictionaries';

const classifier = new TypeClassifier(typeKeywords);

describe('TypeClassifier：關鍵字字典（data/dictionaries/event-type-keywords.yaml）', () => {
  it.each([
    ['孤獨搖滾！ POP UP STORE in 台北', 'popup_cafe'],
    ['【推しの子】期間限定快閃店', 'popup_cafe'],
    ['葬送的芙莉蓮 主題咖啡廳', 'popup_cafe'],
    ['ぼっち・ざ・ろっく！ コラボカフェ', 'popup_cafe'],
    ['進擊的巨人 原畫展', 'exhibition'],
    ['鬼滅之刃 全集中展 巡迴展 台中站', 'exhibition'],
    ['EVANGELION Exhibition', 'exhibition'],
    ['LiSA LIVE TOUR 2026 in Taipei', 'concert'],
    ['YOASOBI ASIA TOUR Live in Taipei', 'concert'],
    ['某某交響音樂會', 'concert'],
    ['ラブライブ！ コンサート', 'concert'],
    ['某聲優 台北見面會', 'fan_meeting'],
    ['某聲優 Fan Meeting in Taipei', 'fan_meeting'],
    ['作者來台簽名會', 'fan_meeting'],
    ['台北國際動漫節', 'expo'],
    ['漫畫博覽會 2026', 'expo'],
    ['Fancy Frontier 開拓動漫祭 47', 'doujin'],
    ['某某 Only場', 'doujin'],
    ['某某 ONLY場', 'doujin'],
  ])('%s → %s', (title, type) => {
    const r = classifier.classify({ title });
    expect(r.type, describeTypeRule(r.rule)).toBe(type);
    expect(r.rule.kind).toBe('keyword');
    expect(r.reviewReasons).toEqual([]);
  });

  it('命中多類型時取 priority 高者：演唱會 + 見面會 → fan_meeting', () => {
    const r = classifier.classify({ title: '某某 演唱會＆見面會' });
    expect(r.type).toBe('fan_meeting');
    expect(r.keywordHits.map((h) => h.type)).toEqual(['concert', 'fan_meeting']);
  });

  it('最長匹配：主題咖啡廳 不會同時命中 主題咖啡', () => {
    expect(classifier.keywordHits('主題咖啡廳').map((h) => h.keyword)).toEqual(['主題咖啡廳']);
  });

  it('場館名稱中的「展覽館」不算展覽關鍵字', () => {
    const r = classifier.classify({ title: '某某作品 in 南港展覽館' });
    expect(r.type).toBeNull();
    expect(r.reviewReasons).toEqual(['type_unresolved']);
  });

  it('拉丁字母關鍵字需整詞邊界', () => {
    expect(classifier.classify({ title: 'Concerto Gate' }).type).toBeNull();
    expect(classifier.classify({ title: 'Exhibitionist' }).type).toBeNull();
  });

  it('沒有命中 → type_unresolved，不猜', () => {
    expect(classifier.classify({ title: '某某作品 15 週年紀念活動' })).toMatchObject({
      type: null,
      rule: { kind: 'none' },
      reviewReasons: ['type_unresolved'],
    });
  });
});

describe('TypeClassifier：判定順序（C5）', () => {
  it('擷取器提示優先於來源與關鍵字', () => {
    const r = classifier.classify({ title: 'XX 演唱會', sourceId: 'cwt', typeHint: 'fan_meeting' });
    expect(r).toMatchObject({ type: 'fan_meeting', rule: { kind: 'hint' } });
  });

  it('來源推論優先於關鍵字：CWT → doujin', () => {
    const r = classifier.classify({ title: 'CWT 某某 快閃', sourceId: 'cwt' });
    expect(r).toMatchObject({ type: 'doujin', rule: { kind: 'source', sourceId: 'cwt' } });
    // 關鍵字命中仍保留，供除錯
    expect(r.keywordHits.map((h) => h.type)).toEqual(['popup_cafe']);
  });

  it('代理商來源沒有預設類型 → 走關鍵字', () => {
    expect(classifier.classify({ title: '某某 快閃店', sourceId: 'muse' }).rule.kind).toBe(
      'keyword',
    );
  });

  it('同一最高 priority 有兩種類型 → conflict（不猜）', () => {
    const c = new TypeClassifier([
      { type: 'concert', priority: 10, keywords: ['甲'] },
      { type: 'exhibition', priority: 10, keywords: ['乙'] },
    ]);
    const r = c.classify({ title: '甲乙' });
    expect(r).toMatchObject({
      type: null,
      rule: { kind: 'conflict', types: ['concert', 'exhibition'] },
      reviewReasons: ['type_unresolved'],
    });
  });

  it('同一輸入結果穩定', () => {
    const a = classifier.classify({ title: '孤獨搖滾 演唱會 快閃店' });
    expect(classifier.classify({ title: '孤獨搖滾 演唱會 快閃店' })).toEqual(a);
  });

  it('describeTypeRule', () => {
    expect(
      describeTypeRule({ kind: 'keyword', keyword: '快閃店', type: 'popup_cafe', priority: 20 }),
    ).toContain('快閃店');
    expect(describeTypeRule({ kind: 'none' })).toBe('無命中規則');
  });
});
