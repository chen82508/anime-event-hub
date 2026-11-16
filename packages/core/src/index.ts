// @aeh/core — 領域型別、zod schema、enum（EventType, Region, EventStatus…）
// 最底層套件：不得依賴其他 @aeh/* 套件、不得觸碰 DB 或網路。
// TODO(T1): enums.ts、schemas/event.ts、schemas/candidate.ts、review-reasons.ts，見 docs/tech-spec.md §7 T1
export { TIMEZONE } from './constants';
