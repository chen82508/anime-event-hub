import { linkLineByCode, unlinkLine } from '@aeh/db';
import { getDb } from '@/lib/db';
import { handleLineWebhook } from '@/lib/line-webhook';
import { webNotifyConfig } from '@/lib/notify-config';

/**
 * LINE Messaging API webhook（在 LINE Developers 後台設定為 https://<網域>/api/line/webhook）。
 * 簽章驗證失敗 → 401；未設定 LINE_CHANNEL_SECRET → 503（功能停用）。
 */
export async function POST(request: Request): Promise<Response> {
  const cfg = webNotifyConfig();
  if (!cfg.lineChannelSecret) return new Response('LINE 未設定', { status: 503 });

  const db = getDb();
  const rawBody = await request.text();
  const result = await handleLineWebhook(
    rawBody,
    request.headers.get('x-line-signature'),
    cfg.lineChannelSecret,
    {
      link: (code, userId) => linkLineByCode(db, code, userId),
      unlink: (userId) => unlinkLine(db, { lineUserId: userId }),
      async reply(replyToken, text) {
        if (!cfg.lineAccessToken) return;
        // 回覆失敗不影響綁定結果（LINE 會重送 webhook 的情況下綁定碼已失效，結果仍一致）
        await fetch('https://api.line.me/v2/bot/message/reply', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.lineAccessToken}`,
          },
          body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => undefined);
      },
    },
  );
  return new Response(result.status === 200 ? 'OK' : 'Bad request', { status: result.status });
}
