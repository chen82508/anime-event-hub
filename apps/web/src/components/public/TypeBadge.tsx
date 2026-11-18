import { EVENT_TYPE_LABEL, type EventType } from '@aeh/core';

export function TypeBadge({ type }: { type: EventType }) {
  return <span className={`type-badge type-${type}`}>{EVENT_TYPE_LABEL[type]}</span>;
}
