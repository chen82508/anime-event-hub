/**
 * 匿名訂閱者身分（Phase 3；MVP 不做會員）。
 * cookie 存 32 bytes 隨機 token，DB 只存其 SHA-256。只在伺服器端使用。
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  createSubscriber,
  findSubscriberByTokenHash,
  touchSubscriber,
  type SubscriberRow,
} from '@aeh/db';
import { cookies } from 'next/headers';
import { getDb } from './db';

export const SUBSCRIBER_COOKIE = 'aeh_sid';
/** 瀏覽器允許的 cookie 最長效期約 400 天 */
const MAX_AGE = 400 * 24 * 3600;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 讀取目前訪客（Server Component 可用；沒有 cookie 或無效時回傳 null，不會建立） */
export async function currentSubscriber(): Promise<SubscriberRow | null> {
  const token = (await cookies()).get(SUBSCRIBER_COOKIE)?.value;
  if (!token || !TOKEN_RE.test(token)) return null;
  return findSubscriberByTokenHash(getDb(), hashToken(token));
}

/** 取得或建立訪客（只能在 Server Action / Route Handler 呼叫：需要寫 cookie） */
export async function ensureSubscriber(): Promise<SubscriberRow> {
  const existing = await currentSubscriber();
  const db = getDb();
  if (existing) {
    await touchSubscriber(db, existing.id);
    // 每次使用都延長效期（滑動）
    await setCookie((await cookies()).get(SUBSCRIBER_COOKIE)!.value);
    return existing;
  }
  const token = randomBytes(32).toString('base64url');
  const row = await createSubscriber(db, hashToken(token));
  await setCookie(token);
  return row;
}

async function setCookie(token: string): Promise<void> {
  (await cookies()).set(SUBSCRIBER_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE,
  });
}

export async function clearSubscriberCookie(): Promise<void> {
  (await cookies()).delete(SUBSCRIBER_COOKIE);
}
