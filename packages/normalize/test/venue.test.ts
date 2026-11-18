import { describe, expect, it } from 'vitest';
import {
  CityMatcher,
  VenueResolver,
  cityEntriesFromRegionsDict,
  findOverseasPlace,
  resolveRegion,
  venueReviewReasons,
  type VenueResolution,
} from '../src';
import { regionsDict, venuesDict } from './dictionaries';

const cities = cityEntriesFromRegionsDict(regionsDict);
const cityMatcher = new CityMatcher(cities);
const resolver = new VenueResolver(venuesDict, cities);

function summary(r: VenueResolution): string {
  switch (r.kind) {
    case 'matched':
      return `matched:${r.venue.slug}`;
    case 'outside_taiwan':
      return `outside_taiwan:${r.place}`;
    case 'ambiguous':
      return `ambiguous:${r.venues.map((v) => v.slug).join(',')}`;
    case 'unknown':
      return `unknown:${r.city ?? '-'}`;
    default:
      return r.kind;
  }
}

describe('CityMatcher', () => {
  it.each([
    ['臺北市信義區信義路五段5號', '台北市'],
    ['台北', '台北市'],
    ['新北市新莊區', '新北市'],
    ['新北市板橋區', '新北市'],
    ['臺中市西屯區', '台中市'],
    ['高雄市前鎮區', '高雄市'],
    ['台東縣台東市', '台東縣'],
    ['馬祖', '連江縣'],
    ['台北京站時尚廣場', '台北市'],
  ])('%s → %s', (text, city) => {
    expect(cityMatcher.extract(text)).toEqual({ kind: 'ok', city });
  });

  it('多個縣市 → ambiguous', () => {
    expect(cityMatcher.extract('台北、台中、高雄巡迴')).toEqual({
      kind: 'ambiguous',
      cities: ['台北市', '台中市', '高雄市'],
    });
  });

  it('沒有縣市 → none', () => {
    expect(cityMatcher.extract('某某 Live House')).toEqual({ kind: 'none' });
  });
});

describe('resolveRegion（D3）', () => {
  it.each([
    ['宜蘭縣', 'north'],
    ['苗栗縣', 'central'],
    ['嘉義市', 'south'],
    ['花蓮縣', 'east'],
    ['金門縣', 'islands'],
  ] as const)('%s → %s', (city, region) => {
    expect(resolveRegion({ isOnline: false, city })).toBe(region);
  });
  it('線上 → online；無縣市 → null', () => {
    expect(resolveRegion({ isOnline: true, city: '台北市' })).toBe('online');
    expect(resolveRegion({ isOnline: false, city: null })).toBeNull();
  });
});

describe('VenueResolver（使用 data/dictionaries/venues.yaml）', () => {
  it.each([
    [{ venueText: '台北世貿一館' }, 'matched:twtc-hall-1'],
    [{ venueText: '臺北世界貿易中心展覽一館' }, 'matched:twtc-hall-1'],
    [{ venueText: 'ＴＷＴＣ\u3000Ｈａｌｌ\u3000１' }, 'matched:twtc-hall-1'],
    [{ venueText: '南港展覽館 1館 4樓' }, 'matched:nangang-exhibition-hall-1'],
    [{ venueText: '台北南港展覽館二館' }, 'matched:nangang-exhibition-hall-2'],
    [{ venueText: '臺北小巨蛋' }, 'matched:taipei-arena'],
    [{ venueText: '高雄巨蛋' }, 'matched:kaohsiung-arena'],
    [{ venueText: 'Zepp New Taipei（新北市新莊區）' }, 'matched:zepp-new-taipei'],
    [{ venueText: '華山1914文化創意產業園區 中4B' }, 'matched:huashan-1914'],
    [{ venueText: '松山文創園區 5號倉庫' }, 'matched:songshan-cultural-park'],
    [{ venueText: '台中國際展覽館' }, 'matched:taichung-intl-exhibition-center'],
    [{ venueText: '高雄流行音樂中心 海音館' }, 'matched:kaohsiung-music-center'],
    [{ venueText: '活動會場', addressText: '台北市信義區 TICC' }, 'matched:ticc'],
    // 地址中的位置說明不影響場館欄的判定（KKTIX 實際寫法）
    [
      {
        venueText: 'Legacy Taipei',
        addressText: '台北市中正區八德路一段1號(華山1914文化創意產業園區中5A館)',
      },
      'matched:legacy-taipei',
    ],
    // 一則公告多場館（R5）→ 交給人工拆分
    [{ venueText: '台北小巨蛋／高雄巨蛋' }, 'ambiguous:taipei-arena,kaohsiung-arena'],
    // 未命中
    [{ venueText: '某某咖啡 台中店' }, 'unknown:台中市'],
    [{ venueText: '某某 Live House' }, 'unknown:-'],
    [{ venueText: '南港展覽館' }, 'unknown:-'],
    // 線上
    [{ venueText: '線上直播（YouTube）' }, 'online'],
    [{ venueText: 'オンライン配信' }, 'online'],
    [{ isOnline: true }, 'online'],
    // 海外（R12）
    [{ venueText: '東京ドーム' }, 'outside_taiwan:東京ドーム'],
    [{ venueText: '幕張メッセ' }, 'outside_taiwan:幕張'],
    [{ venueText: 'Zepp Osaka Bayside' }, 'outside_taiwan:osaka'],
    [{ venueText: '香港會議展覽中心' }, 'outside_taiwan:香港'],
    [{ venueText: '台北京站 威秀影城' }, 'unknown:台北市'],
    // 缺漏
    [{}, 'missing'],
    [{ venueText: '  ' }, 'missing'],
  ])('%j → %s', (input, expected) => {
    expect(summary(resolver.resolve(input))).toBe(expected);
  });

  it('命中時帶出縣市、地區與命中的別名', () => {
    const r = resolver.resolve({ venueText: '高展館' });
    expect(r).toMatchObject({
      kind: 'matched',
      matched: '高展館',
      city: '高雄市',
      region: 'south',
    });
  });

  it('venueReviewReasons 對應 §4.3', () => {
    expect(venueReviewReasons(resolver.resolve({ venueText: '小巨蛋' }))).toEqual([]);
    expect(venueReviewReasons(resolver.resolve({ isOnline: true }))).toEqual([]);
    expect(venueReviewReasons(resolver.resolve({}))).toEqual(['missing_venue']);
    expect(venueReviewReasons(resolver.resolve({ venueText: '某某 Live House' }))).toEqual([
      'unknown_venue',
    ]);
    expect(venueReviewReasons(resolver.resolve({ venueText: '東京ドーム' }))).toEqual([
      'outside_taiwan',
    ]);
  });
});

describe('findOverseasPlace', () => {
  it('台灣地名不會誤判', () => {
    expect(findOverseasPlace('台北市中正區')).toBeNull();
    expect(findOverseasPlace('中國信託金融園區')).toBeNull();
  });
});
