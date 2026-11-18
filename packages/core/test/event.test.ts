import { describe, expect, it } from 'vitest';
import {
  NormalizedEventSchema,
  isAutoPublishable,
  pruneResolvedReasons,
  requiredFieldReasons,
  type NormalizedEvent,
} from '../src';

const valid: NormalizedEvent = {
  sourceId: 'kktix',
  externalId: 'abc',
  sourceUrl: 'https://kktix.com/events/abc',
  title: '孤獨搖滾！ POP UP STORE',
  titleNormalized: '孤獨搖滾 pop up store',
  type: 'popup_cafe',
  startAt: new Date('2026-11-16T03:00:00Z'),
  endAt: new Date('2026-11-30T12:00:00Z'),
  allDay: false,
  yearInferred: false,
  venueId: 1,
  venueRaw: '華山1914',
  isOnline: false,
  city: '台北市',
  region: 'north',
  priceMin: null,
  priceMax: null,
  isFree: true,
  saleStartAt: null,
  reviewReasons: [],
};

describe('NormalizedEventSchema', () => {
  it('接受合法資料', () => {
    expect(NormalizedEventSchema.parse(valid)).toEqual(valid);
  });

  it.each<[string, Partial<NormalizedEvent>, string]>([
    ['結束早於開始', { endAt: new Date('2026-11-01T00:00:00Z') }, 'endAt'],
    ['票價區間顛倒', { isFree: false, priceMin: 1500, priceMax: 800 }, 'priceMax'],
    ['免費卻有正票價', { isFree: true, priceMin: 500, priceMax: 500 }, 'isFree'],
    [
      '線上活動地區非 online',
      { isOnline: true, venueId: null, city: null, region: 'north' },
      'region',
    ],
    ['實體活動標為 online', { region: 'online' }, 'region'],
    ['region 與 city 不一致', { city: '高雄市', region: 'north' }, 'region'],
  ])('拒絕：%s', (_label, patch, path) => {
    const r = NormalizedEventSchema.safeParse({ ...valid, ...patch });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toContain(path);
  });

  it('線上活動可無場館', () => {
    const online = {
      ...valid,
      isOnline: true,
      venueId: null,
      city: null,
      region: 'online' as const,
    };
    expect(NormalizedEventSchema.safeParse(online).success).toBe(true);
  });
});

describe('requiredFieldReasons（§4.2）', () => {
  it('齊全時無原因', () => {
    expect(requiredFieldReasons(valid)).toEqual([]);
  });
  it('缺日期 → missing_date', () => {
    expect(requiredFieldReasons({ ...valid, startAt: null })).toEqual(['missing_date']);
  });
  it('無場館且非線上 → missing_venue', () => {
    expect(requiredFieldReasons({ ...valid, venueId: null })).toEqual(['missing_venue']);
  });
  it('無場館但為線上 → 通過', () => {
    expect(requiredFieldReasons({ ...valid, venueId: null, isOnline: true })).toEqual([]);
  });
  it('兩者皆缺', () => {
    expect(requiredFieldReasons({ ...valid, startAt: null, venueId: null })).toEqual([
      'missing_date',
      'missing_venue',
    ]);
  });
});

describe('isAutoPublishable（C4）', () => {
  it('齊全且無審核原因 → 可發布', () => {
    expect(isAutoPublishable(valid)).toBe(true);
  });
  it('有任何審核原因 → 不可發布', () => {
    expect(isAutoPublishable({ ...valid, reviewReasons: ['possible_duplicate'] })).toBe(false);
  });
  it('缺必要欄位 → 不可發布（即使 reviewReasons 為空）', () => {
    expect(isAutoPublishable({ ...valid, startAt: null })).toBe(false);
  });
  it('類型未判定 → 不可發布', () => {
    expect(isAutoPublishable({ ...valid, type: null })).toBe(false);
  });
});

describe('pruneResolvedReasons', () => {
  const all = [
    'missing_date',
    'ambiguous_date',
    'missing_venue',
    'unknown_venue',
    'outside_taiwan',
    'type_unresolved',
    'below_scale_threshold',
    'possible_duplicate',
    'source_changed',
  ] as const;
  it('欄位補齊後移除對應原因；與欄位無關者保留', () => {
    expect(
      pruneResolvedReasons(all, {
        startAt: new Date(0),
        venueId: 1,
        isOnline: false,
        type: 'concert',
      }),
    ).toEqual(['possible_duplicate', 'source_changed']);
  });
  it('仍缺的欄位保留原因', () => {
    expect(
      pruneResolvedReasons(all, { startAt: null, venueId: null, isOnline: true, type: null }),
    ).toEqual([
      'missing_date',
      'ambiguous_date',
      'type_unresolved',
      'below_scale_threshold',
      'possible_duplicate',
      'source_changed',
    ]);
  });
});
