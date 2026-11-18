/**
 * PoliteClient：合規擷取用的 HTTP 用戶端（C9、tech-spec T5）。
 *
 * - robots.txt：每個 origin 快取 24 小時（取得失敗時 1 小時）；禁止的路徑拒絕請求並記錄（RobotsDisallowedError）。
 *   robots.txt 回應 4xx → 視為全部允許；5xx / 連線失敗 → 視為全部禁止（RFC 9309）。
 * - 節流：同一 host 兩次請求間隔 ≥ minIntervalMs（不得低於 3000）；robots 的 Crawl-delay 較長時採用之。
 *   robots.txt、重試、轉址的每一次請求都計入。
 * - 重試：連線錯誤、逾時、408/425/429/5xx → 指數退避重試，最多 3 次；尊重 Retry-After。
 * - 轉址：手動跟隨（最多 5 次），每一跳都重新檢查 robots 與節流。
 * - 編碼：BOM → header → meta → 偵測（Big5/UTF-8）。
 * - 快照：最終回應（含非 2xx）一律寫入 SnapshotStore，並呼叫 onSnapshot 讓 apps 層登記 raw_snapshot。
 */
import type { SourceId } from '@aeh/core';
import { decodeBody, type EncodingSource, type SupportedEncoding } from './encoding';
import {
  ALLOW_ALL,
  DISALLOW_ALL,
  crawlDelayMs,
  isAllowedByRobots,
  parseRobotsTxt,
  type RobotsRule,
  type RobotsTxt,
} from './robots';
import type { SnapshotRecord, SnapshotStore } from './snapshot';

/** 合規底線：同一 host 最小間隔（C9） */
export const MIN_INTERVAL_FLOOR_MS = 3000;
/** 重試次數上限（T5 DoD） */
export const MAX_RETRIES_CAP = 3;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** pino 相容的最小 logger 介面 */
export interface HttpLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const noopLogger: HttpLogger = { debug() {}, info() {}, warn() {}, error() {} };

export interface PoliteClientOptions {
  /** 需標示專案名稱與聯絡方式（由 env 提供，不寫死在程式碼，R13） */
  userAgent: string;
  snapshots: SnapshotStore;
  /** 同一 host 最小間隔，預設且不得低於 3000 */
  minIntervalMs?: number;
  /** 0–3，預設 3 */
  maxRetries?: number;
  /** 指數退避的基準，預設 2000（2s → 4s → 8s） */
  retryBaseDelayMs?: number;
  /** 單次退避上限（含 Retry-After），預設 60000 */
  maxRetryDelayMs?: number;
  /** 單次請求逾時，預設 30000 */
  timeoutMs?: number;
  /** 回應大小上限，預設 10 MiB */
  maxBytes?: number;
  /** 預設 5 */
  maxRedirects?: number;
  /** robots.txt 快取效期（排程程序長期執行，需定期重讀），預設 24 小時 */
  robotsTtlMs?: number;
  /** robots.txt 取得失敗（視為全部禁止）時的快取效期，預設 1 小時，避免暫時故障讓來源停擺到重啟 */
  robotsFailureTtlMs?: number;
  /** 登記 raw_snapshot（apps 層實作）；失敗會往上拋 */
  onSnapshot?: (record: SnapshotRecord) => void | Promise<void>;
  logger?: HttpLogger;
  /** 以下供測試注入 */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestContext {
  sourceId: SourceId;
  crawlRunId?: number | null;
  headers?: Record<string, string>;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  contentType: string | null;
  bytes: Uint8Array;
  text: string;
  encoding: SupportedEncoding;
  encodingSource: EncodingSource;
  fetchedAt: Date;
  /** 重試次數（0 = 一次成功） */
  retries: number;
  snapshot: SnapshotRecord;
}

export class RobotsDisallowedError extends Error {
  override name = 'RobotsDisallowedError';
  constructor(
    readonly url: string,
    readonly rule: RobotsRule | null,
  ) {
    super(
      `robots.txt 禁止擷取：${url}${rule ? `（規則 ${rule.allow ? 'Allow' : 'Disallow'}: ${rule.pattern}）` : ''}`,
    );
  }
}

export class HttpRequestError extends Error {
  override name = 'HttpRequestError';
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

interface RawResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  url: string;
}

export class PoliteClient {
  private readonly userAgent: string;
  private readonly snapshots: SnapshotStore;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly robotsTtlMs: number;
  private readonly robotsFailureTtlMs: number;
  private readonly onSnapshot: PoliteClientOptions['onSnapshot'];
  private readonly logger: HttpLogger;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** origin → robots.txt（expiresAt 在讀取完成後才設定；讀取中為 Infinity） */
  private readonly robotsCache = new Map<
    string,
    { promise: Promise<RobotsTxt>; expiresAt: number }
  >();
  /** origin → robots.txt 的 Crawl-delay（毫秒） */
  private readonly crawlDelay = new Map<string, number>();
  /** host → 上次請求時間 */
  private readonly lastRequestAt = new Map<string, number>();
  /** host → 序列化用的 promise 鏈（同 host 的請求排隊） */
  private readonly hostQueue = new Map<string, Promise<void>>();

  constructor(options: PoliteClientOptions) {
    if (!options.userAgent.trim())
      throw new Error('userAgent 不可為空（需標示專案名稱與聯絡方式）');
    const minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_FLOOR_MS;
    if (minIntervalMs < MIN_INTERVAL_FLOOR_MS) {
      throw new Error(`minIntervalMs 不得低於 ${MIN_INTERVAL_FLOOR_MS}（同 host 間隔 ≥ 3 秒，C9）`);
    }
    const maxRetries = options.maxRetries ?? MAX_RETRIES_CAP;
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES_CAP) {
      throw new Error(`maxRetries 必須是 0–${MAX_RETRIES_CAP} 的整數`);
    }
    this.userAgent = options.userAgent.trim();
    this.snapshots = options.snapshots;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 2000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.robotsTtlMs = options.robotsTtlMs ?? 24 * 60 * 60 * 1000;
    this.robotsFailureTtlMs = options.robotsFailureTtlMs ?? 60 * 60 * 1000;
    this.onSnapshot = options.onSnapshot;
    this.logger = options.logger ?? noopLogger;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** GET 一個頁面：robots 檢查 → 節流 → 請求（含重試、轉址）→ 解碼 → 快照 */
  async get(url: string, ctx: RequestContext): Promise<FetchResult> {
    let current = new URL(url);
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new HttpRequestError(`不支援的協定：${current.protocol}`, url, null);
    }

    let res: RawResponse;
    let retries: number;
    for (let hop = 0; ; hop++) {
      await this.assertAllowed(current);
      ({ res, retries } = await this.requestWithRetry(current, ctx.headers));
      const location = res.headers.get('location');
      if (!REDIRECT_STATUS.has(res.status) || !location) break;
      if (hop >= this.maxRedirects) {
        throw new HttpRequestError(`轉址次數超過 ${this.maxRedirects}`, url, res.status);
      }
      const next = new URL(location, current);
      this.logger.debug({ from: current.href, to: next.href, status: res.status }, '跟隨轉址');
      current = next;
    }

    const fetchedAt = new Date(this.now());
    const contentType = res.headers.get('content-type');
    const decoded = decodeBody(res.bytes, contentType);
    const { storagePath, contentHash } = await this.snapshots.save({
      sourceId: ctx.sourceId,
      fetchedAt,
      bytes: res.bytes,
      contentType,
    });
    const snapshot: SnapshotRecord = {
      sourceId: ctx.sourceId,
      crawlRunId: ctx.crawlRunId ?? null,
      url: current.href,
      fetchedAt,
      httpStatus: res.status,
      contentType,
      contentHash,
      storagePath,
      encoding: decoded.encoding,
    };
    await this.onSnapshot?.(snapshot);

    const ok = res.status >= 200 && res.status < 300;
    const log = ok ? this.logger.info : this.logger.warn;
    log.call(
      this.logger,
      {
        url: current.href,
        status: res.status,
        bytes: res.bytes.length,
        encoding: decoded.encoding,
        retries,
      },
      ok ? '擷取完成' : '擷取回應非 2xx',
    );

    return {
      requestedUrl: url,
      finalUrl: current.href,
      status: res.status,
      ok,
      headers: Object.fromEntries(res.headers.entries()),
      contentType,
      bytes: res.bytes,
      text: decoded.text,
      encoding: decoded.encoding,
      encodingSource: decoded.source,
      fetchedAt,
      retries,
      snapshot,
    };
  }

  /** 只檢查 robots（不發出頁面請求），供 dry-run 或來源 README 檢查 */
  async isAllowed(url: string): Promise<boolean> {
    const u = new URL(url);
    return isAllowedByRobots(await this.robotsFor(u), this.userAgent, u.pathname + u.search)
      .allowed;
  }

  // ── robots ────────────────────────────────────────────

  private async assertAllowed(url: URL): Promise<void> {
    const robots = await this.robotsFor(url);
    const decision = isAllowedByRobots(robots, this.userAgent, url.pathname + url.search);
    if (!decision.allowed) {
      const err = new RobotsDisallowedError(url.href, decision.rule);
      this.logger.warn({ url: url.href, rule: decision.rule?.pattern ?? null }, err.message);
      throw err;
    }
  }

  private robotsFor(url: URL): Promise<RobotsTxt> {
    const origin = url.origin;
    const cached = this.robotsCache.get(origin);
    if (cached && this.now() < cached.expiresAt) return cached.promise;
    const entry = { promise: Promise.resolve(ALLOW_ALL), expiresAt: Number.POSITIVE_INFINITY };
    entry.promise = this.loadRobots(origin).then(({ robots, failed }) => {
      entry.expiresAt = this.now() + (failed ? this.robotsFailureTtlMs : this.robotsTtlMs);
      return robots;
    });
    this.robotsCache.set(origin, entry);
    return entry.promise;
  }

  private async loadRobots(origin: string): Promise<{ robots: RobotsTxt; failed: boolean }> {
    const robotsUrl = new URL('/robots.txt', origin);
    try {
      // robots.txt 允許轉址（RFC 9309 §2.3.1.2），交給 fetch 處理
      const { res } = await this.requestWithRetry(robotsUrl, undefined, 'follow');
      if (res.status >= 200 && res.status < 300) {
        const robots = parseRobotsTxt(decodeBody(res.bytes, res.headers.get('content-type')).text);
        const delay = crawlDelayMs(robots, this.userAgent);
        if (delay !== null) this.crawlDelay.set(origin, delay);
        else this.crawlDelay.delete(origin);
        this.logger.debug({ origin, groups: robots.groups.length }, '已讀取 robots.txt');
        return { robots, failed: false };
      }
      if (res.status >= 400 && res.status < 500) {
        this.logger.info({ origin, status: res.status }, 'robots.txt 不存在，視為全部允許');
        this.crawlDelay.delete(origin);
        return { robots: ALLOW_ALL, failed: false };
      }
      this.logger.warn({ origin, status: res.status }, 'robots.txt 無法取得，視為全部禁止');
      return { robots: DISALLOW_ALL, failed: true };
    } catch (err) {
      this.logger.warn(
        { origin, err: (err as Error).message },
        'robots.txt 無法取得，視為全部禁止',
      );
      return { robots: DISALLOW_ALL, failed: true };
    }
  }

  // ── 節流與重試 ────────────────────────────────────────

  /** 等到該 host 可以發出下一個請求；同 host 的請求依序排隊 */
  private async throttle(url: URL): Promise<void> {
    const host = url.host;
    const delay = Math.max(this.minIntervalMs, this.crawlDelay.get(url.origin) ?? 0);
    const prev = this.hostQueue.get(host) ?? Promise.resolve();
    const turn = prev.then(async () => {
      const last = this.lastRequestAt.get(host);
      if (last !== undefined) {
        const wait = last + delay - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.lastRequestAt.set(host, this.now());
    });
    this.hostQueue.set(
      host,
      turn.catch(() => undefined),
    );
    await turn;
  }

  private async requestWithRetry(
    url: URL,
    headers: Record<string, string> | undefined,
    redirect: 'manual' | 'follow' = 'manual',
  ): Promise<{ res: RawResponse; retries: number }> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle(url);
      let res: RawResponse | null = null;
      let error: unknown = null;
      try {
        res = await this.requestOnce(url, headers, redirect);
      } catch (err) {
        if (err instanceof HttpRequestError && err.status !== null) throw err; // 例如超過大小上限，不重試
        error = err;
      }

      const retryable = res === null || RETRYABLE_STATUS.has(res.status);
      if (!retryable && res) return { res, retries: attempt };
      if (attempt >= this.maxRetries) {
        if (res) return { res, retries: attempt };
        throw new HttpRequestError(
          `請求失敗（已重試 ${attempt} 次）：${url.href}`,
          url.href,
          null,
          {
            cause: error,
          },
        );
      }

      const backoff = this.retryBaseDelayMs * 2 ** attempt;
      const retryAfter = res ? parseRetryAfter(res.headers.get('retry-after'), this.now()) : null;
      const wait = Math.min(this.maxRetryDelayMs, Math.max(backoff, retryAfter ?? 0));
      this.logger.warn(
        {
          url: url.href,
          attempt: attempt + 1,
          status: res?.status ?? null,
          err: error instanceof Error ? error.message : undefined,
          waitMs: wait,
        },
        '請求失敗，稍後重試',
      );
      await this.sleep(wait);
    }
  }

  private async requestOnce(
    url: URL,
    headers: Record<string, string> | undefined,
    redirect: 'manual' | 'follow',
  ): Promise<RawResponse> {
    const res = await this.fetchImpl(url, {
      method: 'GET',
      redirect,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-TW,zh;q=0.9,ja;q=0.6,en;q=0.5',
        ...headers,
        'user-agent': this.userAgent,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      await res.body?.cancel();
      throw new HttpRequestError(`回應超過 ${this.maxBytes} bytes`, url.href, res.status);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > this.maxBytes) {
      throw new HttpRequestError(`回應超過 ${this.maxBytes} bytes`, url.href, res.status);
    }
    return { status: res.status, headers: res.headers, bytes, url: res.url || url.href };
  }
}

/** Retry-After：秒數或 HTTP-date → 毫秒 */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed); // HTTP-date 自帶 GMT，可安全解析
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}
