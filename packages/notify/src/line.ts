/**
 * LINE 官方帳號（Messaging API）綁定流程的純函式部分：
 * 1. 網站產生一次性綁定碼（generateLinkCode）
 * 2. 使用者加好友後傳「綁定 ABC234」→ webhook 驗證簽章（verifyLineSignature）、解析指令（parseLineCommand）
 * 3. 綁定 userId；之後推播以 push message 送出
 * 回覆文字也是固定模板（LINE_REPLY）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** 去除易混淆字元（0/O、1/I/L） */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const LINK_CODE_LENGTH = 6;
const LINK_CODE_RE = new RegExp(`^[${LINK_CODE_ALPHABET}]{${LINK_CODE_LENGTH}}$`);

/** 以呼叫端提供的隨機位元組產生綁定碼（保持純函式，方便測試） */
export function generateLinkCode(random: Uint8Array): string {
  if (random.length < LINK_CODE_LENGTH) throw new Error('隨機位元組不足');
  let s = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i++) {
    s += LINK_CODE_ALPHABET[random[i]! % LINK_CODE_ALPHABET.length];
  }
  return s;
}

export function isLinkCode(s: string): boolean {
  return LINK_CODE_RE.test(s);
}

/** X-Line-Signature = base64(HMAC-SHA256(channelSecret, 原始 request body)) */
export function verifyLineSignature(
  rawBody: string,
  signature: string | null | undefined,
  channelSecret: string,
): boolean {
  if (!signature || !channelSecret) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** 測試／本機模擬用：產生與 LINE 平台相同的簽章 */
export function signLineBody(rawBody: string, channelSecret: string): string {
  return createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest('base64');
}

export type LineCommand = { kind: 'link'; code: string } | { kind: 'unlink' } | { kind: 'help' };

/**
 * 解析使用者傳給官方帳號的文字（NFKC 後不分大小寫）：
 * - 「綁定 ABC234」「綁定ABC234」「link abc234」或只傳綁定碼 → link
 * - 「解除綁定」「取消通知」「unlink」→ unlink
 * - 其它 → help（回覆使用說明）
 */
export function parseLineCommand(text: string): LineCommand {
  const s = text.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const upper = s.toUpperCase();
  if (/^(解除綁定|取消綁定|取消通知|UNLINK)$/.test(upper)) return { kind: 'unlink' };
  const m = /^(?:綁定|LINK)\s*([A-Z0-9]+)$/.exec(upper);
  const code = m ? m[1]! : upper;
  if (isLinkCode(code)) return { kind: 'link', code };
  return { kind: 'help' };
}

export const LINE_REPLY = {
  linked:
    '綁定完成！之後收藏活動的開賣／前一天提醒，以及訂閱標籤的新活動都會傳到這裡。\n傳「解除綁定」可隨時停止。',
  invalidCode: '綁定碼無效或已過期，請回到網站「我的追蹤」重新產生綁定碼（10 分鐘內有效）。',
  alreadyLinked: '這個 LINE 帳號已經綁定，不需要重複綁定。',
  unlinked: '已解除綁定，之後不會再透過 LINE 傳送通知。',
  notLinked: '這個 LINE 帳號目前沒有綁定。',
  help: '請到網站「我的追蹤」頁面取得 6 碼綁定碼，再傳「綁定 綁定碼」給我，例如：綁定 ABC234',
} as const;
