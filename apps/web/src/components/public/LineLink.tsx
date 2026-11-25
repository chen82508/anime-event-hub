'use client';

import { useState, useTransition } from 'react';
import {
  createLineLinkCodeAction,
  simulateLineLinkAction,
  unlinkLineAction,
} from '@/app/(public)/actions';

/**
 * LINE 官方帳號綁定：產生 6 碼綁定碼 → 使用者加好友後傳「綁定 XXXXXX」。
 * 網站端看不到 LINE 帳號資訊，只記錄 LINE 平台給的 userId。
 */
export function LineLink({
  linked,
  addFriendUrl,
  configured,
  allowSimulation,
}: {
  linked: boolean;
  addFriendUrl: string | null;
  /** 是否已設定 LINE channel（未設定時只能在本機模擬） */
  configured: boolean;
  allowSimulation: boolean;
}) {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<void>) => {
    setError(null);
    startTransition(fn);
  };

  if (linked) {
    return (
      <div className="channel-row">
        <p className="channel-status is-on">已綁定 LINE：通知會傳到你的 LINE。</p>
        <button
          type="button"
          className="btn btn-outline"
          disabled={pending}
          onClick={() =>
            run(async () => {
              await unlinkLineAction();
            })
          }
        >
          解除 LINE 綁定
        </button>
      </div>
    );
  }

  if (!configured && !allowSimulation) {
    return <p className="channel-status">LINE 通知尚未開放。</p>;
  }

  return (
    <div className="channel-row">
      {code ? (
        <div className="link-code-box">
          <ol className="steps">
            <li>
              {addFriendUrl ? (
                <a href={addFriendUrl} target="_blank" rel="noopener noreferrer">
                  加入 LINE 官方帳號好友 ↗
                </a>
              ) : (
                '加入 LINE 官方帳號好友'
              )}
            </li>
            <li>
              在聊天室傳送：
              <code className="link-code" aria-label={`綁定 ${code.code.split('').join(' ')}`}>
                綁定 {code.code}
              </code>
            </li>
          </ol>
          <p className="field-hint">
            綁定碼 10 分鐘內有效（至{' '}
            {new Date(code.expiresAt).toLocaleTimeString('zh-TW', {
              timeZone: 'Asia/Taipei',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
            ）。完成後重新整理此頁即可看到綁定狀態。
          </p>
          {allowSimulation && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const r = await simulateLineLinkAction(code.code);
                  if (!r.ok) setError(r.error);
                })
              }
            >
              🧪 本機模擬：直接完成綁定
            </button>
          )}
        </div>
      ) : (
        <p className="channel-status">
          尚未綁定。綁定後，通知會由 LINE 官方帳號傳給你（不會取得你的好友名單或聊天內容）。
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className={code ? 'btn btn-outline' : 'btn btn-primary'}
        disabled={pending}
        onClick={() =>
          run(async () => {
            const r = await createLineLinkCodeAction();
            if (r.ok) setCode({ code: r.code, expiresAt: r.expiresAt });
            else setError(r.error);
          })
        }
      >
        {code ? '重新產生綁定碼' : '取得 LINE 綁定碼'}
      </button>
    </div>
  );
}
