import { describe, expect, it } from 'vitest';
import {
  CITY_REGION,
  EVENT_STATUSES,
  EVENT_STATUS_LABEL,
  EVENT_TYPES,
  EVENT_TYPE_LABEL,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_LABEL,
  NOTIFY_CHANNELS,
  NOTIFY_CHANNEL_LABEL,
  REGIONS,
  REGION_LABEL,
  REVIEW_REASONS,
  REVIEW_REASON_LABEL,
  SOURCE_IDS,
  TAG_KINDS,
  TAG_KIND_LABEL,
  TAIWAN_CITIES,
  regionOfCity,
} from '../src';

describe('enums', () => {
  it('每個 enum 值都有繁中標籤，且沒有多餘的標籤', () => {
    const cases: [readonly string[], Record<string, string>][] = [
      [EVENT_TYPES, EVENT_TYPE_LABEL],
      [REGIONS, REGION_LABEL],
      [EVENT_STATUSES, EVENT_STATUS_LABEL],
      [REVIEW_REASONS, REVIEW_REASON_LABEL],
      [TAG_KINDS, TAG_KIND_LABEL],
      [NOTIFICATION_KINDS, NOTIFICATION_KIND_LABEL],
      [NOTIFY_CHANNELS, NOTIFY_CHANNEL_LABEL],
    ];
    for (const [values, labels] of cases) {
      expect(Object.keys(labels).sort()).toEqual([...values].sort());
      for (const v of values) expect(labels[v]).toMatch(/\S/);
    }
  });

  it('審核原因代碼與 tech-spec §4.3 一致', () => {
    expect(REVIEW_REASONS).toEqual([
      'missing_date',
      'ambiguous_date',
      'missing_venue',
      'unknown_venue',
      'outside_taiwan',
      'possible_duplicate',
      'type_unresolved',
      'below_scale_threshold',
      'parse_error',
      'source_changed',
    ]);
  });

  it('不包含暫緩的來源（拓元、ibon，C10）', () => {
    expect(SOURCE_IDS).not.toContain('tixcraft');
    expect(SOURCE_IDS).not.toContain('ibon');
  });
});

describe('CITY_REGION（D3）', () => {
  it('涵蓋台灣 22 個縣市，正規名稱使用「台」', () => {
    expect(TAIWAN_CITIES).toHaveLength(22);
    for (const c of TAIWAN_CITIES) expect(c).not.toContain('臺');
  });

  it('縣市不會被歸到 online', () => {
    expect(Object.values(CITY_REGION)).not.toContain('online');
  });

  it.each([
    ['宜蘭縣', 'north'],
    ['新竹縣', 'north'],
    ['苗栗縣', 'central'],
    ['雲林縣', 'central'],
    ['嘉義市', 'south'],
    ['屏東縣', 'south'],
    ['花蓮縣', 'east'],
    ['台東縣', 'east'],
    ['金門縣', 'islands'],
    ['連江縣', 'islands'],
  ] as const)('%s → %s', (city, region) => {
    expect(regionOfCity(city)).toBe(region);
  });

  it('各地區縣市數量', () => {
    const count = (r: string) => Object.values(CITY_REGION).filter((v) => v === r).length;
    expect([
      count('north'),
      count('central'),
      count('south'),
      count('east'),
      count('islands'),
    ]).toEqual([7, 5, 5, 2, 3]);
  });
});
