import { EVENT_TYPE_LABEL, REGION_LABEL, TAG_KINDS, TAG_KIND_LABEL } from '@aeh/core';
import {
  getFollows,
  getPublicEvent,
  listFavoriteEventIds,
  type PublicEventSourceLink,
} from '@aeh/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { FavoriteButton } from '@/components/public/FavoriteButton';
import { FollowButton } from '@/components/public/FollowButton';
import { TagChips } from '@/components/public/TagChips';
import { TypeBadge } from '@/components/public/TypeBadge';
import { getDb } from '@/lib/db';
import {
  formatEventWhen,
  formatFullDate,
  formatPlace,
  formatPrice,
  formatTime,
  hasEnded,
  saleState,
} from '@/lib/public/format';
import { currentSubscriber } from '@/lib/subscriber';

type Params = Promise<{ id: string }>;

/** generateMetadata 與頁面共用同一次查詢 */
const loadEvent = cache(async (rawId: string) => {
  if (!/^\d{1,15}$/.test(rawId)) return null;
  return getPublicEvent(getDb(), Number(rawId));
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const e = await loadEvent((await params).id);
  if (!e) return { title: '找不到活動｜Anime Event Hub TW' };
  const when = formatEventWhen(e.startAt, e.endAt, e.allDay);
  return {
    title: `${e.title}｜Anime Event Hub TW`,
    description: `${when}・${formatPlace({ ...e, venueName: e.venue?.name ?? null })}`,
  };
}

function ctaLabel(s: PublicEventSourceLink): string {
  return s.sourceKind === 'ticketing'
    ? `前往 ${s.sourceName} 購票`
    : `查看官方公告（${s.sourceName}）`;
}

/** 地圖提示：以場館名稱＋地址查詢（只帶公開的場館資訊） */
function mapUrl(v: { name: string; address: string | null }): string {
  const query = [v.name, v.address].filter(Boolean).join(' ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export default async function EventDetailPage({ params }: { params: Params }) {
  const e = await loadEvent((await params).id);
  if (!e) notFound();

  const now = new Date();
  const sub = await currentSubscriber();
  const [favIds, follows] = sub
    ? await Promise.all([listFavoriteEventIds(getDb(), sub.id), getFollows(getDb(), sub.id)])
    : [[], { tags: [], types: [] }];
  const followedTags = new Set(follows.tags.map((t) => `${t.kind}:${t.slug}`));
  const ended = e.status === 'ended' || hasEnded(e.startAt, e.endAt, now);
  const sale = saleState(e.saleStartAt, now);
  const [primary, ...others] = e.sources;
  const tagGroups = TAG_KINDS.map((k) => ({
    kind: k,
    tags: e.tags.filter((t) => t.kind === k),
  })).filter((g) => g.tags.length > 0);

  return (
    <article className="detail">
      <nav className="breadcrumb" aria-label="導覽">
        <Link href="/">← 活動列表</Link>
      </nav>

      <header className="detail-head">
        <div className="event-card-meta">
          {e.type && <TypeBadge type={e.type} />}
          {e.region && (
            <Link href={`/?region=${e.region}`} className="region">
              {REGION_LABEL[e.region]}
            </Link>
          )}
          {ended && <span className="badge-muted">已結束</span>}
        </div>
        {/* 標題保留來源原文（C2） */}
        <h1>{e.title}</h1>
      </header>

      <div className="detail-layout">
        <div className="detail-main">
          <dl className="detail-facts">
            <div>
              <dt>日期時間</dt>
              <dd>{formatEventWhen(e.startAt, e.endAt, e.allDay)}</dd>
            </div>
            <div>
              <dt>地點</dt>
              <dd>
                {e.venue ? (
                  <>
                    <div>{e.venue.name}</div>
                    <div className="muted">
                      {e.venue.city}
                      {e.venue.address ? `・${e.venue.address}` : ''}
                    </div>
                  </>
                ) : e.isOnline ? (
                  '線上活動'
                ) : (
                  (e.city ?? '地點未定')
                )}
              </dd>
            </div>
            <div>
              <dt>票價</dt>
              <dd>{formatPrice(e.priceMin, e.priceMax, e.isFree)}</dd>
            </div>
            <div>
              <dt>開賣</dt>
              <dd>
                {sale.state === 'upcoming'
                  ? `${formatFullDate(sale.at)} ${formatTime(sale.at)}`
                  : sale.label}
              </dd>
            </div>
            {e.type && (
              <div>
                <dt>類型</dt>
                <dd className="dd-with-action">
                  <Link href={`/?type=${e.type}`}>{EVENT_TYPE_LABEL[e.type]}</Link>
                  {e.type !== 'other' && (
                    <FollowButton
                      target={{ kind: 'type', type: e.type }}
                      name={EVENT_TYPE_LABEL[e.type]}
                      initial={follows.types.includes(e.type)}
                      size="sm"
                    />
                  )}
                </dd>
              </div>
            )}
          </dl>

          {e.venue && (
            <section className="map-hint">
              <h2>場館位置</h2>
              <p>
                {e.venue.name}
                {e.venue.address ? `（${e.venue.address}）` : `（${e.venue.city}）`}
              </p>
              <a
                href={mapUrl(e.venue)}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-outline"
              >
                在 Google 地圖開啟 ↗
              </a>
            </section>
          )}

          {tagGroups.length > 0 && (
            <section className="detail-tags">
              <h2>相關標籤</h2>
              <p className="field-hint">訂閱標籤後，有新活動上架時會通知你。</p>
              {tagGroups.map((g) => (
                <div key={g.kind} className="tag-group">
                  <span className="tag-group-label">{TAG_KIND_LABEL[g.kind]}</span>
                  <TagChips tags={g.tags} />
                  <div className="follow-row">
                    {g.tags.map((t) => (
                      <FollowButton
                        key={t.slug}
                        target={{ kind: 'tag', tagKind: t.kind, slug: t.slug }}
                        name={t.name}
                        initial={followedTags.has(`${t.kind}:${t.slug}`)}
                        size="sm"
                      />
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )}
        </div>

        {/* 官方購票 / 原始公告連結：強制提供並置頂突顯（C8 導流回原平台） */}
        <aside className="detail-cta" aria-label="官方連結">
          {primary ? (
            <>
              <a
                href={primary.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary btn-block btn-lg"
              >
                {ctaLabel(primary)} ↗
              </a>
              {sale.state === 'upcoming' && !ended && <p className="cta-sale">{sale.label}</p>}
              {others.length > 0 && (
                <div className="other-sources">
                  <span className="muted">其它來源</span>
                  <ul>
                    {others.map((s) => (
                      <li key={s.url}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer">
                          {s.sourceName} ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="muted">原始連結暫時無法提供。</p>
          )}
          {!ended && (
            <FavoriteButton
              eventId={e.id}
              title={e.title}
              initial={favIds.includes(e.id)}
              variant="full"
            />
          )}
          <p className="disclaimer">
            本站僅彙整公開資訊，不販售票券。時間、票價與購票方式請以官方公告為準。
          </p>
        </aside>
      </div>
    </article>
  );
}
