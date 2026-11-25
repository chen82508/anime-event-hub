'use client';

import { useOptimistic, useState, useTransition } from 'react';
import { toggleFavoriteAction } from '@/app/(public)/actions';

/**
 * 收藏（☆／★）。樂觀更新：點下立即變色，失敗時回復並顯示原因。
 * variant="icon" 用在卡片右上角；"full" 用在詳情頁（含文字說明）。
 */
export function FavoriteButton({
  eventId,
  title,
  initial,
  variant = 'icon',
}: {
  eventId: number;
  title: string;
  initial: boolean;
  variant?: 'icon' | 'full';
}) {
  const [saved, setSaved] = useState(initial);
  const [optimistic, setOptimistic] = useOptimistic(saved);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !optimistic;
    setError(null);
    startTransition(async () => {
      setOptimistic(next);
      const r = await toggleFavoriteAction(eventId, next);
      if (r.ok) setSaved(next);
      else setError(r.error);
    });
  }

  const label = optimistic ? `取消收藏「${title}」` : `收藏「${title}」`;
  return (
    <span className={`fav fav-${variant}`}>
      <button
        type="button"
        className={`fav-btn${optimistic ? ' is-on' : ''}`}
        aria-pressed={optimistic}
        aria-label={variant === 'icon' ? label : undefined}
        title={label}
        onClick={toggle}
        disabled={pending}
      >
        <span aria-hidden className="fav-star">
          {optimistic ? '★' : '☆'}
        </span>
        {variant === 'full' && <span>{optimistic ? '已收藏' : '收藏'}</span>}
      </button>
      {variant === 'full' && (
        <span className="fav-hint">
          {error ?? (optimistic ? '開賣前與活動前一天會提醒你' : '收藏後可收到開賣／活動前提醒')}
        </span>
      )}
      {variant === 'icon' && error && (
        <span role="alert" className="sr-only">
          {error}
        </span>
      )}
    </span>
  );
}
