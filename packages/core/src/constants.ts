/** 全系統唯一時區（tech-spec R1）：解析一律以台灣時間為準，DB 以 timestamptz(UTC) 儲存。 */
export const TIMEZONE = 'Asia/Taipei' as const;
