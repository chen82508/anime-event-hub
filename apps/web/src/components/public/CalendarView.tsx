import type { PublicEventListItem } from '@aeh/db';
import Link from 'next/link';
import { WEEKDAY_LABELS, agendaForMonth, buildMonthGrid, eventsByDay } from '@/lib/public/calendar';
import {
  shiftMonth,
  taipeiIsoDate,
  toSearchString,
  type DiscoveryQuery,
} from '@/lib/public/filters';
import { formatFullDate, formatPlace, formatTime, hasEnded } from '@/lib/public/format';
import { TypeBadge } from './TypeBadge';

const MAX_PER_CELL = 3;

/**
 * 月曆檢視。
 * - 寬螢幕：月格線，每格列出當天進行中的活動（最多 3 筆，其餘 +N）。
 * - 行動裝置：精簡格線（只顯示有活動的圓點）＋ 下方依日期排列的議程，點日期跳到議程。
 */
export function CalendarView({
  events,
  month,
  query,
  now,
}: {
  events: PublicEventListItem[];
  month: string;
  query: DiscoveryQuery;
  now: Date;
}) {
  const grid = buildMonthGrid(month);
  const byDay = eventsByDay(events, month);
  const agenda = agendaForMonth(events, month);
  const agendaDates = new Set(agenda.days.map((d) => d.date));
  const today = taipeiIsoDate(now);
  const [y, m] = month.split('-');
  const monthHref = (delta: number) =>
    `/${toSearchString(query, { view: 'calendar', month: shiftMonth(month, delta) })}`;

  return (
    <div className="calendar">
      <div className="calendar-nav">
        <Link href={monthHref(-1)} className="btn btn-ghost" aria-label="上個月" scroll={false}>
          ‹
        </Link>
        <h2>
          {y} 年 {Number(m)} 月
        </h2>
        <Link href={monthHref(1)} className="btn btn-ghost" aria-label="下個月" scroll={false}>
          ›
        </Link>
        {!today.startsWith(month) && (
          <Link
            href={`/${toSearchString(query, { view: 'calendar', month: today.slice(0, 7) })}`}
            className="btn btn-ghost btn-sm"
            scroll={false}
          >
            本月
          </Link>
        )}
      </div>

      <table className="calendar-grid">
        <thead>
          <tr>
            {WEEKDAY_LABELS.map((w) => (
              <th key={w} scope="col">
                {w}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((week) => (
            <tr key={week[0]!.date}>
              {week.map((cell) => {
                const list = cell.inMonth ? (byDay.get(cell.date) ?? []) : [];
                const cls = [
                  'calendar-cell',
                  cell.inMonth ? '' : 'is-outside',
                  cell.date === today ? 'is-today' : '',
                  list.length ? 'has-events' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <td key={cell.date} className={cls}>
                    {agendaDates.has(cell.date) ? (
                      <a href={`#d-${cell.date}`} className="day-num">
                        {cell.day}
                      </a>
                    ) : (
                      <span className="day-num">{cell.day}</span>
                    )}
                    {list.length > 0 && (
                      <span className="day-dots" aria-label={`${list.length} 個活動`}>
                        {list.slice(0, 3).map((e) => (
                          <i key={e.id} className={`dot type-${e.type ?? 'other'}`} />
                        ))}
                      </span>
                    )}
                    <ul className="day-events">
                      {list.slice(0, MAX_PER_CELL).map((e) => (
                        <li key={e.id}>
                          <Link
                            href={`/events/${e.id}`}
                            className={`day-event type-${e.type ?? 'other'}`}
                            title={e.title}
                          >
                            {e.title}
                          </Link>
                        </li>
                      ))}
                      {list.length > MAX_PER_CELL && (
                        <li className="day-more">
                          <a href={`#d-${cell.date}`}>+{list.length - MAX_PER_CELL}</a>
                        </li>
                      )}
                    </ul>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="agenda">
        {events.length === 0 && <p className="empty">本月沒有符合條件的活動。</p>}
        {agenda.ongoing.length > 0 && (
          <section className="agenda-day">
            <h3>上月起持續進行</h3>
            <AgendaList events={agenda.ongoing} now={now} />
          </section>
        )}
        {agenda.days.map((d) => (
          <section key={d.date} id={`d-${d.date}`} className="agenda-day">
            <h3>{formatFullDate(new Date(`${d.date}T12:00:00+08:00`))}</h3>
            <AgendaList events={d.events} now={now} />
          </section>
        ))}
      </div>
    </div>
  );
}

function AgendaList({ events, now }: { events: PublicEventListItem[]; now: Date }) {
  return (
    <ul className="agenda-list">
      {events.map((e) => (
        <li key={e.id} className={hasEnded(e.startAt, e.endAt, now) ? 'is-ended' : ''}>
          <span className="agenda-time">
            {e.allDay || !e.startAt ? '全天' : formatTime(e.startAt)}
          </span>
          <div>
            <Link href={`/events/${e.id}`} className="agenda-title">
              {e.title}
            </Link>
            <div className="agenda-meta">
              {e.type && <TypeBadge type={e.type} />}
              <span>{formatPlace(e)}</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
