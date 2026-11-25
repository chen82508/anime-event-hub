import type { CrawlSchedule, SourceId } from '@aeh/core';

export interface SourceRow {
  id: SourceId;
  enabled: boolean;
  schedule: CrawlSchedule;
}

/**
 * 要擷取的來源：只取 enabled；指定 schedule 時只取該頻率（年度大展每週 1 次，C8）。
 * 排程程序與 CLI `--schedule`（GitHub Actions）共用，確保兩邊的擷取頻率一致。
 */
export function selectSources(rows: readonly SourceRow[], schedule?: CrawlSchedule): SourceId[] {
  return rows
    .filter((s) => s.enabled && (schedule === undefined || s.schedule === schedule))
    .map((s) => s.id);
}
