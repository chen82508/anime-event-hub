import Link from 'next/link';
import type { ReactNode } from 'react';
import './site.css';

// 前台資料隨擷取排程更新；每次請求即時查詢（量級小，查詢皆走索引）
export const dynamic = 'force-dynamic';

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site">
      <header className="site-header">
        <div className="site-header-inner">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden>
              ◆
            </span>
            動漫活動一站看
          </Link>
          <nav className="site-nav" aria-label="主選單">
            <Link href="/">近期活動</Link>
            <Link href="/?view=calendar">月曆</Link>
          </nav>
        </div>
      </header>
      <main className="site-main">{children}</main>
      <footer className="site-footer">
        <p>
          本站彙整台灣動漫活動公開資訊，每筆活動皆附官方購票／原始公告連結；內容以官方公告為準。
        </p>
        <p className="muted">Anime Event Hub TW</p>
      </footer>
    </div>
  );
}
