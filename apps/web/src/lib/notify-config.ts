import {
  DEFAULT_EVENT_REMINDER_HOUR,
  DEFAULT_SALE_LEAD_HOURS,
  parseQuietHours,
  type QuietHours,
} from '@aeh/notify';

/**
 * 網站端的推播設定（與 worker 共用根目錄 .env）。
 * 沒有任何金鑰時網站照常運作：收藏、訂閱、站內通知匣都可用，推播由 worker 以 console 模式模擬。
 */
export interface WebNotifyConfig {
  mode: 'console' | 'live';
  /** Web Push 公鑰（給瀏覽器訂閱用）；未設定 → 無法開啟瀏覽器推播 */
  vapidPublicKey: string | null;
  /** LINE 官方帳號 ID（@xxxx），用來產生加好友連結 */
  lineAccountId: string | null;
  lineChannelSecret: string | null;
  lineAccessToken: string | null;
  /** 本機模擬：可在「我的追蹤」直接模擬 LINE 綁定（production 一律關閉） */
  allowDevSimulation: boolean;
  /** 與 worker 相同的提醒設定（顯示說明文字用） */
  saleLeadHours: number;
  eventReminderHour: number;
  quietHours: QuietHours | null;
}

function intEnv(k: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[k]);
  return Number.isInteger(n) && n >= min && n <= max && process.env[k]?.trim() ? n : fallback;
}

function quietHoursEnv(): QuietHours | null {
  try {
    return parseQuietHours(process.env.NOTIFY_QUIET_HOURS ?? '23-8');
  } catch {
    return { start: 23, end: 8 };
  }
}

const v = (k: string) => {
  const s = process.env[k]?.trim();
  return s ? s : null;
};

export function webNotifyConfig(): WebNotifyConfig {
  const mode = process.env.NOTIFY_MODE === 'live' ? 'live' : 'console';
  return {
    mode,
    vapidPublicKey: v('WEB_PUSH_VAPID_PUBLIC_KEY'),
    lineAccountId: v('LINE_OFFICIAL_ACCOUNT_ID'),
    lineChannelSecret: v('LINE_CHANNEL_SECRET'),
    lineAccessToken: v('LINE_CHANNEL_ACCESS_TOKEN'),
    allowDevSimulation: mode === 'console' && process.env.NODE_ENV !== 'production',
    saleLeadHours: intEnv('NOTIFY_SALE_LEAD_HOURS', DEFAULT_SALE_LEAD_HOURS, 1, 168),
    eventReminderHour: intEnv('NOTIFY_EVENT_REMINDER_HOUR', DEFAULT_EVENT_REMINDER_HOUR, 0, 23),
    quietHours: quietHoursEnv(),
  };
}

/** LINE 加好友連結（@ 需編碼） */
export function lineAddFriendUrl(accountId: string): string {
  const id = accountId.startsWith('@') ? accountId : `@${accountId}`;
  return `https://line.me/R/ti/p/${encodeURIComponent(id)}`;
}

/** 綁定碼有效時間 */
export const LINE_LINK_CODE_TTL_MS = 10 * 60_000;
