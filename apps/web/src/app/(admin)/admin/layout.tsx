import Link from 'next/link';
import type { ReactNode } from 'react';
import './admin.css';

export const metadata = { title: '審核後台｜Anime Event Hub TW' };
// 後台資料即時查詢，不做靜態快取
export const dynamic = 'force-dynamic';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="admin">
      <header className="admin-header">
        <strong>Anime Event Hub TW 審核後台</strong>
        <nav>
          <Link href="/admin">待審列表</Link>
          <Link href="/admin?status=published">已發布</Link>
          <Link href="/admin/dictionaries">字典快捷操作</Link>
        </nav>
      </header>
      <main className="admin-main">{children}</main>
    </div>
  );
}
