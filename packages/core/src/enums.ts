/**
 * 領域 enum（tech-spec §5）。
 * 以 `as const` tuple 為單一事實來源：zod schema、Drizzle pgEnum、UI 標籤都由此衍生。
 */

// ── 活動類型 ──────────────────────────────────────────────
export const EVENT_TYPES = [
  'concert',
  'fan_meeting',
  'exhibition',
  'popup_cafe',
  'doujin',
  'expo',
  'other',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  concert: '演唱會',
  fan_meeting: '見面會',
  exhibition: '展覽',
  popup_cafe: '快閃店・咖啡廳',
  doujin: '同人展',
  expo: '綜合動漫展',
  other: '其他',
};

// ── 地區 ──────────────────────────────────────────────────
export const REGIONS = ['north', 'central', 'south', 'east', 'islands', 'online'] as const;
export type Region = (typeof REGIONS)[number];

export const REGION_LABEL: Record<Region, string> = {
  north: '北部',
  central: '中部',
  south: '南部',
  east: '東部',
  islands: '離島',
  online: '線上',
};

// ── 縣市（正規名稱一律用「台」）與地區對照（✅ D3）─────────
export const CITY_REGION = {
  基隆市: 'north',
  台北市: 'north',
  新北市: 'north',
  桃園市: 'north',
  新竹市: 'north',
  新竹縣: 'north',
  宜蘭縣: 'north',
  苗栗縣: 'central',
  台中市: 'central',
  彰化縣: 'central',
  南投縣: 'central',
  雲林縣: 'central',
  嘉義市: 'south',
  嘉義縣: 'south',
  台南市: 'south',
  高雄市: 'south',
  屏東縣: 'south',
  花蓮縣: 'east',
  台東縣: 'east',
  澎湖縣: 'islands',
  金門縣: 'islands',
  連江縣: 'islands',
} as const satisfies Record<string, Exclude<Region, 'online'>>;

export type TaiwanCity = keyof typeof CITY_REGION;
export const TAIWAN_CITIES = Object.keys(CITY_REGION) as [TaiwanCity, ...TaiwanCity[]];

export function regionOfCity(city: TaiwanCity): Exclude<Region, 'online'> {
  return CITY_REGION[city];
}

// ── 活動狀態 ──────────────────────────────────────────────
export const EVENT_STATUSES = [
  'pending_review',
  'published',
  'hidden',
  'cancelled',
  'ended',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  pending_review: '待審',
  published: '已發布',
  hidden: '隱藏',
  cancelled: '已取消',
  ended: '已結束',
};

// ── 來源 ──────────────────────────────────────────────────
/** 已規劃的來源；其它代理商待 PoC 後決定（D7），新增時於此登記。拓元、ibon 暫緩（C10）。 */
export const SOURCE_IDS = [
  'kktix',
  'cwt',
  'muse',
  'ff',
  'mightymedia',
  'tica',
  'comic_exhibition',
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SOURCE_KINDS = ['agency', 'ticketing', 'doujin', 'expo'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const CRAWL_SCHEDULES = ['daily', 'weekly'] as const;
export type CrawlSchedule = (typeof CRAWL_SCHEDULES)[number];

export const CRAWL_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type CrawlRunStatus = (typeof CRAWL_RUN_STATUSES)[number];

// ── 標籤 ──────────────────────────────────────────────────
export const TAG_KINDS = ['work', 'agency', 'voice_actor', 'artist'] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export const TAG_KIND_LABEL: Record<TagKind, string> = {
  work: '作品',
  agency: '代理商',
  voice_actor: '聲優',
  artist: '歌手・團體',
};

/** 標籤來源：來源推論 → 字典比對 → 人工補標（C5） */
export const TAG_ORIGINS = ['source', 'dict', 'manual'] as const;
export type TagOrigin = (typeof TAG_ORIGINS)[number];
