import { EVENT_TYPE_LABEL } from '@aeh/core';
import {
  findTagsByRef,
  getFollows,
  listFavoriteEventIds,
  listPublicEvents,
  listPublicTagFacets,
} from '@aeh/db';
import { normalizeForMatch } from '@aeh/normalize';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ActiveFilters, tagNameMap } from '@/components/public/ActiveFilters';
import { CalendarView } from '@/components/public/CalendarView';
import { EventList } from '@/components/public/EventList';
import { FilterDrawer } from '@/components/public/FilterDrawer';
import { FilterPanel } from '@/components/public/FilterPanel';
import { FollowButton } from '@/components/public/FollowButton';
import { ViewToggle } from '@/components/public/ViewToggle';
import { getDb } from '@/lib/db';
import {
  DATE_PRESETS,
  DATE_PRESET_LABEL,
  SALE_LABEL,
  activeDatePreset,
  activeFilterCount,
  datePresetRange,
  parseDiscoveryQuery,
  resolveRange,
  tagParamKey,
  toSearchString,
  type DiscoveryQuery,
  type SearchParamsRecord,
} from '@/lib/public/filters';
import { currentSubscriber } from '@/lib/subscriber';

export const metadata: Metadata = {
  title: '近期動漫活動｜Anime Event Hub TW',
  description: '台灣動漫演唱會、見面會、展覽、快閃店、同人展一次看。',
};

export default async function DiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const query = parseDiscoveryQuery(await searchParams);
  const now = new Date();
  const range = resolveRange(query, now);
  const db = getDb();

  const qNormalized = query.q ? normalizeForMatch(query.q).trim() : '';
  const [{ rows, total }, facets, selectedTags, sub] = await Promise.all([
    listPublicEvents(db, {
      regions: query.regions,
      types: query.types,
      tags: query.tags,
      ...(query.q ? { q: query.q } : {}),
      ...(qNormalized ? { qNormalized } : {}),
      from: range.from,
      ...(range.to ? { to: range.to } : {}),
      ...(query.sale ? { sale: query.sale } : {}),
      includeEnded: range.includeEnded,
      now,
    }),
    listPublicTagFacets(db, now),
    findTagsByRef(db, query.tags),
    currentSubscriber(),
  ]);
  const [favoriteIds, follows] = sub
    ? await Promise.all([listFavoriteEventIds(db, sub.id), getFollows(db, sub.id)])
    : [[], { tags: [], types: [] }];
  const filterCount = activeFilterCount(query);
  const searchKey = toSearchString(query);
  const followedTags = new Set(follows.tags.map(tagParamKey));
  const followedTypes = new Set(follows.types);

  return (
    <>
      {query.view === 'list' && filterCount === 0 && <Hero query={query} now={now} />}
      <div className="discovery">
        <FilterDrawer key={searchKey} count={filterCount}>
          <FilterPanel query={query} facets={facets} selectedTags={selectedTags} />
        </FilterDrawer>

        <section className="results" aria-live="polite">
          <div className="results-head">
            <h1>
              {query.view === 'calendar' ? '活動月曆' : '近期活動'}
              <span className="count">{total} 筆</span>
            </h1>
            <ViewToggle query={query} />
          </div>
          {query.view === 'list' && <QuickChips query={query} now={now} />}
          <ActiveFilters query={query} tagNames={tagNameMap(selectedTags)} />

          {(selectedTags.length > 0 || query.types.length > 0) && (
            <div className="follow-bar">
              <span className="follow-bar-text">🔔 有新活動上架時通知我：</span>
              {selectedTags.map((t) => (
                <FollowButton
                  key={tagParamKey(t)}
                  target={{ kind: 'tag', tagKind: t.kind, slug: t.slug }}
                  name={t.name}
                  initial={followedTags.has(tagParamKey(t))}
                  size="sm"
                />
              ))}
              {query.types.map((t) => (
                <FollowButton
                  key={t}
                  target={{ kind: 'type', type: t }}
                  name={EVENT_TYPE_LABEL[t]}
                  initial={followedTypes.has(t)}
                  size="sm"
                />
              ))}
            </div>
          )}

          {total > rows.length && (
            <p className="notice">
              符合條件的活動較多，僅顯示前 {rows.length} 筆，請縮小篩選範圍。
            </p>
          )}

          {query.view === 'calendar' && range.month ? (
            <CalendarView events={rows} month={range.month} query={query} now={now} />
          ) : rows.length > 0 ? (
            <EventList events={rows} now={now} favoriteIds={new Set(favoriteIds)} />
          ) : (
            <div className="empty">
              <p className="empty-emoji" aria-hidden>
                🔍
              </p>
              <p>{filterCount > 0 ? '沒有符合條件的活動。' : '目前沒有即將舉行的活動。'}</p>
              {filterCount > 0 && <p>試著減少篩選條件，或切換到月曆檢視其它月份。</p>}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

/** 首頁橫幅：只在列表檢視、沒有任何篩選時出現 */
function Hero({ query, now }: { query: DiscoveryQuery; now: Date }) {
  const weekend = datePresetRange('weekend', now);
  return (
    <section className="hero" aria-labelledby="hero-title">
      <p className="hero-kicker">台灣動漫活動整合平台</p>
      <h2 id="hero-title" className="hero-title">
        台灣動漫活動，一站看完！
      </h2>
      <p className="hero-sub">
        演唱會、見面會、展覽、快閃店、同人展——收藏活動就能收到開賣與前一天提醒。
      </p>
      <div className="hero-actions">
        <Link
          className="btn btn-hero"
          href={`/${toSearchString(query, { from: weekend.from, to: weekend.to })}`}
          scroll={false}
        >
          這週末有什麼？
        </Link>
        <Link className="btn btn-hero-ghost" href="/me">
          ★ 我的追蹤
        </Link>
      </div>
    </section>
  );
}

/** 列表檢視上方的快速篩選（日期捷徑、已開賣） */
function QuickChips({ query, now }: { query: DiscoveryQuery; now: Date }) {
  const active = activeDatePreset(query, now);
  return (
    <nav className="quick-chips" aria-label="快速篩選">
      {DATE_PRESETS.map((p) => {
        const on = active === p;
        const r = datePresetRange(p, now);
        return (
          <Link
            key={p}
            href={`/${toSearchString(query, on ? { from: null, to: null } : r)}`}
            className={`quick-chip${on ? ' is-on' : ''}`}
            aria-current={on ? 'true' : undefined}
            scroll={false}
          >
            {DATE_PRESET_LABEL[p]}
          </Link>
        );
      })}
      <Link
        href={`/${toSearchString(query, { sale: query.sale === 'on_sale' ? null : 'on_sale' })}`}
        className={`quick-chip${query.sale === 'on_sale' ? ' is-on' : ''}`}
        aria-current={query.sale === 'on_sale' ? 'true' : undefined}
        scroll={false}
      >
        {SALE_LABEL.on_sale}
      </Link>
    </nav>
  );
}
