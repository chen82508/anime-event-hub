/**
 * LINE webhook 處理（與 Next route 分開，方便以假的 DB 操作測試）。
 * 只處理三件事：文字指令（綁定／解除綁定／說明）、加好友（回覆說明）、封鎖（解除綁定）。
 * 不儲存使用者傳來的任何訊息內容。
 */
import { LINE_REPLY, parseLineCommand, verifyLineSignature } from '@aeh/notify';

export interface LineWebhookOps {
  link(code: string, lineUserId: string): Promise<'linked' | 'already_linked' | 'invalid_code'>;
  unlink(lineUserId: string): Promise<boolean>;
  /** 回覆（replyToken 1 分鐘內有效）；未設定 access token 時為 no-op */
  reply(replyToken: string, text: string): Promise<void>;
}

interface LineEvent {
  type?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
}

export type WebhookResult = { status: 200 | 401 | 400; handled: number };

export async function handleLineWebhook(
  rawBody: string,
  signature: string | null,
  secret: string,
  ops: LineWebhookOps,
): Promise<WebhookResult> {
  if (!verifyLineSignature(rawBody, signature, secret)) return { status: 401, handled: 0 };
  let events: LineEvent[];
  try {
    const parsed = JSON.parse(rawBody) as { events?: unknown };
    events = Array.isArray(parsed.events) ? (parsed.events as LineEvent[]) : [];
  } catch {
    return { status: 400, handled: 0 };
  }

  let handled = 0;
  for (const ev of events) {
    // 只處理一對一聊天（群組／多人聊天室不綁定）
    const userId = ev.source?.type === 'user' ? ev.source.userId : undefined;
    if (!userId) continue;
    const reply = (text: string) => (ev.replyToken ? ops.reply(ev.replyToken, text) : undefined);

    if (ev.type === 'unfollow') {
      await ops.unlink(userId);
      handled++;
    } else if (ev.type === 'follow') {
      await reply(LINE_REPLY.help);
      handled++;
    } else if (ev.type === 'message' && ev.message?.type === 'text' && ev.message.text) {
      const cmd = parseLineCommand(ev.message.text);
      if (cmd.kind === 'link') {
        const r = await ops.link(cmd.code, userId);
        await reply(
          r === 'linked'
            ? LINE_REPLY.linked
            : r === 'already_linked'
              ? LINE_REPLY.alreadyLinked
              : LINE_REPLY.invalidCode,
        );
      } else if (cmd.kind === 'unlink') {
        await reply((await ops.unlink(userId)) ? LINE_REPLY.unlinked : LINE_REPLY.notLinked);
      } else {
        await reply(LINE_REPLY.help);
      }
      handled++;
    }
  }
  return { status: 200, handled };
}
