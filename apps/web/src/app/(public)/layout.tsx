import { countUnread } from '@aeh/db';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getDb } from '@/lib/db';
import { currentSubscriber } from '@/lib/subscriber';
import './site.css';

// 前台資料隨擷取排程更新；每次請求即時查詢（量級小，查詢皆走索引）
export const dynamic = 'force-dynamic';

export default async function PublicLayout({ children }: { children: ReactNode }) {
  // 版面層的錯誤不會被同層 error.tsx 接住：未讀數查不到時不顯示徽章，頁面照常渲染
  const unread = await currentSubscriber()
    .then((sub) => (sub ? countUnread(getDb(), sub.id) : 0))
    .catch(() => 0);
  return (
    <div className="site">
      <a href="#main" className="skip-link">
        跳到主要內容
      </a>
      <header className="site-header">
        <div className="site-header-inner">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden>
              ★
            </span>
            <span className="brand-text">動漫活動一站看</span>
          </Link>
          <nav className="site-nav" aria-label="主選單">
            <Link href="/" className="nav-home">
              近期活動
            </Link>
            <Link href="/?view=calendar">月曆</Link>
            <Link href="/me" className="nav-me">
              我的追蹤
              {unread > 0 && (
                <span className="nav-badge" aria-label={`${unread} 則未讀通知`}>
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </Link>
          </nav>
        </div>
      </header>
      <main id="main" className="site-main">
        {children}
      </main>
      <footer className="site-footer">
        <p>
          本站彙整台灣動漫活動公開資訊，每筆活動皆附官方購票／原始公告連結；內容以官方公告為準。
        </p>
        <p className="muted">Anime Event Hub TW</p>
      </footer>
    </div>
  );
}
