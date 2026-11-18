import { REGION_LABEL } from '@aeh/core';
import type { PublicEventListItem } from '@aeh/db';
import Link from 'next/link';
import {
  formatEventWhen,
  formatPlace,
  formatPrice,
  hasEnded,
  saleState,
} from '@/lib/public/format';
import { TagChips } from './TagChips';
import { TypeBadge } from './TypeBadge';

/** 列表卡片：名稱（原文）、時間、場館/地區、票價、開賣狀態、標籤 */
export function EventCard({ event: e, now }: { event: PublicEventListItem; now: Date }) {
  const sale = saleState(e.saleStartAt, now);
  const ended = e.status === 'ended' || hasEnded(e.startAt, e.endAt, now);
  return (
    <article className={`event-card${ended ? ' is-ended' : ''}`}>
      <div className="event-card-meta">
        {e.type && <TypeBadge type={e.type} />}
        {e.region && <span className="region">{REGION_LABEL[e.region]}</span>}
        {ended && <span className="badge-muted">已結束</span>}
        {!ended && sale.state !== 'unknown' && (
          <span className={`sale sale-${sale.state}`}>{sale.label}</span>
        )}
      </div>
      <h3 className="event-card-title">
        <Link href={`/events/${e.id}`}>{e.title}</Link>
      </h3>
      <dl className="event-card-facts">
        <div>
          <dt>時間</dt>
          <dd>{formatEventWhen(e.startAt, e.endAt, e.allDay, { now, compact: true })}</dd>
        </div>
        <div>
          <dt>地點</dt>
          <dd>{formatPlace(e)}</dd>
        </div>
        <div>
          <dt>票價</dt>
          <dd>{formatPrice(e.priceMin, e.priceMax, e.isFree)}</dd>
        </div>
      </dl>
      {e.tags.length > 0 && <TagChips tags={e.tags} max={4} />}
    </article>
  );
}
