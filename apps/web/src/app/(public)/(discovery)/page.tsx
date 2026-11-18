import { findTagsByRef, listPublicEvents, listPublicTagFacets } from '@aeh/db';
import { normalizeForMatch } from '@aeh/normalize';
import type { Metadata } from 'next';
import { ActiveFilters, tagNameMap } from '@/components/public/ActiveFilters';
import { CalendarView } from '@/components/public/CalendarView';
import { EventList } from '@/components/public/EventList';
import { FilterDrawer } from '@/components/public/FilterDrawer';
import { FilterPanel } from '@/components/public/FilterPanel';
import { ViewToggle } from '@/components/public/ViewToggle';
import { getDb } from '@/lib/db';
import {
  activeFilterCount,
  parseDiscoveryQuery,
  resolveRange,
  toSearchString,
  type SearchParamsRecord,
} from '@/lib/public/filters';

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
  const [{ rows, total }, facets, selectedTags] = await Promise.all([
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
  ]);
  const filterCount = activeFilterCount(query);
  const searchKey = toSearchString(query);

  return (
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
        <ActiveFilters query={query} tagNames={tagNameMap(selectedTags)} />

        {total > rows.length && (
          <p className="notice">符合條件的活動較多，僅顯示前 {rows.length} 筆，請縮小篩選範圍。</p>
        )}

        {query.view === 'calendar' && range.month ? (
          <CalendarView events={rows} month={range.month} query={query} now={now} />
        ) : rows.length > 0 ? (
          <EventList events={rows} now={now} />
        ) : (
          <div className="empty">
            <p>{filterCount > 0 ? '沒有符合條件的活動。' : '目前沒有即將舉行的活動。'}</p>
            {filterCount > 0 && <p>試著減少篩選條件，或切換到月曆檢視其它月份。</p>}
          </div>
        )}
      </section>
    </div>
  );
}
