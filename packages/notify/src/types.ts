import type { EventType, NotificationKind } from '@aeh/core';

/** 產生通知所需的活動欄位（只用公開資訊） */
export interface NotifyEvent {
  id: number;
  /** 來源原文（C2） */
  title: string;
  type: EventType | null;
  startAt: Date | null;
  endAt: Date | null;
  allDay: boolean;
  isOnline: boolean;
  venueName: string | null;
  city: string | null;
  saleStartAt: Date | null;
}

/** 待寫入 DB 的通知（dedupeKey 唯一 → 重跑不重複） */
export interface NotificationDraft {
  subscriberId: number;
  kind: NotificationKind;
  eventId: number | null;
  dedupeKey: string;
  title: string;
  body: string;
  /** 站內相對路徑 */
  path: string;
}

export interface RenderedMessage {
  title: string;
  body: string;
  path: string;
}
