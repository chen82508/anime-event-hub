import { describe, expect, it } from 'vitest';
import {
  cleanText,
  compactForMatch,
  normalizeForMatch,
  normalizeTitle,
  toHalfWidth,
  unifyTai,
} from '../src';

describe('normalizeForMatch（R4）', () => {
  it.each([
    ['全形英數 → 半形、小寫', 'ＰＯＰ\u3000ＵＰ ＳＴＯＲＥ', 'pop up store'],
    ['全形數字與符號', '１１／１６', '11 16'],
    ['臺 → 台', '臺北國際動漫節', '台北國際動漫節'],
    ['【】 與日文 ・ 視為分隔', '【推しの子】ぼっち・ざ・ろっく！', '推しの子 ぼっち ざ ろっく'],
    ['各種波浪號與連字號', 'A～B〜C~D－E—F', 'a b c d e f'],
    ['零寬字元移除（不留空白）', '鬼滅\u200B之\u200D刃\uFEFF', '鬼滅之刃'],
    ['emoji → 空白', '孤獨搖滾🎸快閃店✨', '孤獨搖滾 快閃店'],
    ['emoji 變體選擇符與膚色', '👍🏻見面會❤\uFE0F', '見面會'],
    ['× 等符號', 'SPY×FAMILY', 'spy family'],
    ['片假名長音保留', 'チェンソーマン', 'チェンソーマン'],
    ['半形片假名 → 全形', 'ｺﾗﾎﾞｶﾌｪ', 'コラボカフェ'],
    ['連續空白、換行、tab', '  台北\n\t小巨蛋   演唱會 ', '台北 小巨蛋 演唱會'],
    ['全形空白 U+3000', '台北\u3000小巨蛋', '台北 小巨蛋'],
    ['NBSP', '台北\u00A0小巨蛋', '台北 小巨蛋'],
    ['括號', '「葬送的芙莉蓮」（台北場）', '葬送的芙莉蓮 台北場'],
  ])('%s', (_name, input, expected) => {
    expect(normalizeForMatch(input)).toBe(expected);
  });

  it('冪等：再正規化一次結果不變', () => {
    const once = normalizeForMatch('【臺北】ＳＰＹ×ＦＡＭＩＬＹ 🎉 展');
    expect(normalizeForMatch(once)).toBe(once);
  });
});

describe('compactForMatch', () => {
  it('移除所有空白', () => {
    expect(compactForMatch('南港展覽館 1館')).toBe(compactForMatch('南港展覽館1館'));
    expect(compactForMatch('TWTC Hall 1')).toBe('twtchall1');
  });
});

describe('normalizeTitle', () => {
  it.each([
    ['【公告】【推しの子】POP UP STORE', '推しの子 pop up store'],
    ['[最新消息] 孤獨搖滾！快閃店', '孤獨搖滾 快閃店'],
    ['【售票資訊】【活動】XX 演唱會', 'xx 演唱會'],
    ['【台北】XXX 快閃店', '台北 xxx 快閃店'],
    ['【推しの子】展', '推しの子 展'],
    ['【公告】', '公告'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });
});

describe('cleanText 等小工具', () => {
  it('cleanText 保留標點與大小寫', () => {
    expect(cleanText('ＮＴ＄１，２００\u200B 起')).toBe('NT$1,200 起');
  });
  it('toHalfWidth / unifyTai', () => {
    expect(toHalfWidth('１１／１６（六）')).toBe('11/16(六)');
    expect(unifyTai('臺中臺南')).toBe('台中台南');
  });
});
