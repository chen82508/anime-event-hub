import { describe, expect, it } from 'vitest';
import { parsePrice, type PriceParseResult } from '../src';
import { loadFixture } from './fixture-loader';

function render(r: PriceParseResult): string {
  if (r.kind !== 'ok') return r.kind;
  return r.value.isFree ? 'free' : `${r.value.min}-${r.value.max}`;
}

const { cases } = loadFixture('prices.txt');

describe('parsePrice：樣本檔（test/fixtures/prices.txt）', () => {
  it.each(cases.map((c) => [`L${c.line} ${c.fields[0]}`, c.fields] as const))(
    '%s',
    (_name, [text, expected]) => {
      expect(render(parsePrice(text))).toBe(expected);
    },
  );
});

describe('parsePrice：其它', () => {
  it('免費活動 min = max = 0（符合 NormalizedEvent 的 isFree 規則）', () => {
    expect(parsePrice('免費入場')).toEqual({
      kind: 'ok',
      value: { min: 0, max: 0, isFree: true, amounts: [] },
    });
  });

  it('保留所有抽出的金額供除錯', () => {
    const r = parsePrice('$800 / $1,500 / $800');
    expect(r.kind === 'ok' && r.value.amounts).toEqual([800, 1500, 800]);
  });

  it('maxAmount 可設定', () => {
    expect(parsePrice('NT$12,000', { maxAmount: 10_000 }).kind).toBe('ambiguous');
  });

  it('null / undefined → missing', () => {
    expect(parsePrice(null).kind).toBe('missing');
    expect(parsePrice(undefined).kind).toBe('missing');
  });
});
