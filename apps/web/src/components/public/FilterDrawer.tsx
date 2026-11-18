'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';

/**
 * 行動版：篩選面板收在按鈕後（全螢幕抽屜）；寬螢幕：固定顯示於側欄（CSS 控制）。
 * 父層以搜尋字串為 key，套用篩選後會重新掛載而自動收合。
 */
export function FilterDrawer({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    // 抽屜開啟時鎖住背景捲動
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="btn btn-outline filter-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(true)}
      >
        篩選{count > 0 && <span className="count">{count}</span>}
      </button>
      <aside id={id} className={`filter-panel${open ? ' is-open' : ''}`} aria-label="篩選條件">
        <div className="filter-panel-head">
          <strong>篩選條件</strong>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setOpen(false)}
            aria-label="關閉篩選"
          >
            ✕
          </button>
        </div>
        {children}
      </aside>
      {open && <div className="filter-backdrop" onClick={() => setOpen(false)} aria-hidden />}
    </>
  );
}
