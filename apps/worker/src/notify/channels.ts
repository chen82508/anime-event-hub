/**
 * 站外推播管道。
 * - console（本機預設，NOTIFY_MODE=console）：只寫 log，投遞標為 simulated，不需要任何金鑰
 * - web_push：VAPID ＋ RFC 8291 加密（web-push 套件）
 * - line：LINE Messaging API push message（X-Line-Retry-Key 讓重試不會重複送）
 * 管道錯誤只影響該筆投遞，不會中斷整個 notify 工作。
 */
import { createHash } from 'node:crypto';
import type { NotifyChannel } from '@aeh/core';
import type { DeliveryOutcome, DueDelivery } from '@aeh/db';
import { isAllowedPushEndpoint, toLineText, toPushPayload, type ChannelMessage } from '@aeh/notify';
import type { Logger } from 'pino';
import { sendNotification } from 'web-push';

export interface ChannelSender {
  readonly channel: NotifyChannel;
  readonly mode: 'console' | 'live';
  send(d: DueDelivery): Promise<DeliveryOutcome>;
}

export function messageOf(d: DueDelivery): ChannelMessage {
  const n = d.notification;
  return { title: n.title, body: n.body, path: n.path, tag: n.dedupeKey };
}

export function consoleSender(
  channel: NotifyChannel,
  logger: Logger,
  baseUrl: string,
  note?: string,
): ChannelSender {
  return {
    channel,
    mode: 'console',
    async send(d) {
      const m = messageOf(d);
      logger.info(
        {
          channel,
          deliveryId: d.id,
          target: channel === 'line' ? `${d.target.slice(0, 6)}…` : d.target,
          ...(note ? { note } : {}),
          message: channel === 'line' ? toLineText(m, baseUrl) : JSON.parse(toPushPayload(m)),
        },
        '［模擬推播］',
      );
      return { status: 'simulated' };
    },
  };
}

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  /** mailto: 或 https: 聯絡資訊（推播服務出問題時聯絡用） */
  subject: string;
}

type SendNotification = typeof sendNotification;

export function webPushSender(
  cfg: WebPushConfig,
  send: SendNotification = sendNotification,
): ChannelSender {
  return {
    channel: 'web_push',
    mode: 'live',
    async send(d) {
      if (!d.push) return { status: 'gone', error: '推播訂閱已刪除' };
      // 網站寫入時已檢查；這裡再擋一次（DB 被直接寫入時也不會對內網發請求）
      if (!isAllowedPushEndpoint(d.push.endpoint))
        return { status: 'gone', error: '推播端點不在允許的推播服務清單' };
      try {
        await send(
          { endpoint: d.push.endpoint, keys: { p256dh: d.push.p256dh, auth: d.push.auth } },
          toPushPayload(messageOf(d)),
          {
            vapidDetails: {
              subject: cfg.subject,
              publicKey: cfg.publicKey,
              privateKey: cfg.privateKey,
            },
            TTL: 24 * 3600,
            urgency: 'normal',
            timeout: 10_000,
          },
        );
        return { status: 'sent' };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        const msg = `${status ?? 'network'}: ${(err as Error).message}`;
        // 404/410：訂閱已失效（使用者取消通知權限或瀏覽器清除）
        if (status === 404 || status === 410) return { status: 'gone', error: msg };
        return { status: 'retry', error: msg };
      }
    },
  };
}

/** 由投遞 id 推得固定的 UUID，作為 LINE 的 X-Line-Retry-Key（同一筆重試不會重複送達） */
export function retryKeyOf(deliveryId: number): string {
  const h = createHash('sha256').update(`aeh-delivery:${deliveryId}`).digest('hex');
  // 版本 4 格式（第 13 位為 4、第 17 位為 8–b）
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function lineSender(
  cfg: { accessToken: string; baseUrl: string },
  doFetch: typeof fetch = fetch,
): ChannelSender {
  return {
    channel: 'line',
    mode: 'live',
    async send(d) {
      let res: Response;
      try {
        res = await doFetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.accessToken}`,
            'x-line-retry-key': retryKeyOf(d.id),
          },
          body: JSON.stringify({
            to: d.target,
            messages: [{ type: 'text', text: toLineText(messageOf(d), cfg.baseUrl) }],
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        return { status: 'retry', error: `network: ${(err as Error).message}` };
      }
      // 409：同一 retry key 已被接受過 → 視為已送達
      if (res.ok || res.status === 409) return { status: 'sent' };
      const text = (await res.text().catch(() => '')).slice(0, 300);
      return { status: 'retry', error: `${res.status}: ${text}` };
    },
  };
}

export interface ChannelEnv {
  mode: 'console' | 'live';
  baseUrl: string;
  webPush?: WebPushConfig;
  lineAccessToken?: string;
}

/** 依設定組出各管道；live 模式下缺金鑰的管道退回模擬並警告 */
export function createChannels(
  env: ChannelEnv,
  logger: Logger,
): Record<NotifyChannel, ChannelSender> {
  const log = logger.child({ component: 'notify' });
  if (env.mode === 'console') {
    return {
      web_push: consoleSender('web_push', log, env.baseUrl),
      line: consoleSender('line', log, env.baseUrl),
    };
  }
  if (!env.webPush) log.warn('NOTIFY_MODE=live 但未設定 WEB_PUSH_VAPID_*，瀏覽器推播改為模擬');
  if (!env.lineAccessToken)
    log.warn('NOTIFY_MODE=live 但未設定 LINE_CHANNEL_ACCESS_TOKEN，LINE 改為模擬');
  return {
    web_push: env.webPush
      ? webPushSender(env.webPush)
      : consoleSender('web_push', log, env.baseUrl, '未設定 VAPID 金鑰'),
    line: env.lineAccessToken
      ? lineSender({ accessToken: env.lineAccessToken, baseUrl: env.baseUrl })
      : consoleSender('line', log, env.baseUrl, '未設定 LINE token'),
  };
}
