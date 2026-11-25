import type { PublicEventListItem } from '@aeh/db';
import { taipeiIsoDate } from '@/lib/public/filters';
import { EventCard } from './EventCard';

/** 列表檢視：依開始月份分段（時間軸）。進行中的長期活動排在最前面「進行中」。 */
export function EventList({
  events,
  now,
  favoriteIds = new Set(),
  groupByMonth = true,
}: {
  events: PublicEventListItem[];
  now: Date;
  favoriteIds?: ReadonlySet<number>;
  /** false：不分段（「我的收藏」） */
  groupByMonth?: boolean;
}) {
  if (!groupByMonth) {
    return (
      <div className="event-grid">
        {events.map((e) => (
          <EventCard key={e.id} event={e} now={now} favorited={favoriteIds.has(e.id)} />
        ))}
      </div>
    );
  }
  const groups: { key: string; label: string; events: PublicEventListItem[] }[] = [];
  for (const e of events) {
    const started = e.startAt && e.startAt.getTime() <= now.getTime();
    const key = started ? 'ongoing' : taipeiIsoDate(e.startAt!).slice(0, 7);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      const [y, m] = key.split('-');
      g = { key, label: key === 'ongoing' ? '進行中' : `${y} 年 ${Number(m)} 月`, events: [] };
      // 「進行中」永遠在第一段
      if (key === 'ongoing') groups.unshift(g);
      else groups.push(g);
    }
    g.events.push(e);
  }

  return (
    <div className="timeline">
      {groups.map((g) => (
        <section key={g.key} className="timeline-group" aria-labelledby={`g-${g.key}`}>
          <h2 id={`g-${g.key}`} className="timeline-heading">
            {g.label}
            <span className="count">{g.events.length}</span>
          </h2>
          <div className="event-grid">
            {g.events.map((e) => (
              <EventCard key={e.id} event={e} now={now} favorited={favoriteIds.has(e.id)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
