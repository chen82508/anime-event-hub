/** 審核原因代碼（tech-spec §4.3）。任一原因存在即不得自動上架（C4）。 */
export const REVIEW_REASONS = [
  'missing_date',
  'ambiguous_date',
  'missing_venue',
  'unknown_venue',
  'outside_taiwan',
  'possible_duplicate',
  'type_unresolved',
  'below_scale_threshold',
  'parse_error',
  'source_changed',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  missing_date: '缺少日期',
  ambiguous_date: '日期無法唯一判定',
  missing_venue: '缺少場館且非線上活動',
  unknown_venue: '場館不在字典中',
  outside_taiwan: '疑似非台灣舉辦',
  possible_duplicate: '疑似與既有活動重複',
  type_unresolved: '無法判定活動類型',
  below_scale_threshold: '未達規模門檻',
  parse_error: '解析失敗',
  source_changed: '已發布活動的來源內容變動',
};
