/**
 * 管線編排（tech-spec §4、T9）：
 *   fetch（PoliteClient）→ raw_snapshot → parse（純函式）→ normalize/validate → tag → dedup → upsert event ＋ event_source
 *
 * - 同一快照重跑兩次結果相同（idempotent）：source_item 以 (source_id, external_id) upsert，
 *   內容 hash 未變就不重新處理；reparse 會強制重算，但結果相同時不產生任何變更。
 * - 單一來源失敗不影響其他來源（runSources 逐一執行、各自捕捉錯誤）。
 * - 單一 process、序列執行，不使用佇列（C11）。
 */
import { createHash } from 'node:crypto';
import {
  REVIEW_REASONS,
  RawEventCandidateSchema,
  type LockableField,
  type RawEventCandidate,
  type SourceId,
} from '@aeh/core';
import {
  CrawlInProgressError,
  addEventTags,
  attachEventSource,
  finishCrawlRun,
  findDedupCandidates,
  getEvent,
  getSnapshot,
  getSource,
  insertEvent,
  insertSnapshot,
  isPrimarySource,
  loadMatchingDictionaries,
  recentCrawlRuns,
  snapshotsOfLatestRun,
  startCrawlRun,
  updateEvent,
  updateSourceAfterRun,
  upsertSourceItem,
  writeAudit,
  type CrawlCounters,
  type Database,
  type EventRow,
  type MatchingDictionaries,
  type Tx,
} from '@aeh/db';
import {
  DEFAULT_DEDUP_THRESHOLDS,
  decideDuplicate,
  dedupKey,
  planSourceUpdate,
  type DedupThresholds,
  type EventFields,
} from '@aeh/dedup';
import { decodeBody, type FetchResult, type PoliteClient, type SnapshotStore } from '@aeh/http';
import { VenueResolver, taipeiDateString } from '@aeh/normalize';
import {
  DEFAULT_SCALE_THRESHOLDS,
  normalizeCandidate,
  type ListItem,
  type ScaleThresholds,
  type Scraper,
} from '@aeh/scrapers';
import { Tagger } from '@aeh/tagger';
import type { Logger } from 'pino';
import { evaluateRunAlerts, type Alerter } from './alerts';

export interface PipelineConfig {
  scale: ScaleThresholds;
  dedup: DedupThresholds;
  /** 允許執行 fixtureStatus = synthetic 的擷取器（結構未驗證） */
  allowUnverified: boolean;
  emptyRunThreshold: number;
  missingRateJump: number;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  scale: DEFAULT_SCALE_THRESHOLDS,
  dedup: DEFAULT_DEDUP_THRESHOLDS,
  allowUnverified: false,
  emptyRunThreshold: 3,
  missingRateJump: 0.3,
};

export interface PipelineDeps {
  db: Database;
  store: SnapshotStore;
  /** reparse 不需要網路 */
  client: PoliteClient | null;
  scrapers: Partial<Record<SourceId, Scraper>>;
  alerter: Alerter;
  logger: Logger;
  config: PipelineConfig;
}

export type RunMode =
  | { kind: 'crawl'; dryRun: boolean }
  /** 以既存快照重跑解析（不打網路）；未指定 snapshotIds 時取最近一次成功擷取的快照 */
  | { kind: 'reparse'; snapshotIds?: number[] };

export interface ItemReport {
  externalId: string;
  title: string | null;
  action:
    | 'created'
    | 'merged'
    | 'possible_duplicate'
    | 'updated'
    | 'unchanged'
    | 'skipped'
    | 'parse_error'
    | 'dry_run';
  eventId: number | null;
  status: string | null;
  reviewReasons: string[];
  notes: string[];
}

export interface RunSummary {
  sourceId: SourceId;
  crawlRunId: number | null;
  status: 'succeeded' | 'failed' | 'skipped';
  error?: string;
  counters: CrawlCounters;
  items: ItemReport[];
}

const ACTOR = 'pipeline';
const DUPLICATE_NOTE_PREFIX = '疑似與活動 #';
/** 與 @aeh/db splitEventSource 寫入的說明一致 */
const SPLIT_NOTE_PREFIX = '由活動 #';

/** key 排序後的 JSON（內容 hash 用，確保同內容同 hash） */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function emptyCounters(): CrawlCounters {
  return {
    itemsFound: 0,
    itemsNew: 0,
    itemsUpdated: 0,
    itemsPendingReview: 0,
    itemsSkipped: 0,
    itemsMissingFields: 0,
  };
}

interface Page {
  body: string;
  url: string;
  fetchedOn: string;
  snapshotId: number | null;
}

function eventFields(e: EventRow): EventFields {
  return {
    title: e.title,
    titleNormalized: e.titleNormalized,
    type: e.type,
    startAt: e.startAt,
    endAt: e.endAt,
    allDay: e.allDay,
    yearInferred: e.yearInferred,
    venueId: e.venueId,
    venueRaw: e.venueRaw,
    isOnline: e.isOnline,
    city: e.city,
    region: e.region,
    priceMin: e.priceMin,
    priceMax: e.priceMax,
    isFree: e.isFree,
    saleStartAt: e.saleStartAt,
  };
}

/** 執行單一來源。錯誤會記錄在 crawl_run 並告警，回傳 status = failed（不往外拋） */
export async function runSource(
  deps: PipelineDeps,
  sourceId: SourceId,
  mode: RunMode,
): Promise<RunSummary> {
  const log = deps.logger.child({ sourceId, mode: mode.kind });
  const counters = emptyCounters();
  const items: ItemReport[] = [];
  const dryRun = mode.kind === 'crawl' && mode.dryRun;

  const scraper = deps.scrapers[sourceId];
  if (!scraper) {
    return {
      sourceId,
      crawlRunId: null,
      status: 'skipped',
      error: '尚未實作此來源的擷取器',
      counters,
      items,
    };
  }
  if (scraper.fixtureStatus === 'synthetic' && !deps.config.allowUnverified) {
    log.warn('擷取器結構未驗證（synthetic fixture），略過；確認後以 --allow-unverified 執行');
    return {
      sourceId,
      crawlRunId: null,
      status: 'skipped',
      error: '擷取器結構未驗證',
      counters,
      items,
    };
  }

  let crawlRunId: number | null = null;
  if (!dryRun) {
    try {
      crawlRunId = await startCrawlRun(deps.db, sourceId, false);
    } catch (err) {
      if (err instanceof CrawlInProgressError) {
        log.warn(err.message);
        return {
          sourceId,
          crawlRunId: null,
          status: 'skipped',
          error: err.message,
          counters,
          items,
        };
      }
      throw err;
    }
  }
  try {
    const pages =
      mode.kind === 'crawl'
        ? await fetchPages(deps, scraper, crawlRunId, dryRun)
        : await loadPages(deps, sourceId, mode.snapshotIds);
    const dicts = await loadMatchingDictionaries(deps.db);
    const venues = new VenueResolver(dicts.venues, dicts.cities);
    const tagger = new Tagger({ typeKeywords: dicts.typeKeywords, tags: dicts.tags });

    // 多個列表頁（如 KKTIX 多關鍵字）可能出現同一項目，以 externalId 去重
    const seen = new Set<string>();
    for (const page of pages) {
      let list: ListItem[];
      try {
        list = scraper.parseList(page.body, page.url, { fetchedOn: page.fetchedOn });
      } catch (err) {
        throw new Error(`解析列表失敗（${page.url}）：${(err as Error).message}`, { cause: err });
      }
      for (const item of list) {
        if (seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        counters.itemsFound++;
        const report = await processItem(deps, {
          scraper,
          item,
          page,
          venues,
          tagger,
          dryRun,
          force: mode.kind === 'reparse',
          crawlRunId,
        });
        items.push(report);
        if (report.action === 'created' || report.action === 'possible_duplicate')
          counters.itemsNew++;
        if (report.action === 'updated' || report.action === 'merged') counters.itemsUpdated++;
        if (report.action === 'skipped' || report.action === 'parse_error') counters.itemsSkipped++;
        if (report.status === 'pending_review') counters.itemsPendingReview++;
        if (report.reviewReasons.some((r) => r === 'missing_date' || r === 'missing_venue'))
          counters.itemsMissingFields++;
      }
    }

    if (crawlRunId !== null) {
      await finishCrawlRun(deps.db, crawlRunId, { status: 'succeeded', counters });
      await afterRun(deps, sourceId, { succeeded: true, counters, crawlRunId });
    }
    log.info({ crawlRunId, ...counters }, '來源處理完成');
    return { sourceId, crawlRunId, status: 'succeeded', counters, items };
  } catch (err) {
    const message = (err as Error).message;
    log.error({ err }, '來源處理失敗');
    if (crawlRunId !== null) {
      await finishCrawlRun(deps.db, crawlRunId, { status: 'failed', counters, error: message });
      await afterRun(deps, sourceId, { succeeded: false, counters, crawlRunId, error: message });
    }
    return { sourceId, crawlRunId, status: 'failed', error: message, counters, items };
  }
}

/** 依序執行多個來源；任一來源失敗不影響其它來源 */
export async function runSources(
  deps: PipelineDeps,
  sourceIds: SourceId[],
  mode: RunMode,
): Promise<RunSummary[]> {
  const out: RunSummary[] = [];
  for (const id of sourceIds) {
    try {
      out.push(await runSource(deps, id, mode));
    } catch (err) {
      // runSource 本身已捕捉錯誤；這裡是最後防線（例如 DB 連線中斷）
      deps.logger.error({ err, sourceId: id }, '來源執行發生未預期錯誤');
      out.push({
        sourceId: id,
        crawlRunId: null,
        status: 'failed',
        error: (err as Error).message,
        counters: emptyCounters(),
        items: [],
      });
    }
  }
  return out;
}

/** 回應快照登記到 raw_snapshot（T5 DoD：所有回應都要登記）；dry-run 不寫 DB */
async function registerSnapshot(
  deps: PipelineDeps,
  res: FetchResult,
  dryRun: boolean,
): Promise<number | null> {
  if (dryRun) return null;
  return insertSnapshot(deps.db, {
    sourceId: res.snapshot.sourceId,
    crawlRunId: res.snapshot.crawlRunId,
    url: res.snapshot.url,
    fetchedAt: res.snapshot.fetchedAt,
    httpStatus: res.snapshot.httpStatus,
    contentType: res.snapshot.contentType,
    contentHash: res.snapshot.contentHash,
    storagePath: res.snapshot.storagePath,
    encoding: res.snapshot.encoding,
  });
}

async function fetchPages(
  deps: PipelineDeps,
  scraper: Scraper,
  crawlRunId: number | null,
  dryRun: boolean,
): Promise<Page[]> {
  if (!deps.client) throw new Error('crawl 需要 PoliteClient');
  const pages: Page[] = [];
  for (const url of scraper.listUrls()) {
    const res = await deps.client.get(url, { sourceId: scraper.id, crawlRunId });
    const snapshotId = await registerSnapshot(deps, res, dryRun);
    if (!res.ok) throw new Error(`HTTP ${res.status}：${res.finalUrl}`);
    pages.push({
      body: res.text,
      url: res.finalUrl,
      fetchedOn: taipeiDateString(res.fetchedAt),
      snapshotId,
    });
  }
  return pages;
}

async function loadPages(
  deps: PipelineDeps,
  sourceId: SourceId,
  snapshotIds?: number[],
): Promise<Page[]> {
  const rows = snapshotIds
    ? (await Promise.all(snapshotIds.map((id) => getSnapshot(deps.db, id)))).filter(
        (r) => r !== null,
      )
    : await snapshotsOfLatestRun(deps.db, sourceId);
  if (rows.length === 0)
    throw new Error('沒有可重跑的快照（是否已超過保留期限，或尚未成功擷取過？）');
  const pages: Page[] = [];
  for (const s of rows) {
    if (s.sourceId !== sourceId)
      throw new Error(`快照 ${s.id} 屬於 ${s.sourceId}，不是 ${sourceId}`);
    if (s.httpStatus !== null && (s.httpStatus < 200 || s.httpStatus >= 300)) continue;
    const bytes = await deps.store.read(s.storagePath);
    pages.push({
      body: decodeBody(bytes, s.contentType).text,
      url: s.url,
      fetchedOn: taipeiDateString(s.fetchedAt),
      snapshotId: s.id,
    });
  }
  return pages;
}

interface ItemContext {
  scraper: Scraper;
  item: ListItem;
  page: Page;
  venues: VenueResolver<MatchingDictionaries['venues'][number]>;
  tagger: Tagger<MatchingDictionaries['tags'][number]>;
  dryRun: boolean;
  /** reparse：內容未變也重算（結果相同時不會產生變更） */
  force: boolean;
  crawlRunId: number | null;
}

async function processItem(deps: PipelineDeps, ctx: ItemContext): Promise<ItemReport> {
  const { item, page } = ctx;
  let snapshotId = page.snapshotId;
  let candidate: RawEventCandidate | null = item.candidate;
  let skipReason = item.skipReason ?? null;

  if (!candidate && !skipReason && item.detailUrl && ctx.scraper.parseDetail) {
    if (!deps.client) {
      skipReason = 'reparse 不支援詳細頁（需重新擷取）';
    } else {
      const res = await deps.client.get(item.detailUrl, {
        sourceId: ctx.scraper.id,
        crawlRunId: ctx.crawlRunId,
      });
      snapshotId = (await registerSnapshot(deps, res, ctx.dryRun)) ?? snapshotId;
      if (!res.ok) {
        skipReason = `詳細頁 HTTP ${res.status}`;
      } else {
        candidate = ctx.scraper.parseDetail(res.text, res.finalUrl, { fetchedOn: page.fetchedOn });
      }
    }
  }
  if (!candidate && !skipReason) skipReason = '沒有可用的候選資料';

  let parseError: string | null = null;
  if (candidate) {
    const parsed = RawEventCandidateSchema.safeParse(candidate);
    if (!parsed.success) {
      parseError = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      candidate = null;
    } else {
      candidate = parsed.data;
    }
  }

  const base = { externalId: item.externalId, title: candidate?.title ?? null };
  const result = candidate
    ? normalizeCandidate(candidate, {
        venues: ctx.venues,
        tagger: ctx.tagger,
        fetchedOn: page.fetchedOn,
        scale: deps.config.scale,
      })
    : null;

  if (ctx.dryRun) {
    return {
      ...base,
      action: result ? 'dry_run' : parseError ? 'parse_error' : 'skipped',
      eventId: null,
      status: result?.status ?? null,
      reviewReasons: result?.event.reviewReasons ?? [],
      notes: result?.notes ?? (parseError ? [parseError] : skipReason ? [skipReason] : []),
    };
  }

  return deps.db.transaction(async (tx) => {
    const si = await upsertSourceItem(tx, {
      sourceId: ctx.scraper.id,
      externalId: item.externalId,
      url: candidate?.url ?? item.url,
      contentHash: sha256(stableStringify(candidate ?? { skipReason, parseError })),
      parsed: candidate ?? { skipReason, parseError },
      snapshotId,
      skipReason: parseError ? `parse_error: ${parseError}` : skipReason,
    });
    if (!result) {
      return {
        ...base,
        action: parseError ? 'parse_error' : 'skipped',
        eventId: si.eventId,
        status: null,
        reviewReasons: [],
        notes: [parseError ?? skipReason ?? ''],
      } as ItemReport;
    }
    const ev = result.event;
    const tags = result.tags.map((t) => ({
      tagId: t.tag.id,
      origin: t.origin,
      matchedBy: t.matchedBy,
    }));

    // ── 既有來源項目：內容未變 → 不處理；變動 → 依合併規則更新 ──
    if (si.eventId !== null) {
      const current = await getEvent(tx, si.eventId);
      if (current && (si.changed || ctx.force)) {
        // 上次解析結果（以目前字典重算），用來判斷鎖定欄位的「來源值」是否變動
        const prev = RawEventCandidateSchema.safeParse(si.previousParsed);
        const previous = prev.success
          ? normalizeCandidate(prev.data, {
              venues: ctx.venues,
              tagger: ctx.tagger,
              fetchedOn: page.fetchedOn,
              scale: deps.config.scale,
            }).event
          : null;
        return updateFromSource(tx, { current, sourceItemId: si.id, result, tags, base, previous });
      }
      return {
        ...base,
        action: 'unchanged',
        eventId: si.eventId,
        status: current?.status ?? null,
        reviewReasons: current?.reviewReasons ?? [],
        notes: [],
      };
    }

    // ── 新項目：去重 ──
    const key = dedupKey(ev);
    const candidates = await findDedupCandidates(tx, {
      titleNormalized: ev.titleNormalized,
      startAt: ev.startAt,
      dedupKey: key,
      windowDays: deps.config.dedup.dateWindowDays,
      minSimilarity: deps.config.dedup.possibleMin,
    });
    const decision = decideDuplicate(ev, candidates, deps.config.dedup);

    if (decision.kind === 'merge') {
      await attachEventSource(tx, {
        eventId: decision.eventId,
        sourceItemId: si.id,
        url: ev.sourceUrl,
        isPrimary: false,
      });
      const current = (await getEvent(tx, decision.eventId))!;
      const report = await updateFromSource(tx, {
        current,
        sourceItemId: si.id,
        result,
        tags,
        base,
        isPrimary: false,
      });
      await writeAudit(tx, {
        actor: ACTOR,
        action: 'pipeline.merge',
        entity: 'event',
        entityId: decision.eventId,
        diff: {
          rule: decision.rule,
          key: decision.key,
          sourceId: ev.sourceId,
          externalId: ev.externalId,
        },
      });
      return { ...report, action: 'merged' };
    }

    const isPossible = decision.kind === 'possible';
    // 依 REVIEW_REASONS 的固定順序排列，與 planSourceUpdate 一致（否則重跑會被當成變更）
    const reviewReasons = isPossible
      ? REVIEW_REASONS.filter((r) => r === 'possible_duplicate' || ev.reviewReasons.includes(r))
      : ev.reviewReasons;
    const notes = isPossible
      ? [
          ...result.notes,
          `${DUPLICATE_NOTE_PREFIX}${decision.eventIds.join('、#')} 重複（相似度 ${decision.best.similarity.toFixed(2)}）`,
        ]
      : result.notes;
    const status = isPossible ? 'pending_review' : result.status;
    const eventId = await insertEvent(tx, {
      normalized: { ...ev, reviewReasons },
      status,
      dedupKey: key,
      notes,
    });
    await attachEventSource(tx, {
      eventId,
      sourceItemId: si.id,
      url: ev.sourceUrl,
      isPrimary: true,
    });
    await addEventTags(tx, eventId, tags);
    return {
      ...base,
      action: isPossible ? 'possible_duplicate' : 'created',
      eventId,
      status,
      reviewReasons,
      notes,
    };
  });
}

async function updateFromSource(
  tx: Tx,
  a: {
    current: EventRow;
    sourceItemId: number;
    result: NonNullable<ReturnType<typeof normalizeCandidate>>;
    tags: { tagId: number; origin: 'source' | 'dict' | 'manual'; matchedBy: string | null }[];
    base: { externalId: string; title: string | null };
    isPrimary?: boolean;
    previous?: EventFields | null;
  },
): Promise<ItemReport> {
  const isPrimary = a.isPrimary ?? (await isPrimarySource(tx, a.current.id, a.sourceItemId));
  const plan = planSourceUpdate({
    current: {
      ...eventFields(a.current),
      reviewReasons: a.current.reviewReasons,
      status: a.current.status,
      statusLocked: a.current.statusLocked,
    },
    incoming: a.result.event,
    locked: a.current.lockedFields as LockableField[],
    isPrimary,
    previous: a.previous ?? null,
  });
  const merged = { ...eventFields(a.current), ...plan.patch };
  const nextKey = dedupKey(merged);
  // 疑似重複的說明是建立時由去重產生的，不在解析結果中；原因未解除前保留
  // 不在解析結果中的說明（去重產生的疑似重複、後台拆分紀錄）重跑時保留
  const dupNotes = a.current.reviewNotes.filter(
    (n) =>
      n.startsWith(SPLIT_NOTE_PREFIX) ||
      (n.startsWith(DUPLICATE_NOTE_PREFIX) && plan.reviewReasons.includes('possible_duplicate')),
  );
  const notes = isPrimary ? [...a.result.notes, ...dupNotes] : a.current.reviewNotes;
  const conflictNote =
    plan.lockedConflicts.length > 0
      ? [`來源變動的鎖定欄位：${plan.lockedConflicts.join('、')}`]
      : [];
  const nextNotes = [...new Set([...notes, ...conflictNote])];

  const changed =
    Object.keys(plan.patch).length > 0 ||
    plan.status !== a.current.status ||
    plan.reviewReasons.join() !== a.current.reviewReasons.join() ||
    nextKey !== a.current.dedupKey ||
    nextNotes.join('\n') !== a.current.reviewNotes.join('\n');
  if (changed) {
    await updateEvent(tx, a.current.id, {
      ...plan.patch,
      reviewReasons: plan.reviewReasons,
      status: plan.status,
      dedupKey: nextKey,
      reviewNotes: nextNotes,
    });
  }
  await addEventTags(tx, a.current.id, a.tags);
  return {
    ...a.base,
    action: changed ? 'updated' : 'unchanged',
    eventId: a.current.id,
    status: plan.status,
    reviewReasons: plan.reviewReasons,
    notes: nextNotes,
  };
}

async function afterRun(
  deps: PipelineDeps,
  sourceId: SourceId,
  r: { succeeded: boolean; counters: CrawlCounters; crawlRunId: number; error?: string },
): Promise<void> {
  try {
    const { consecutiveEmptyRuns } = await updateSourceAfterRun(deps.db, sourceId, {
      succeeded: r.succeeded,
      itemsFound: r.counters.itemsFound,
    });
    const recent = (await recentCrawlRuns(deps.db, sourceId, 6))
      .filter((run) => run.id !== r.crawlRunId && run.status === 'succeeded' && run.itemsFound > 0)
      .slice(0, 5)
      .map((run) => run.itemsMissingFields / run.itemsFound);
    const { fire, resolve } = evaluateRunAlerts(
      {
        sourceId,
        succeeded: r.succeeded,
        ...(r.error ? { error: r.error } : {}),
        itemsFound: r.counters.itemsFound,
        itemsMissingFields: r.counters.itemsMissingFields,
        consecutiveEmptyRuns,
        recentMissingRates: recent,
      },
      {
        emptyRunThreshold: deps.config.emptyRunThreshold,
        missingRateJump: deps.config.missingRateJump,
      },
    );
    for (const a of fire) await deps.alerter.send(a);
    for (const k of resolve) await deps.alerter.resolve(k);
  } catch (err) {
    // 告警流程失敗不得中斷管線
    deps.logger.error({ err, sourceId }, '執行後處理（告警）失敗');
  }
}

export async function sourceIsEnabled(db: Database, id: SourceId): Promise<boolean> {
  return (await getSource(db, id))?.enabled ?? false;
}
