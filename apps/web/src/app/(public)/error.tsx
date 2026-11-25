'use client';

import Link from 'next/link';

/** 前台錯誤畫面（DB 暫時無法連線等）：提供重試，不顯示技術細節 */
export default function PublicError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="empty" role="alert">
      <p className="empty-emoji" aria-hidden>
        😵
      </p>
      <h1>頁面暫時無法顯示</h1>
      <p>可能是系統正在更新資料，請稍後再試。</p>
      <p className="empty-actions">
        <button type="button" className="btn btn-primary" onClick={reset}>
          重新載入
        </button>
        <Link href="/" className="btn btn-outline">
          回到活動列表
        </Link>
      </p>
    </div>
  );
}
