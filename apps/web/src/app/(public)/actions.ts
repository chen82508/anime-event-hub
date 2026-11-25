'use server';

/**
 * 前台 Server Actions（Phase 3：收藏、訂閱、推播管道、通知設定）。
 * - 第一次收藏／訂閱時才建立匿名訪客（cookie），單純瀏覽不留任何資料
 * - 所有輸入以 zod 驗證；Next 對 Server Action 有 Origin 檢查（CSRF）
 */
import { randomBytes } from 'node:crypto';
import { EVENT_TYPES, TAG_KINDS } from '@aeh/core';
import {
  deletePushSubscription,
  deleteSubscriber,
  insertNotifications,
  linkLineByCode,
  markInboxRead,
  savePushSubscription,
  setFavorite,
  setLineLinkCode,
  setTagFollow,
  setTypeFollow,
  unlinkLine,
  updateSubscriberPrefs,
} from '@aeh/db';
import { generateLinkCode, isAllowedPushEndpoint, renderTest } from '@aeh/notify';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { LINE_LINK_CODE_TTL_MS, webNotifyConfig } from '@/lib/notify-config';
import { clearSubscriberCookie, currentSubscriber, ensureSubscriber } from '@/lib/subscriber';

export type ActionResult = { ok: true } | { ok: false; error: string };

const fail = (error: string): ActionResult => ({ ok: false, error });

function refresh(): void {
  // 前台頁面皆為動態渲染；重新整理整個前台的 RSC（收藏星號、未讀數）
  revalidatePath('/', 'layout');
}

const EventIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export async function toggleFavoriteAction(eventId: number, on: boolean): Promise<ActionResult> {
  const id = EventIdSchema.safeParse(eventId);
  if (!id.success || typeof on !== 'boolean') return fail('參數錯誤');
  const sub = await ensureSubscriber();
  const ok = await setFavorite(getDb(), sub.id, id.data, on);
  refresh();
  return ok ? { ok: true } : fail('找不到這個活動');
}

const FollowSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tag'),
    tagKind: z.enum(TAG_KINDS),
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .max(100),
  }),
  z.object({ kind: z.literal('type'), type: z.enum(EVENT_TYPES) }),
]);
export type FollowTarget = z.infer<typeof FollowSchema>;

export async function toggleFollowAction(target: FollowTarget, on: boolean): Promise<ActionResult> {
  const t = FollowSchema.safeParse(target);
  if (!t.success || typeof on !== 'boolean') return fail('參數錯誤');
  const sub = await ensureSubscriber();
  const db = getDb();
  if (t.data.kind === 'type') {
    await setTypeFollow(db, sub.id, t.data.type, on);
  } else if (!(await setTagFollow(db, sub.id, { kind: t.data.tagKind, slug: t.data.slug }, on))) {
    return fail('找不到這個標籤');
  }
  refresh();
  return { ok: true };
}

// ── Web Push ─────────────────────────────────────────────

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const PushSchema = z.object({
  endpoint: z.url().max(1000),
  keys: z.object({
    p256dh: z.string().regex(B64URL).max(200),
    auth: z.string().regex(B64URL).max(100),
  }),
});

export async function savePushSubscriptionAction(
  input: unknown,
  userAgent?: string,
): Promise<ActionResult> {
  const p = PushSchema.safeParse(input);
  if (!p.success) return fail('推播訂閱資料格式錯誤');
  if (!isAllowedPushEndpoint(p.data.endpoint)) return fail('不支援這個瀏覽器的推播服務');
  const sub = await ensureSubscriber();
  await savePushSubscription(getDb(), sub.id, {
    endpoint: p.data.endpoint,
    p256dh: p.data.keys.p256dh,
    auth: p.data.keys.auth,
    userAgent: userAgent?.slice(0, 200) ?? null,
  });
  refresh();
  return { ok: true };
}

export async function removePushSubscriptionAction(endpoint: string): Promise<ActionResult> {
  const sub = await currentSubscriber();
  if (!sub || typeof endpoint !== 'string') return { ok: true };
  await deletePushSubscription(getDb(), sub.id, endpoint);
  refresh();
  return { ok: true };
}

// ── LINE ─────────────────────────────────────────────────

export async function createLineLinkCodeAction(): Promise<
  { ok: true; code: string; expiresAt: string } | { ok: false; error: string }
> {
  const sub = await ensureSubscriber();
  const db = getDb();
  const expiresAt = new Date(Date.now() + LINE_LINK_CODE_TTL_MS);
  // 綁定碼有 UNIQUE 約束；極少數碰撞時重抽
  for (let i = 0; i < 5; i++) {
    const code = generateLinkCode(randomBytes(8));
    try {
      await setLineLinkCode(db, sub.id, code, expiresAt);
      refresh();
      return { ok: true, code, expiresAt: expiresAt.toISOString() };
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }
  return { ok: false, error: '請稍後再試' };
}

export async function unlinkLineAction(): Promise<ActionResult> {
  const sub = await currentSubscriber();
  if (sub) await unlinkLine(getDb(), { subscriberId: sub.id });
  refresh();
  return { ok: true };
}

/** 本機模擬：不經過 LINE 平台直接以綁定碼綁定一個假 userId（只在 console 模式＋非 production） */
export async function simulateLineLinkAction(code: string): Promise<ActionResult> {
  if (!webNotifyConfig().allowDevSimulation) return fail('只在本機模擬模式可用');
  const sub = await currentSubscriber();
  if (!sub || typeof code !== 'string') return fail('請先產生綁定碼');
  const r = await linkLineByCode(getDb(), code, `Udev${String(sub.id).padStart(8, '0')}`);
  refresh();
  return r === 'invalid_code' ? fail('綁定碼無效或已過期') : { ok: true };
}

// ── 設定、通知匣、資料刪除 ───────────────────────────────

export async function updatePrefsAction(formData: FormData): Promise<void> {
  const sub = await ensureSubscriber();
  await updateSubscriberPrefs(getDb(), sub.id, {
    notifyNewEvent: formData.get('notifyNewEvent') === 'on',
    notifySaleReminder: formData.get('notifySaleReminder') === 'on',
    notifyEventReminder: formData.get('notifyEventReminder') === 'on',
  });
  refresh();
}

export async function markInboxReadAction(): Promise<void> {
  const sub = await currentSubscriber();
  if (sub) await markInboxRead(getDb(), sub.id);
  refresh();
}

/** 測試通知：寫入通知匣並建立投遞，由 worker 的 notify 排程（每 5 分鐘）送出；不受勿擾時段限制 */
export async function sendTestNotificationAction(): Promise<ActionResult> {
  const sub = await ensureSubscriber();
  const r = await insertNotifications(getDb(), [
    {
      subscriberId: sub.id,
      kind: 'test',
      eventId: null,
      // 以分鐘為單位去重：一分鐘最多一則，避免連點洗版
      dedupeKey: `test:${sub.id}:${Math.floor(Date.now() / 60_000)}`,
      ...renderTest(),
    },
  ]);
  refresh();
  return r.notifications ? { ok: true } : fail('一分鐘內只能傳送一次測試通知');
}

export async function deleteMyDataAction(): Promise<void> {
  const sub = await currentSubscriber();
  if (sub) await deleteSubscriber(getDb(), sub.id);
  await clearSubscriberCookie();
  refresh();
}
