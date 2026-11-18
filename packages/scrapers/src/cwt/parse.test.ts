import { describe, expect, it } from 'vitest';
import { fixture, tagger, venueResolver, venueSlug } from '../../test/context';
import { normalizeCandidate } from '../_shared/validate';
import { parseCwtActs } from './index';

const ctx = { fetchedOn: '2026-11-18' };
const items = parseCwtActs(
  fixture('cwt', 'acts-tw-2026-11-18.html'),
  'https://www.comicworld.com.tw/Acts/tw',
  ctx,
);

describe('CWT 台灣場活動一覽（真實快照 2026-11-18）', () => {
  it('解析 5 場，external_id 為 Act1 編號', () => {
    expect(items.map((i) => i.externalId)).toEqual(['170', '174', '177', '178', '175']);
  });

  it('欄位：標題、日期、場館、地址、詳細頁', () => {
    expect(items[0]?.candidate).toEqual({
      sourceId: 'cwt',
      externalId: '170',
      url: 'https://www.comicworld.com.tw/Act1/170',
      title: '【CWT-74】(台北場)',
      typeHint: 'doujin',
      dateText: '2026年12月12 / 13日',
      venueText: '國立臺灣大學綜合體育館1F&3F&4F',
      addressText: '台北市大安區羅斯福路四段1號',
    });
  });

  it('全部可自動發布：同人展、兩日全天活動、字典內場館', () => {
    const rs = items.map((i) =>
      normalizeCandidate(i.candidate!, { venues: venueResolver, tagger, ...ctx }),
    );
    expect(rs.map((r) => r.status)).toEqual(Array(5).fill('published'));
    expect(rs.map((r) => venueSlug(r.event.venueId))).toEqual([
      'ntu-sports-center',
      'ntu-sports-center',
      'kaohsiung-exhibition-center',
      'taichung-wtc',
      'ntu-sports-center',
    ]);
    const first = rs[0]!.event;
    expect(first).toMatchObject({ type: 'doujin', allDay: true, yearInferred: false });
    expect(first.startAt?.toISOString()).toBe('2026-12-11T16:00:00.000Z');
    expect(first.endAt?.toISOString()).toBe('2026-12-13T15:59:59.000Z');
  });
});
