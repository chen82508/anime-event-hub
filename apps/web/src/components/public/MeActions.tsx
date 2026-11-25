'use client';

import { useState, useTransition } from 'react';
import { deleteMyDataAction, sendTestNotificationAction } from '@/app/(public)/actions';

export function TestNotificationButton({
  mode,
  showDevNotes,
}: {
  mode: 'console' | 'live';
  /** false（production）時不提 worker log 等開發細節 */
  showDevNotes: boolean;
}) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="inline-action">
      <button
        type="button"
        className="btn btn-outline btn-sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await sendTestNotificationAction();
            setMsg(
              r.ok
                ? {
                    ok: true,
                    text:
                      mode === 'live'
                        ? '已加入通知匣，推播會在 5 分鐘內送出。'
                        : showDevNotes
                          ? '已加入通知匣。本機模擬模式：worker 會在 5 分鐘內把推播內容寫到 log。'
                          : '已加入通知匣。',
                  }
                : { ok: false, text: r.error },
            );
          })
        }
      >
        傳送測試通知
      </button>
      {msg && (
        <span className={msg.ok ? 'form-ok' : 'form-error'} role="status">
          {msg.text}
        </span>
      )}
    </div>
  );
}

/** 刪除所有追蹤資料（確認後才送出） */
export function DeleteDataButton() {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="btn btn-danger"
      disabled={pending}
      onClick={() => {
        if (
          !window.confirm(
            '確定要刪除這個瀏覽器的所有收藏、訂閱、通知與推播設定嗎？刪除後無法復原。',
          )
        )
          return;
        startTransition(async () => {
          await deleteMyDataAction();
        });
      }}
    >
      {pending ? '刪除中…' : '刪除我的追蹤資料'}
    </button>
  );
}
