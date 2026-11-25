/**
 * 「新活動上架」比對：活動的標籤／類型 ∩ 訪客的訂閱 → 每位訪客一則通知（或合併摘要）。
 * 規則固定、與輸入順序無關（輸出依 subscriberId、eventId 排序），方便重跑比對。
 */
import { EVENT_TYPE_LABEL, hasEnded, type EventType } from '@aeh/core';
import { renderNewEvent, renderNewEventDigest } from './templates';
import type { NotificationDraft, NotifyEvent } from './types';

export interface NewEventCandidate extends NotifyEvent {
  tags: readonly { id: number; name: string }[];
}

export interface SubscriberFollows {
  subscriberId: number;
  notifyNewEvent: boolean;
  tagIds: readonly number[];
  types: readonly EventType[];
}

export interface NewEventMatch {
  event: NewEventCandidate;
  /** 命中的訂閱名稱（標籤依活動上的順序，類型放最後） */
  reasons: string[];
}

/** 每位訪客命中的活動；已結束的活動不通知 */
export function matchNewEvents(
  events: readonly NewEventCandidate[],
  follows: readonly SubscriberFollows[],
  now: Date,
): Map<number, NewEventMatch[]> {
  const live = [...events]
    .filter((e) => !hasEnded(e.startAt, e.endAt, now))
    .sort((a, b) => a.id - b.id);
  const out = new Map<number, NewEventMatch[]>();
  for (const f of [...follows].sort((a, b) => a.subscriberId - b.subscriberId)) {
    if (!f.notifyNewEvent) continue;
    const tagSet = new Set(f.tagIds);
    const typeSet = new Set(f.types);
    for (const e of live) {
      const reasons = e.tags.filter((t) => tagSet.has(t.id)).map((t) => t.name);
      if (e.type && typeSet.has(e.type)) reasons.push(EVENT_TYPE_LABEL[e.type]);
      if (!reasons.length) continue;
      const list = out.get(f.subscriberId);
      if (list) list.push({ event: e, reasons });
      else out.set(f.subscriberId, [{ event: e, reasons }]);
    }
  }
  return out;
}

export const DEFAULT_DIGEST_THRESHOLD = 3;

/**
 * 命中筆數 ≤ digestThreshold → 每筆各一則；超過 → 合併成一則摘要（避免一次收到十幾則推播）。
 */
export function buildNewEventNotifications(
  matches: Map<number, NewEventMatch[]>,
  now: Date,
  opts: { digestThreshold?: number } = {},
): NotificationDraft[] {
  const threshold = opts.digestThreshold ?? DEFAULT_DIGEST_THRESHOLD;
  const drafts: NotificationDraft[] = [];
  for (const [subscriberId, list] of [...matches.entries()].sort(([a], [b]) => a - b)) {
    if (list.length > threshold) {
      const ids = list.map((m) => m.event.id);
      drafts.push({
        subscriberId,
        kind: 'new_event_digest',
        eventId: null,
        dedupeKey: `new_event_digest:${subscriberId}:${ids.join(',')}`,
        ...renderNewEventDigest(list.map((m) => m.event)),
      });
      continue;
    }
    for (const m of list) {
      drafts.push({
        subscriberId,
        kind: 'new_event',
        eventId: m.event.id,
        dedupeKey: `new_event:${subscriberId}:${m.event.id}`,
        ...renderNewEvent(m.event, m.reasons, now),
      });
    }
  }
  return drafts;
}
