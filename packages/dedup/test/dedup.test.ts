import type { NormalizedEvent } from '@aeh/core';
import { normalizeTitle } from '@aeh/normalize';
import { describe, expect, it } from 'vitest';
import {
  decideDuplicate,
  dedupKey,
  fillMissing,
  planSourceUpdate,
  trigramSimilarity,
  type DedupCandidate,
  type EventFields,
} from '../src';

const at = (iso: string) => new Date(iso);
const t = (s: string) => normalizeTitle(s);

describe('dedupKey', () => {
  it('正規化標題（去空白）＋台灣日期＋場館', () => {
    const k = dedupKey({
      titleNormalized: t('孤獨搖滾！ POP UP STORE'),
      startAt: at('2026-12-04T16:00:00Z'),
      venueId: 7,
      isOnline: false,
    });
    expect(k).toBe('孤獨搖滾popupstore|2026-12-05|v7');
  });
  it('全形/半形、臺/台、空白差異得到同一鍵', () => {
    const a = dedupKey({
      titleNormalized: t('【公告】ＳＰＹ×ＦＡＭＩＬＹ 臺北展'),
      startAt: at('2026-12-05T02:00:00Z'),
      venueId: 1,
      isOnline: false,
    });
    const b = dedupKey({
      titleNormalized: t('SPY FAMILY 台北展'),
      startAt: at('2026-12-05T10:00:00Z'),
      venueId: 1,
      isOnline: false,
    });
    expect(a).toBe(b);
  });
  it('缺開始日或場館（且非線上）→ null', () => {
    expect(
      dedupKey({ titleNormalized: 'x', startAt: null, venueId: 1, isOnline: false }),
    ).toBeNull();
    expect(
      dedupKey({
        titleNormalized: 'x',
        startAt: at('2026-12-05T00:00:00Z'),
        venueId: null,
        isOnline: false,
      }),
    ).toBeNull();
    expect(
      dedupKey({
        titleNormalized: 'x',
        startAt: at('2026-12-05T00:00:00Z'),
        venueId: null,
        isOnline: true,
      }),
    ).toBe('x|2026-12-05|online');
  });
});

describe('trigramSimilarity（與 pg_trgm 一致）', () => {
  it.each([
    ['word', 'word', 1],
    ['word', 'two words', 4 / 11], // PostgreSQL: similarity('word','two words') = 0.363636
    ['孤獨搖滾 pop up store', '台北 孤獨搖滾 快閃店', 0.2], // 與 pg_trgm 實測一致
    ['abc', 'xyz', 0],
    ['', 'abc', 0],
  ])('%s ~ %s = %f', (a, b, s) => expect(trigramSimilarity(a, b)).toBeCloseTo(s, 5));
  it('中文標題的相似度', () => {
    const s = trigramSimilarity(
      t('藍井艾露 EIR AOI LIVE TOUR 2026-2027〈UNBOUND〉台北'),
      t('【VIP站票】藍井艾露 EIR AOI LIVE TOUR 2026-2027〈UNBOUND〉台北'),
    );
    expect(s).toBeGreaterThan(0.6);
    expect(s).toBeLessThan(1);
  });
});

describe('decideDuplicate', () => {
  const incoming = {
    titleNormalized: t('孤獨搖滾 POP UP STORE'),
    startAt: at('2026-12-05T02:00:00Z'),
    venueId: 7,
    isOnline: false,
  };
  const cand = (over: Partial<DedupCandidate>): DedupCandidate => ({
    ...incoming,
    eventId: 1,
    similarity: 1,
    ...over,
  });

  it('完全命中去重鍵 → merge', () => {
    expect(decideDuplicate(incoming, [cand({ eventId: 9 })])).toEqual({
      kind: 'merge',
      eventId: 9,
      rule: 'exact_key',
      key: '孤獨搖滾popupstore|2026-12-05|v7',
    });
  });
  it('相似但不同標題、同日同場館 → possible（不自動合併）', () => {
    const r = decideDuplicate(incoming, [
      cand({ eventId: 3, titleNormalized: t('【台北】孤獨搖滾 快閃店'), similarity: 0.5 }),
      cand({ eventId: 4, titleNormalized: t('孤獨搖滾 POP UP STORE 第二彈'), similarity: 0.8 }),
    ]);
    expect(r).toEqual({
      kind: 'possible',
      eventIds: [4, 3],
      best: { eventId: 4, similarity: 0.8 },
    });
  });
  it('相似度低於灰色區間 → new', () => {
    expect(
      decideDuplicate(incoming, [cand({ titleNormalized: 'other', similarity: 0.2 })]).kind,
    ).toBe('new');
  });
  it('不同場館（巡迴不同城市）→ 不視為重複', () => {
    expect(
      decideDuplicate(incoming, [cand({ venueId: 8, titleNormalized: 'x', similarity: 0.9 })]).kind,
    ).toBe('new');
  });
  it('日期相差超過容許天數 → 不視為重複；容許天數可設定', () => {
    const far = cand({
      titleNormalized: 'x',
      startAt: at('2026-12-08T02:00:00Z'),
      similarity: 0.9,
    });
    expect(decideDuplicate(incoming, [far]).kind).toBe('new');
    expect(decideDuplicate(incoming, [far], { possibleMin: 0.45, dateWindowDays: 3 }).kind).toBe(
      'possible',
    );
  });
  it('任一邊沒有場館 → 可列為疑似重複，但不自動合併', () => {
    const r = decideDuplicate({ ...incoming, venueId: null }, [
      cand({ eventId: 5, similarity: 1 }),
    ]);
    expect(r.kind).toBe('possible');
  });
});

const fields = (over: Partial<EventFields> = {}): EventFields => ({
  title: '孤獨搖滾 POP UP STORE',
  titleNormalized: '孤獨搖滾 pop up store',
  type: 'popup_cafe',
  startAt: at('2026-12-05T02:00:00Z'),
  endAt: null,
  allDay: false,
  yearInferred: false,
  venueId: 7,
  venueRaw: '三創',
  isOnline: false,
  city: '台北市',
  region: 'north',
  priceMin: null,
  priceMax: null,
  isFree: false,
  saleStartAt: null,
  ...over,
});
const normalized = (over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  ...fields(),
  sourceId: 'muse',
  externalId: '1',
  sourceUrl: 'https://example.com/1',
  reviewReasons: [],
  ...over,
});

describe('fillMissing（跨來源合併）', () => {
  it('只補 null 欄位、不碰鎖定欄位', () => {
    const patch = fillMissing(
      fields({ endAt: null, priceMin: null, priceMax: null }),
      fields({ endAt: at('2026-12-27T15:59:59Z'), priceMin: 300, priceMax: 300, venueId: 9 }),
      ['priceMin'],
    );
    expect(patch).toEqual({ endAt: at('2026-12-27T15:59:59Z'), priceMax: 300 });
  });
});

describe('planSourceUpdate（同一來源內容變動）', () => {
  it('主要來源：未鎖定欄位覆寫、鎖定欄位保留；來源值較上次變動才標 source_changed', () => {
    const plan = planSourceUpdate({
      current: { ...fields({ title: '人工修正的標題' }), reviewReasons: [], status: 'published' },
      incoming: normalized({
        title: '來源新標題',
        titleNormalized: '來源新標題',
        priceMin: 500,
        priceMax: 500,
      }),
      locked: ['title'],
      isPrimary: true,
      previous: fields(),
    });
    expect(plan.patch).toEqual({ priceMin: 500, priceMax: 500 });
    expect(plan.lockedConflicts).toEqual(['title']);
    expect(plan.reviewReasons).toEqual(['source_changed']);
    expect(plan.status).toBe('pending_review');
  });

  it('人工值與來源不同、但來源沒變 → 不標 source_changed（重跑不會一直退回待審）', () => {
    const plan = planSourceUpdate({
      current: { ...fields({ title: '人工修正的標題' }), reviewReasons: [], status: 'published' },
      incoming: normalized(),
      locked: ['title'],
      isPrimary: true,
      previous: fields(),
    });
    expect(plan).toEqual({
      patch: {},
      reviewReasons: [],
      status: 'published',
      lockedConflicts: [],
    });
  });

  it('鎖定欄位與來源一致 → 不標 source_changed', () => {
    const plan = planSourceUpdate({
      current: { ...fields(), reviewReasons: [], status: 'published' },
      incoming: normalized(),
      locked: ['title', 'venueId'],
      isPrimary: true,
    });
    expect(plan).toEqual({
      patch: {},
      reviewReasons: [],
      status: 'published',
      lockedConflicts: [],
    });
  });

  it('人工補的場館已鎖定：來源仍是 unknown_venue 也不會退回待審', () => {
    const plan = planSourceUpdate({
      current: { ...fields({ venueId: 7 }), reviewReasons: [], status: 'published' },
      incoming: normalized({
        venueId: null,
        city: null,
        region: null,
        reviewReasons: ['unknown_venue'],
      }),
      locked: ['venueId', 'city', 'region'],
      isPrimary: true,
      previous: fields(),
    });
    expect(plan.reviewReasons).toEqual(['source_changed']);
  });

  it('來源新增審核原因 → 已發布活動退回待審（C4）', () => {
    const plan = planSourceUpdate({
      current: { ...fields(), reviewReasons: [], status: 'published' },
      incoming: normalized({ startAt: null, reviewReasons: ['ambiguous_date'] }),
      locked: [],
      isPrimary: true,
    });
    expect(plan.status).toBe('pending_review');
    expect(plan.reviewReasons).toEqual(['ambiguous_date']);
  });

  it('非主要來源：只補 null，不覆寫', () => {
    const plan = planSourceUpdate({
      current: {
        ...fields({ priceMin: null, priceMax: null }),
        reviewReasons: [],
        status: 'published',
      },
      incoming: normalized({ title: '別的寫法', priceMin: 800, priceMax: 800 }),
      locked: [],
      isPrimary: false,
    });
    expect(plan.patch).toEqual({ priceMin: 800, priceMax: 800 });
  });

  it('人工退回待審（statusLocked）→ 即使可自動發布也維持待審（H1）', () => {
    const plan = planSourceUpdate({
      current: { ...fields(), reviewReasons: [], status: 'pending_review', statusLocked: true },
      incoming: normalized(),
      locked: [],
      isPrimary: true,
      previous: fields(),
    });
    expect(plan.status).toBe('pending_review');
    expect(plan.reviewReasons).toEqual([]);
  });

  it('未鎖定的待審活動：原因清空後自動發布', () => {
    const plan = planSourceUpdate({
      current: { ...fields(), reviewReasons: ['ambiguous_date'], status: 'pending_review' },
      incoming: normalized(),
      locked: [],
      isPrimary: true,
      previous: fields(),
    });
    expect(plan.status).toBe('published');
  });

  it('隱藏的活動維持隱藏；possible_duplicate 保留到人工解除', () => {
    const plan = planSourceUpdate({
      current: { ...fields(), reviewReasons: ['possible_duplicate'], status: 'hidden' },
      incoming: normalized(),
      locked: [],
      isPrimary: true,
    });
    expect(plan.status).toBe('hidden');
    expect(plan.reviewReasons).toEqual(['possible_duplicate']);
  });
});
