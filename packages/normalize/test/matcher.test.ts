import { describe, expect, it } from 'vitest';
import { LongestMatcher, isWordBoundary } from '../src';

describe('LongestMatcher', () => {
  const m = new LongestMatcher([
    { pattern: '北市', value: 'taipei' },
    { pattern: '新北市', value: 'new-taipei' },
    { pattern: 'eva', value: 'eva', boundary: true },
    { pattern: '鬼滅', value: 'kny-short', boundary: true },
    { pattern: '鬼滅之刃', value: 'kny' },
    { pattern: 'aqours', value: 'artist' },
    { pattern: 'aqours', value: 'work' },
  ]);

  const hits = (text: string) =>
    m.findAll(text).map((h) => `${h.pattern}@${h.start}:${h.values.join('+')}`);

  it('最長匹配優先、不重疊', () => {
    expect(hits('新北市')).toEqual(['新北市@0:new-taipei']);
    expect(hits('鬼滅之刃 展')).toEqual(['鬼滅之刃@0:kny']);
  });
  it('同一 pattern 的多個條目一起回傳', () => {
    expect(hits('aqours live')).toEqual(['aqours@0:artist+work']);
  });
  it('整詞邊界：拉丁字母不可與前後英數相連', () => {
    expect(hits('eva 展')).toEqual(['eva@0:eva']);
    expect(hits('eva展')).toEqual(['eva@0:eva']);
    expect(hits('evangelion')).toEqual([]);
    expect(hits('medieval')).toEqual([]);
  });
  it('整詞邊界：短中文別名不可與前後漢字相連', () => {
    expect(hits('鬼滅 快閃店')).toEqual(['鬼滅@0:kny-short']);
    expect(hits('鬼滅快閃店')).toEqual([]);
  });
  it('空 pattern 忽略', () => {
    expect(new LongestMatcher([{ pattern: '', value: 1 }]).findAll('abc')).toEqual([]);
  });
});

describe('isWordBoundary', () => {
  it.each([
    ['ab cd', 0, 2, true],
    ['abcd', 0, 2, false],
    ['中文ab', 2, 4, true],
    ['ab中文', 2, 4, true],
    ['中文字', 0, 2, false],
  ] as const)('%s [%i,%i) → %s', (text, s, e, ok) => {
    expect(isWordBoundary(text, s, e)).toBe(ok);
  });
});
