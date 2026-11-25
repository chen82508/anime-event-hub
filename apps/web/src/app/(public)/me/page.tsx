import { EVENT_TYPES, EVENT_TYPE_LABEL, NOTIFICATION_KIND_LABEL, TAG_KIND_LABEL } from '@aeh/core';
import {
  getFollows,
  listFavoriteEventIds,
  listInbox,
  listPublicEvents,
  listPushEndpoints,
} from '@aeh/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EventList } from '@/components/public/EventList';
import { FollowButton } from '@/components/public/FollowButton';
import { LineLink } from '@/components/public/LineLink';
import { DeleteDataButton, TestNotificationButton } from '@/components/public/MeActions';
import { PushToggle } from '@/components/public/PushToggle';
import { getDb } from '@/lib/db';
import { lineAddFriendUrl, webNotifyConfig } from '@/lib/notify-config';
import { formatMonthDay, formatTime } from '@/lib/public/format';
import { currentSubscriber } from '@/lib/subscriber';
import { markInboxReadAction, updatePrefsAction } from '../actions';

export const metadata: Metadata = {
  title: '我的追蹤｜Anime Event Hub TW',
  robots: { index: false },
};

/** 前台不提供「其他」類型的訂閱 */
const FOLLOWABLE_TYPES = EVENT_TYPES.filter((t) => t !== 'other');

export default async function MePage() {
  const db = getDb();
  const now = new Date();
  const cfg = webNotifyConfig();
  const sub = await currentSubscriber();

  const [favoriteIds, follows, inbox, endpoints] = sub
    ? await Promise.all([
        listFavoriteEventIds(db, sub.id),
        getFollows(db, sub.id),
        listInbox(db, sub.id),
        listPushEndpoints(db, sub.id),
      ])
    : [[], { tags: [], types: [] }, [], []];
  const favorites = favoriteIds.length
    ? (await listPublicEvents(db, { ids: favoriteIds, includeEnded: true, now })).rows
    : [];
  const unread = inbox.filter((n) => !n.readAt).length;
  const hasChannel = endpoints.length > 0 || !!sub?.lineUserId;

  return (
    <div className="me">
      <header className="me-head">
        <h1>我的追蹤</h1>
        <p className="muted">
          不需註冊：收藏與訂閱存在這個瀏覽器（清除 cookie 後會遺失）。綁定 LINE
          或開啟推播後，就能在活動開賣前與前一天收到提醒。
        </p>
      </header>

      <nav className="me-toc" aria-label="本頁目錄">
        <a href="#inbox">通知{unread > 0 ? `（${unread}）` : ''}</a>
        <a href="#favorites">收藏 {favorites.length}</a>
        <a href="#follows">訂閱 {follows.tags.length + follows.types.length}</a>
        <a href="#channels">通知管道</a>
        <a href="#settings">設定</a>
      </nav>

      {!hasChannel && (favorites.length > 0 || follows.tags.length + follows.types.length > 0) && (
        <p className="notice">
          還沒有開啟任何通知管道，提醒只會出現在下方的通知匣。
          <a href="#channels">開啟瀏覽器推播或綁定 LINE →</a>
        </p>
      )}

      <section id="inbox" className="me-section">
        <div className="section-head">
          <h2>通知匣</h2>
          {unread > 0 && (
            <form action={markInboxReadAction}>
              <button type="submit" className="btn btn-ghost btn-sm">
                全部標為已讀
              </button>
            </form>
          )}
        </div>
        {inbox.length ? (
          <ul className="inbox">
            {inbox.map((n) => (
              <li key={n.id} className={n.readAt ? '' : 'is-unread'}>
                <Link href={n.path} className="inbox-link">
                  <span className="inbox-meta">
                    <span className={`inbox-kind kind-${n.kind}`}>
                      {NOTIFICATION_KIND_LABEL[n.kind]}
                    </span>
                    <time dateTime={n.createdAt.toISOString()}>
                      {formatMonthDay(n.createdAt)} {formatTime(n.createdAt)}
                    </time>
                  </span>
                  <strong className="inbox-title">{n.title}</strong>
                  <span className="inbox-body">{n.body}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-inline">
            目前沒有通知。收藏活動或訂閱標籤後，新活動上架與開賣提醒會出現在這裡。
          </p>
        )}
      </section>

      <section id="favorites" className="me-section">
        <div className="section-head">
          <h2>收藏的活動</h2>
        </div>
        {favorites.length ? (
          <EventList
            events={favorites}
            now={now}
            favoriteIds={new Set(favoriteIds)}
            groupByMonth={false}
          />
        ) : (
          <p className="empty-inline">
            還沒有收藏。在活動卡片右上角按 ☆，就會在開賣前 {cfg.saleLeadHours}{' '}
            小時與活動前一天提醒你。
            <Link href="/">去逛逛近期活動 →</Link>
          </p>
        )}
      </section>

      <section id="follows" className="me-section">
        <div className="section-head">
          <h2>訂閱</h2>
        </div>
        <p className="field-hint">
          訂閱的標籤或類型有新活動上架時，會通知你（同時有多個新活動會合併成一則）。
        </p>
        {follows.tags.length > 0 && (
          <div className="follow-group">
            <h3>代理商・作品・聲優・歌手</h3>
            <div className="follow-row">
              {follows.tags.map((t) => (
                <FollowButton
                  key={`${t.kind}:${t.slug}`}
                  target={{ kind: 'tag', tagKind: t.kind, slug: t.slug }}
                  name={`${TAG_KIND_LABEL[t.kind]}：${t.name}`}
                  initial
                  size="sm"
                />
              ))}
            </div>
          </div>
        )}
        <div className="follow-group">
          <h3>活動類型</h3>
          <div className="follow-row">
            {FOLLOWABLE_TYPES.map((t) => (
              <FollowButton
                key={t}
                target={{ kind: 'type', type: t }}
                name={EVENT_TYPE_LABEL[t]}
                initial={follows.types.includes(t)}
                size="sm"
              />
            ))}
          </div>
        </div>
        {follows.tags.length === 0 && (
          <p className="empty-inline">
            想追特定作品、聲優或代理商？在活動頁的「相關標籤」或篩選後的列表按「＋ 訂閱」。
          </p>
        )}
      </section>

      <section id="channels" className="me-section">
        <div className="section-head">
          <h2>通知管道</h2>
          {sub && <TestNotificationButton mode={cfg.mode} />}
        </div>
        {cfg.mode === 'console' && (
          <p className="dev-note">
            🧪 本機模擬模式（NOTIFY_MODE=console）：推播不會真的送出，內容會寫在 worker 的
            log；通知匣照常運作。
          </p>
        )}
        <div className="channel">
          <h3>🔔 瀏覽器推播</h3>
          <PushToggle vapidPublicKey={cfg.vapidPublicKey} />
          {endpoints.length > 1 && (
            <p className="field-hint">已在 {endpoints.length} 個瀏覽器／裝置開啟推播。</p>
          )}
        </div>
        <div className="channel">
          <h3>💬 LINE 官方帳號</h3>
          <LineLink
            linked={!!sub?.lineUserId}
            addFriendUrl={cfg.lineAccountId ? lineAddFriendUrl(cfg.lineAccountId) : null}
            configured={!!cfg.lineChannelSecret}
            allowSimulation={cfg.allowDevSimulation}
          />
        </div>
      </section>

      <section id="settings" className="me-section">
        <div className="section-head">
          <h2>通知設定</h2>
        </div>
        <form action={updatePrefsAction} className="prefs">
          <label className="switch">
            <input
              type="checkbox"
              name="notifyNewEvent"
              defaultChecked={sub?.notifyNewEvent ?? true}
            />
            <span>訂閱的標籤／類型有新活動上架</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              name="notifySaleReminder"
              defaultChecked={sub?.notifySaleReminder ?? true}
            />
            <span>收藏的活動開賣前 {cfg.saleLeadHours} 小時</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              name="notifyEventReminder"
              defaultChecked={sub?.notifyEventReminder ?? true}
            />
            <span>收藏的活動舉辦前一天（{cfg.eventReminderHour}:00）</span>
          </label>
          {cfg.quietHours && (
            <p className="field-hint">
              {cfg.quietHours.start}:00 到 {cfg.quietHours.end}:00 不會推播，會延到{' '}
              {cfg.quietHours.end}:00 再送（通知匣不受影響）。
            </p>
          )}
          <div>
            <button type="submit" className="btn btn-primary">
              儲存設定
            </button>
          </div>
        </form>
      </section>

      {sub && (
        <section className="me-section me-danger">
          <h2>資料與隱私</h2>
          <p className="field-hint">
            我們只存收藏、訂閱、推播端點與 LINE 的使用者識別碼，不取得姓名、Email 或好友名單。
          </p>
          <DeleteDataButton />
        </section>
      )}
    </div>
  );
}
