import {
  EVENT_STATUS_LABEL,
  EVENT_TYPES,
  EVENT_TYPE_LABEL,
  REGION_LABEL,
  REVIEW_REASON_LABEL,
  TAG_KIND_LABEL,
  TAIWAN_CITIES,
} from '@aeh/core';
import { getEventDetail, listAudit, listTags, listVenues, possibleDuplicatesOf } from '@aeh/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { formatWhen, inputDate, inputTime } from '@/lib/format';
import {
  addTagAction,
  mergeIntoAction,
  publishAction,
  removeTagAction,
  resolveReasonsAction,
  saveEventAction,
  setStatusAction,
} from '../../actions';

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function EventDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const { id: idParam } = await params;
  const sp = await searchParams;
  const id = Number(idParam);
  if (!Number.isInteger(id)) notFound();
  const db = getDb();
  const detail = await getEventDetail(db, id);
  if (!detail) notFound();
  const { event: e, venue, sources, tags } = detail;
  const [venues, allTags, audit, duplicates] = await Promise.all([
    listVenues(db),
    listTags(db),
    listAudit(db, 'event', id),
    possibleDuplicatesOf(db, e, { windowDays: 3, minSimilarity: 0.3 }),
  ]);
  const locked = new Set<string>(e.lockedFields);
  const lock = (f: string) => (locked.has(f) ? ' 🔒' : '');
  const ok = one(sp.ok);
  const error = one(sp.error);

  return (
    <>
      <p>
        <Link href="/admin">← 回列表</Link>
      </p>
      {ok && <div className="flash ok">{ok}</div>}
      {error && <div className="flash error">{error}</div>}

      <h1>
        #{e.id} {e.title}
      </h1>
      <div className="row">
        <span className={`badge status-${e.status}`}>{EVENT_STATUS_LABEL[e.status]}</span>
        {e.reviewReasons.map((r) => (
          <span key={r} className="badge reason">
            {REVIEW_REASON_LABEL[r]}
          </span>
        ))}
        {e.yearInferred && <span className="badge">年份為推論</span>}
        {e.lockedFields.length > 0 && (
          <span className="badge lock">🔒 已鎖定：{e.lockedFields.join('、')}</span>
        )}
      </div>

      <div className="grid2">
        <div>
          <form className="card form" action={saveEventAction}>
            <input type="hidden" name="id" value={e.id} />
            <label className="wide">
              標題（保留原文）{lock('title')}
              <input name="title" defaultValue={e.title} required />
            </label>
            <label>
              類型{lock('type')}
              <select name="type" defaultValue={e.type ?? ''}>
                <option value="">（未判定）</option>
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EVENT_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              開始日期（台灣時間）{lock('startAt')}
              <input type="date" name="startDate" defaultValue={inputDate(e.startAt)} />
            </label>
            <label>
              開始時刻（空白 = 全天）
              <input type="time" name="startTime" defaultValue={inputTime(e.startAt, e.allDay)} />
            </label>
            <label>
              結束日期{lock('endAt')}
              <input type="date" name="endDate" defaultValue={inputDate(e.endAt)} />
            </label>
            <label>
              結束時刻
              <input type="time" name="endTime" defaultValue={e.allDay ? '' : inputTime(e.endAt)} />
            </label>
            <label>
              場館{lock('venueId')}
              <select name="venueId" defaultValue={e.venueId ?? ''}>
                <option value="">（未指定）</option>
                {venues.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.city}｜{v.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              縣市（未指定場館時）{lock('city')}
              <select name="city" defaultValue={e.city ?? ''}>
                <option value="">（未知）</option>
                {TAIWAN_CITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>
                <input type="checkbox" name="isOnline" defaultChecked={e.isOnline} /> 線上活動
                {lock('isOnline')}
              </span>
            </label>
            <label>
              票價下限{lock('priceMin')}
              <input type="number" min={0} name="priceMin" defaultValue={e.priceMin ?? ''} />
            </label>
            <label>
              票價上限{lock('priceMax')}
              <input type="number" min={0} name="priceMax" defaultValue={e.priceMax ?? ''} />
            </label>
            <label>
              <span>
                <input type="checkbox" name="isFree" defaultChecked={e.isFree} /> 免費
                {lock('isFree')}
              </span>
            </label>
            <label>
              開賣日期{lock('saleStartAt')}
              <input type="date" name="saleDate" defaultValue={inputDate(e.saleStartAt)} />
            </label>
            <label>
              開賣時刻
              <input type="time" name="saleTime" defaultValue={inputTime(e.saleStartAt)} />
            </label>
            <div className="wide row">
              <button type="submit" className="primary">
                儲存（修改的欄位會鎖定，之後重新擷取不覆寫）
              </button>
            </div>
          </form>

          <div className="card">
            <h2>目前內容</h2>
            <p>
              {formatWhen(e.startAt, e.allDay)}
              {e.endAt && <> ～ {formatWhen(e.endAt, e.allDay)}</>}
              <br />
              {e.isOnline ? '線上' : (venue?.name ?? '場館未知')}
              {e.city && `（${e.city}）`}
              {e.region && `｜${REGION_LABEL[e.region]}`}
              <br />
              場館原文：<span className="muted">{e.venueRaw ?? '—'}</span>
              <br />
              票價：
              {e.isFree ? '免費' : e.priceMin !== null ? `NT$${e.priceMin}–${e.priceMax}` : '—'}
            </p>
            {e.reviewNotes.length > 0 && (
              <>
                <h2>解析說明</h2>
                <ul>
                  {e.reviewNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="card">
            <h2>來源（{sources.length}）</h2>
            {sources.map((s) => (
              <details key={s.sourceItemId}>
                <summary>
                  {s.isPrimary && <span className="badge">主要</span>} {s.sourceName}｜
                  <a href={s.url} target="_blank" rel="noreferrer">
                    原始連結
                  </a>
                  <span className="muted">（external_id: {s.externalId}）</span>
                </summary>
                <pre>{JSON.stringify(s.parsed, null, 2)}</pre>
              </details>
            ))}
          </div>
        </div>

        <div>
          <div className="card">
            <h2>發布與狀態</h2>
            <form action={publishAction} className="row">
              <input type="hidden" name="id" value={e.id} />
              <button type="submit" className="primary" disabled={e.status === 'published'}>
                發布
              </button>
            </form>
            <form action={setStatusAction} className="row" style={{ marginTop: 8 }}>
              <input type="hidden" name="id" value={e.id} />
              <select name="status" defaultValue="hidden">
                <option value="hidden">隱藏</option>
                <option value="cancelled">已取消</option>
                <option value="pending_review">退回待審</option>
                <option value="ended">已結束</option>
              </select>
              <button type="submit">變更狀態</button>
            </form>
          </div>

          {e.reviewReasons.length > 0 && (
            <form className="card" action={resolveReasonsAction}>
              <h2>人工解除審核原因</h2>
              <p className="muted">
                補齊欄位後相關原因會自動解除；「疑似重複」「來源變動」等需確認後手動解除。
              </p>
              <input type="hidden" name="id" value={e.id} />
              {e.reviewReasons.map((r) => (
                <label key={r} style={{ display: 'block' }}>
                  <input type="checkbox" name="reason" value={r} /> {REVIEW_REASON_LABEL[r]}
                </label>
              ))}
              <button type="submit">解除勾選的原因</button>
            </form>
          )}

          {duplicates.length > 0 && (
            <div className="card">
              <h2>可能重複的活動</h2>
              <ul>
                {duplicates.map((d) => (
                  <li key={d.eventId}>
                    <Link href={`/admin/events/${d.eventId}`}>
                      #{d.eventId} {d.title}
                    </Link>{' '}
                    <span className="muted">
                      相似度 {d.similarity.toFixed(2)}｜{EVENT_STATUS_LABEL[d.status]}
                    </span>
                  </li>
                ))}
              </ul>
              <form action={mergeIntoAction} className="row">
                <input type="hidden" name="id" value={e.id} />
                <input
                  type="number"
                  name="intoId"
                  placeholder="合併到 #"
                  defaultValue={duplicates[0]?.eventId}
                  style={{ width: 110 }}
                />
                <button type="submit" className="danger">
                  把本筆合併過去
                </button>
              </form>
            </div>
          )}

          <div className="card">
            <h2>標籤</h2>
            <div className="chips">
              {tags.map((t) => (
                <form key={t.id} action={removeTagAction}>
                  <input type="hidden" name="id" value={e.id} />
                  <input type="hidden" name="tagId" value={t.id} />
                  <span className="badge" title={t.matchedBy ?? ''}>
                    {TAG_KIND_LABEL[t.kind]}：{t.name}
                    <span className="muted">（{t.origin}）</span>
                    <button
                      type="submit"
                      style={{ border: 0, padding: '0 2px' }}
                      aria-label={`移除 ${t.name}`}
                    >
                      ×
                    </button>
                  </span>
                </form>
              ))}
              {tags.length === 0 && <span className="muted">尚無標籤</span>}
            </div>
            <form action={addTagAction} className="row" style={{ marginTop: 8 }}>
              <input type="hidden" name="id" value={e.id} />
              <select name="tagId" required defaultValue="">
                <option value="" disabled>
                  選擇標籤
                </option>
                {allTags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {TAG_KIND_LABEL[t.kind]}｜{t.name}
                  </option>
                ))}
              </select>
              <button type="submit">加上</button>
            </form>
            <p className="muted">
              字典沒有的作品/聲優請到 <Link href="/admin/dictionaries">字典快捷操作</Link>{' '}
              新增別名（不自動建立新標籤）。
            </p>
          </div>

          <div className="card">
            <h2>操作紀錄</h2>
            <ul>
              {audit.map((a) => (
                <li key={a.id}>
                  <span className="muted">{formatWhen(a.at, false)}</span> {a.actor}：{a.action}
                </li>
              ))}
              {audit.length === 0 && <li className="muted">尚無紀錄</li>}
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
