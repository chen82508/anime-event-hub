import type { CrawlSchedule, RawEventCandidate, SourceId } from '@aeh/core';

/** parse 時的外部資訊（純函式不得自行取得時間） */
export interface ParseContext {
  /** 擷取日（台灣日曆日 YYYY-MM-DD）；公告沒有發布日時作為缺年份推論的基準 */
  fetchedOn: string;
}

export interface ListItem {
  /** 來源內穩定 ID（R8：優先用 URL 中的 ID） */
  externalId: string;
  url: string;
  /** 列表頁已有足夠資訊時直接給候選；否則為 null，由 pipeline 抓 detailUrl 後呼叫 parseDetail */
  candidate: RawEventCandidate | null;
  detailUrl?: string;
  /** 非活動公告等被過濾者（R11），記錄於 source_item.skip_reason */
  skipReason?: string;
}

/**
 * 擷取器（tech-spec §4.1）。parseList / parseDetail 必須是純函式：不碰 DB、網路、時間。
 */
export interface Scraper {
  id: SourceId;
  schedule: CrawlSchedule;
  /**
   * fixture 是否取自真實頁面。`synthetic` 表示來源結構尚未確認（例如官網無法連線），
   * pipeline 預設不執行，以免把錯誤解析的資料寫入 DB。
   */
  fixtureStatus: 'real' | 'synthetic';
  listUrls(): string[];
  parseList(body: string, url: string, ctx: ParseContext): ListItem[];
  parseDetail?(body: string, url: string, ctx: ParseContext): RawEventCandidate | null;
}
