'use client';

import { useOptimistic, useState, useTransition } from 'react';
import { toggleFollowAction, type FollowTarget } from '@/app/(public)/actions';

/** 訂閱標籤／活動類型：有新活動上架時通知 */
export function FollowButton({
  target,
  name,
  initial,
  size = 'md',
}: {
  target: FollowTarget;
  /** 顯示名稱（標籤名或類型名） */
  name: string;
  initial: boolean;
  size?: 'sm' | 'md';
}) {
  const [following, setFollowing] = useState(initial);
  const [optimistic, setOptimistic] = useOptimistic(following);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !optimistic;
    setError(null);
    startTransition(async () => {
      setOptimistic(next);
      const r = await toggleFollowAction(target, next);
      if (r.ok) setFollowing(next);
      else setError(r.error);
    });
  }

  return (
    <button
      type="button"
      className={`follow-btn follow-${size}${optimistic ? ' is-on' : ''}`}
      aria-pressed={optimistic}
      title={error ?? (optimistic ? `取消訂閱「${name}」` : `訂閱「${name}」：有新活動時通知我`)}
      onClick={toggle}
      disabled={pending}
    >
      <span aria-hidden>{optimistic ? '✓' : '＋'}</span>
      {optimistic ? `已訂閱 ${name}` : `訂閱 ${name}`}
    </button>
  );
}
