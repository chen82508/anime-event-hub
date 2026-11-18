import {
  EVENT_STATUSES,
  EVENT_STATUS_LABEL,
  EVENT_TYPE_LABEL,
  REVIEW_REASONS,
  REVIEW_REASON_LABEL,
  SOURCE_IDS,
  type EventStatus,
  type ReviewReason,
  type SourceId,
} from '@aeh/core';
import { listEventsForReview } from '@aeh/db';
import Link from 'next/link';
import { getDb } from '@/lib/db';
import { formatWhen } from '@/lib/format';

const PAGE_SIZE = 50;
const truncate = (s: string, n: number) =>
  [...s].length > n ? `${[...s].slice(0, n).join('')}…` : s;

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function ReviewListPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const statusParam = one(sp.status);
  const status: EventStatus | undefined =
    statusParam === 'all'
      ? undefined
      : EVENT_STATUSES.includes(statusParam as EventStatus)
        ? (statusParam as EventStatus)
        : 'pending_review';
  const reason = REVIEW_REASONS.includes(one(sp.reason) as ReviewReason)
    ? (one(sp.reason) as ReviewReason)
    : undefined;
  const sourceId = SOURCE_IDS.includes(one(sp.source) as SourceId)
    ? (one(sp.source) as SourceId)
    : undefined;
  const q = one(sp.q)?.trim();
  const page = Math.max(1, Number(one(sp.page) ?? 1) || 1);

  const { rows, total } = await listEventsForReview(getDb(), {
    ...(status ? { status } : {}),
    ...(reason ? { reason } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(q ? { q } : {}),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const qs = (p: number) => {
    const u = new URLSearchParams();
    u.set('status', status ?? 'all');
    if (reason) u.set('reason', reason);
    if (sourceId) u.set('source', sourceId);
    if (q) u.set('q', q);
    u.set('page', String(p));
    return `/admin?${u}`;
  };

  return (
    <>
      <h1>
        {status ? EVENT_STATUS_LABEL[status] : '全部活動'}{' '}
        <span className="muted">（{total} 筆）</span>
      </h1>
      <form className="card filters" method="get">
        <label>
          狀態
          <select name="status" defaultValue={status ?? 'all'}>
            <option value="all">全部</option>
            {EVENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {EVENT_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          審核原因
          <select name="reason" defaultValue={reason ?? ''}>
            <option value="">不限</option>
            {REVIEW_REASONS.map((r) => (
              <option key={r} value={r}>
                {REVIEW_REASON_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label>
          來源
          <select name="source" defaultValue={sourceId ?? ''}>
            <option value="">不限</option>
            {SOURCE_IDS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          標題關鍵字
          <input name="q" defaultValue={q ?? ''} placeholder="原文或正規化標題" />
        </label>
        <button type="submit" className="primary">
          篩選
        </button>
      </form>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>標題（原文）</th>
            <th>類型</th>
            <th>開始</th>
            <th>場館</th>
            <th>來源</th>
            <th>狀態／審核原因</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td>{e.id}</td>
              <td>
                <Link href={`/admin/events/${e.id}`}>{e.title}</Link>
                {e.lockedFields.length > 0 && (
                  <span className="badge lock"> 🔒 {e.lockedFields.length}</span>
                )}
              </td>
              <td>{e.type ? EVENT_TYPE_LABEL[e.type] : <span className="muted">未判定</span>}</td>
              <td>{formatWhen(e.startAt, e.allDay)}</td>
              <td>
                {e.isOnline
                  ? '線上'
                  : (e.venueName ?? (
                      <span className="muted" title={e.venueRaw ?? ''}>
                        {truncate(e.venueRaw ?? '—', 24)}
                      </span>
                    ))}
                {e.city && <div className="muted">{e.city}</div>}
              </td>
              <td>{e.sources.join('、')}</td>
              <td>
                <span className={`badge status-${e.status}`}>{EVENT_STATUS_LABEL[e.status]}</span>
                {e.reviewReasons.map((r) => (
                  <span key={r} className="badge reason">
                    {REVIEW_REASON_LABEL[r]}
                  </span>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                沒有符合條件的活動
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="row">
        {page > 1 && <Link href={qs(page - 1)}>← 上一頁</Link>}
        <span className="muted">
          第 {page} 頁／共 {Math.max(1, Math.ceil(total / PAGE_SIZE))} 頁
        </span>
        {page * PAGE_SIZE < total && <Link href={qs(page + 1)}>下一頁 →</Link>}
      </p>
    </>
  );
}
