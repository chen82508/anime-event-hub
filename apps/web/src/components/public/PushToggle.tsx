'use client';

import { useEffect, useState, useTransition } from 'react';
import { removePushSubscriptionAction, savePushSubscriptionAction } from '@/app/(public)/actions';

type State =
  'checking' | 'unsupported' | 'not-configured' | 'denied' | 'off' | 'on' | 'needs-install';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIosSafariTab(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua);
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}

/**
 * 瀏覽器推播開關：註冊 /sw.js → 取得 PushSubscription → 存到伺服器。
 * iOS 需先「加入主畫面」才支援 Web Push（iOS 16.4+）。
 */
export function PushToggle({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [state, setState] = useState<State>('checking');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    void (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setState(isIosSafariTab() ? 'needs-install' : 'unsupported');
        return;
      }
      if (!vapidPublicKey) return setState('not-configured');
      if (Notification.permission === 'denied') return setState('denied');
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = await reg?.pushManager.getSubscription();
      setState(sub ? 'on' : 'off');
    })();
  }, [vapidPublicKey]);

  function enable() {
    setError(null);
    startTransition(async () => {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setState(permission === 'denied' ? 'denied' : 'off');
          return;
        }
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        const sub =
          (await reg.pushManager.getSubscription()) ??
          (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey!),
          }));
        const r = await savePushSubscriptionAction(sub.toJSON(), navigator.userAgent);
        if (!r.ok) {
          await sub.unsubscribe();
          setError(r.error);
          return;
        }
        setState('on');
      } catch (err) {
        setError(`無法開啟推播：${(err as Error).message}`);
      }
    });
  }

  function disable() {
    setError(null);
    startTransition(async () => {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await removePushSubscriptionAction(sub.endpoint);
        await sub.unsubscribe();
      }
      setState('off');
    });
  }

  const status: Record<State, string> = {
    checking: '檢查中…',
    unsupported: '這個瀏覽器不支援推播通知，可改用 LINE 接收。',
    'needs-install':
      'iPhone／iPad 請先用 Safari 的「分享 → 加入主畫面」，再從主畫面開啟本站來啟用推播。',
    // 開發指令只給開發者看；正式站未設定金鑰時與 LINE 區塊一致，只說尚未開放
    'not-configured':
      process.env.NODE_ENV === 'production'
        ? '瀏覽器推播尚未開放。'
        : '網站尚未設定推播金鑰（本機開發：執行 pnpm --filter @aeh/worker cli vapid）。',
    denied: '你已封鎖本站的通知，請到瀏覽器的網站設定中允許通知後再試。',
    off: '尚未開啟。開啟後，這個瀏覽器會收到新活動與開賣提醒。',
    on: '已開啟：這個瀏覽器會收到通知。',
  };

  return (
    <div className="channel-row">
      <p className={`channel-status${state === 'on' ? ' is-on' : ''}`} aria-live="polite">
        {status[state]}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {state === 'off' && (
        <button type="button" className="btn btn-primary" onClick={enable} disabled={pending}>
          {pending ? '設定中…' : '開啟瀏覽器推播'}
        </button>
      )}
      {state === 'on' && (
        <button type="button" className="btn btn-outline" onClick={disable} disabled={pending}>
          關閉這個瀏覽器的推播
        </button>
      )}
    </div>
  );
}
