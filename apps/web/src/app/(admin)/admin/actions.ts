'use server';

/**
 * 審核後台的 Server Actions。每個操作都寫 audit_log（由 @aeh/db repository 處理）；
 * 欄位修改會寫入 locked_fields，之後的重新擷取不會覆寫（R7）。
 */
import {
  CITY_REGION,
  EVENT_TYPES,
  REVIEW_REASONS,
  REVIEW_REASON_LABEL,
  TAIWAN_CITIES,
  type EventStatus,
  type ReviewReason,
} from '@aeh/core';
import {
  PublishBlockedError,
  addAlias,
  addManualTag,
  applyAdminEdit,
  createVenue,
  mergeEvents,
  publishEvent,
  removeTag,
  resolveReviewReasons,
  setEventStatus,
  type AdminFieldChanges,
} from '@aeh/db';
import { dedupKey } from '@aeh/dedup';
import { normalizeTitle, taipeiDateTime } from '@aeh/normalize';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { currentActor, retagPendingEvents } from '@/lib/admin';
import { getDb } from '@/lib/db';

const Id = z.coerce.number().int().positive();
const optionalText = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? null : v.trim()));
const optionalInt = optionalText
  .transform((v) => (v === null ? null : Number(v)))
  .pipe(z.number().int('須為整數').nonnegative().nullable());
const date = optionalText.pipe(z.iso.date().nullable());
const time = optionalText.pipe(
  z
    .string()
    .regex(/^\d{2}:\d{2}$/, '時間格式為 HH:mm')
    .nullable(),
);

const EditSchema = z.object({
  id: Id,
  title: z.string().trim().min(1, '標題不可為空'),
  type: z.union([z.enum(EVENT_TYPES), z.literal('')]).transform((v) => (v === '' ? null : v)),
  startDate: date,
  startTime: time,
  endDate: date,
  endTime: time,
  venueId: optionalInt,
  isOnline: z
    .literal('on')
    .optional()
    .transform((v) => v === 'on'),
  city: z.union([z.enum(TAIWAN_CITIES), z.literal('')]).transform((v) => (v === '' ? null : v)),
  priceMin: optionalInt,
  priceMax: optionalInt,
  isFree: z
    .literal('on')
    .optional()
    .transform((v) => v === 'on'),
  saleDate: date,
  saleTime: time,
});

function back(id: number, msg: string, kind: 'ok' | 'error' = 'ok'): never {
  redirect(`/admin/events/${id}?${kind}=${encodeURIComponent(msg)}`);
}

/** 單筆編輯：只把「實際有變」的欄位寫入並鎖定 */
export async function saveEventAction(formData: FormData): Promise<void> {
  const parsed = EditSchema.safeParse(Object.fromEntries(formData));
  const id = Number(formData.get('id'));
  if (!parsed.success) back(id, z.prettifyError(parsed.error), 'error');
  const f = parsed.data;

  const allDay = f.startTime === null;
  const startAt = f.startDate ? taipeiDateTime(f.startDate, f.startTime ?? '00:00') : null;
  let endAt: Date | null = null;
  if (f.endDate || f.endTime) {
    const d = f.endDate ?? f.startDate;
    if (!d) back(id, '有結束時間時必須有日期', 'error');
    // 23:59 一律存成 23:59:59（與解析器的「當日結束」慣例一致），避免未修改的表單被當成變更而鎖定
    const endTime = f.endTime ?? '23:59';
    endAt = taipeiDateTime(d, endTime, endTime === '23:59' ? 59 : 0);
  }
  if (startAt && endAt && endAt < startAt) back(id, '結束早於開始', 'error');
  if (f.priceMin !== null && f.priceMax !== null && f.priceMax < f.priceMin)
    back(id, '票價上限小於下限', 'error');

  const changes: AdminFieldChanges = {
    title: f.title,
    type: f.type,
    startAt,
    endAt,
    allDay,
    isOnline: f.isOnline,
    priceMin: f.isFree ? 0 : f.priceMin,
    priceMax: f.isFree ? 0 : f.priceMax,
    isFree: f.isFree,
    saleStartAt: f.saleDate ? taipeiDateTime(f.saleDate, f.saleTime ?? '00:00') : null,
  };
  if (!f.isOnline) {
    changes.venueId = f.venueId;
    // 指定場館時，縣市/地區由場館帶入（applyAdminEdit）；未指定場館才採用手選縣市
    if (f.venueId === null) {
      changes.city = f.city;
      changes.region = f.city ? CITY_REGION[f.city] : null;
    }
  }

  let changed: string[];
  try {
    ({ changed } = await applyAdminEdit(getDb(), {
      id,
      actor: await currentActor(),
      changes,
      deriveTitleNormalized: normalizeTitle,
      deriveDedupKey: dedupKey,
    }));
  } catch (err) {
    back(id, (err as Error).message, 'error');
  }
  revalidatePath('/admin');
  back(id, changed.length > 0 ? `已儲存並鎖定：${changed.join('、')}` : '沒有變更');
}

export async function publishAction(formData: FormData): Promise<void> {
  const id = Id.parse(formData.get('id'));
  try {
    await publishEvent(getDb(), { id, actor: await currentActor() });
  } catch (err) {
    if (err instanceof PublishBlockedError) {
      const labels = err.reasons.map((r) => REVIEW_REASON_LABEL[r as ReviewReason] ?? r);
      back(id, `無法發布，請先處理：${labels.join('、')}`, 'error');
    }
    throw err;
  }
  revalidatePath('/admin');
  back(id, '已發布');
}

const StatusSchema = z.enum(['pending_review', 'hidden', 'cancelled', 'ended']);
export async function setStatusAction(formData: FormData): Promise<void> {
  const id = Id.parse(formData.get('id'));
  const status = StatusSchema.parse(formData.get('status')) as Exclude<EventStatus, 'published'>;
  await setEventStatus(getDb(), { id, actor: await currentActor(), status });
  revalidatePath('/admin');
  back(id, '狀態已更新');
}

export async function resolveReasonsAction(formData: FormData): Promise<void> {
  const id = Id.parse(formData.get('id'));
  const reasons = z
    .array(z.enum(REVIEW_REASONS))
    .parse(formData.getAll('reason')) as ReviewReason[];
  if (reasons.length === 0) back(id, '請勾選要解除的原因', 'error');
  await resolveReviewReasons(getDb(), { id, actor: await currentActor(), reasons });
  revalidatePath('/admin');
  back(id, `已解除：${reasons.join('、')}`);
}

export async function addTagAction(formData: FormData): Promise<void> {
  const id = Id.parse(formData.get('id'));
  const tagId = Id.parse(formData.get('tagId'));
  await addManualTag(getDb(), { eventId: id, tagId, actor: await currentActor() });
  back(id, '已加標籤');
}

export async function removeTagAction(formData: FormData): Promise<void> {
  const id = Id.parse(formData.get('id'));
  const tagId = Id.parse(formData.get('tagId'));
  await removeTag(getDb(), { eventId: id, tagId, actor: await currentActor() });
  back(id, '已移除標籤');
}

/** 疑似重複：把本筆合併進指定活動（本筆刪除，來源與標籤移過去） */
export async function mergeIntoAction(formData: FormData): Promise<void> {
  const fromId = Id.parse(formData.get('id'));
  const intoId = Id.safeParse(formData.get('intoId'));
  if (!intoId.success) back(fromId, '請輸入要合併到的活動編號', 'error');
  try {
    await mergeEvents(getDb(), {
      fromId,
      intoId: intoId.data,
      actor: await currentActor(),
      deriveDedupKey: dedupKey,
    });
  } catch (err) {
    back(fromId, (err as Error).message, 'error');
  }
  revalidatePath('/admin');
  redirect(`/admin/events/${intoId.data}?ok=${encodeURIComponent(`已將 #${fromId} 合併進來`)}`);
}

// ── 字典快捷操作 ──────────────────────────────────────────

function dictBack(msg: string, kind: 'ok' | 'error' = 'ok'): never {
  redirect(`/admin/dictionaries?${kind}=${encodeURIComponent(msg)}`);
}

export async function addAliasAction(formData: FormData): Promise<void> {
  const parsed = z
    .object({
      entity: z.enum(['tag', 'venue']),
      targetId: Id,
      alias: z.string().trim().min(1, '別名不可為空'),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) dictBack(z.prettifyError(parsed.error), 'error');
  await addAlias(getDb(), {
    entity: parsed.data.entity,
    id: parsed.data.targetId,
    alias: parsed.data.alias,
    actor: await currentActor(),
  });
  revalidatePath('/admin/dictionaries');
  dictBack(`已新增別名「${parsed.data.alias}」；可按「重新標籤待審資料」套用`);
}

export async function createVenueAction(formData: FormData): Promise<void> {
  const parsed = z
    .object({
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug 須為小寫英數與連字號'),
      name: z.string().trim().min(1),
      city: z.enum(TAIWAN_CITIES),
      address: optionalText,
      aliases: optionalText,
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) dictBack(z.prettifyError(parsed.error), 'error');
  const v = parsed.data;
  try {
    await createVenue(getDb(), {
      slug: v.slug,
      name: v.name,
      city: v.city,
      address: v.address,
      aliases: v.aliases
        ? v.aliases
            .split(/[,、，]/)
            .map((a) => a.trim())
            .filter(Boolean)
        : [],
      actor: await currentActor(),
    });
  } catch (err) {
    dictBack(`新增失敗：${(err as Error).message}`, 'error');
  }
  revalidatePath('/admin/dictionaries');
  dictBack(`已新增場館「${v.name}」。記得同步到 data/dictionaries/venues.yaml，避免只存在 DB`);
}

export async function retagAction(): Promise<void> {
  const r = await retagPendingEvents(await currentActor());
  revalidatePath('/admin');
  dictBack(`已重新標籤 ${r.events} 筆待審資料：新增 ${r.tagsAdded} 個標籤、判定 ${r.typed} 筆類型`);
}
