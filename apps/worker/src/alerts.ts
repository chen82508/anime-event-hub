/**
 * 告警（T9、D5）：Slack Incoming Webhook，或 ALERT_MODE=console 時只寫 log。
 *
 * - 同一告警鍵以 DB（alert_state）節流，避免洗版；CLI 與排程共用節流狀態
 * - webhook 失敗只記錄，不得中斷管線
 * - 訊息為固定模板（不使用 LLM，C3）
 */
import type { SourceId } from '@aeh/core';
import { claimAlertSlot, resetAlertSlot, type Database } from '@aeh/db';
import type { Logger } from 'pino';

export interface Alert {
  /** 節流鍵，例：`empty:kktix`、`failure:cwt`、`missing-rate:muse` */
  key: string;
  title: string;
  lines: string[];
}

export interface Alerter {
  send(alert: Alert): Promise<void>;
  /** 狀態恢復：清除節流，下次異常可立即告警 */
  resolve(key: string): Promise<void>;
}

export interface AlerterOptions {
  mode: 'console' | 'slack';
  webhookUrl?: string;
  db: Database;
  throttleMs: number;
  logger: Logger;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function formatSlackText(alert: Alert, suppressed: number): string {
  const extra = suppressed > 0 ? [`（節流期間另有 ${suppressed} 次相同告警未送出）`] : [];
  return [
    `:rotating_light: *[Anime Event Hub] ${alert.title}*`,
    ...alert.lines.map((l) => `• ${l}`),
    ...extra,
  ].join('\n');
}

/** 送出 Slack 訊息；回傳 null 表示成功，否則回傳錯誤說明（不拋錯） */
async function postSlack(
  webhookUrl: string,
  text: string,
  doFetch: typeof fetch,
): Promise<string | null> {
  try {
    const res = await doFetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return (err as Error).message;
  }
}

export type TestAlertResult =
  | { status: 'sent'; text: string }
  | { status: 'console'; text: string }
  | { status: 'failed'; text: string; error: string };

/**
 * 測試告警（CLI `alert-test`）：用正式告警的模板送一則固定訊息，確認 webhook 設定可用。
 * 不經過節流、不寫入 alert_state，因此不影響之後的真正告警。
 */
export async function sendTestAlert(o: {
  mode: 'console' | 'slack';
  webhookUrl?: string;
  /** 執行位置說明，例：「本機」或 GitHub Actions 的 run 連結 */
  origin: string;
  logger: Logger;
  fetch?: typeof fetch;
}): Promise<TestAlertResult> {
  const text = formatSlackText(
    {
      key: 'test',
      title: '測試告警',
      lines: ['這是手動發送的測試訊息，用來確認 Slack webhook 設定正確。', `來源：${o.origin}`],
    },
    0,
  );
  if (o.mode === 'console' || !o.webhookUrl) {
    o.logger.warn({ alert: 'test' }, `[ALERT] ${text}`);
    return { status: 'console', text };
  }
  const error = await postSlack(o.webhookUrl, text, o.fetch ?? fetch);
  return error === null ? { status: 'sent', text } : { status: 'failed', text, error };
}

export function createAlerter(o: AlerterOptions): Alerter {
  const doFetch = o.fetch ?? fetch;
  return {
    async send(alert) {
      let slot: { send: boolean; suppressed: number };
      try {
        slot = await claimAlertSlot(o.db, alert.key, o.throttleMs, o.now?.() ?? new Date());
      } catch (err) {
        // 節流狀態讀不到也要告警（寧可多送）
        o.logger.error({ err, key: alert.key }, '告警節流狀態讀取失敗');
        slot = { send: true, suppressed: 0 };
      }
      if (!slot.send) {
        o.logger.info({ key: alert.key, suppressed: slot.suppressed }, '告警節流中，未送出');
        return;
      }
      const text = formatSlackText(alert, slot.suppressed);
      if (o.mode === 'console' || !o.webhookUrl) {
        o.logger.warn({ alert: alert.key }, `[ALERT] ${text}`);
        return;
      }
      const error = await postSlack(o.webhookUrl, text, doFetch);
      if (error !== null)
        o.logger.error({ err: error, key: alert.key }, 'Slack webhook 送出失敗（不中斷管線）');
    },
    async resolve(key) {
      try {
        await resetAlertSlot(o.db, key);
      } catch (err) {
        o.logger.error({ err, key }, '清除告警節流狀態失敗');
      }
    },
  };
}

// ── 告警規則（純函式，方便測試）────────────────────────────

export interface RunOutcome {
  sourceId: SourceId;
  succeeded: boolean;
  error?: string;
  itemsFound: number;
  itemsMissingFields: number;
  consecutiveEmptyRuns: number;
  /** 近期成功執行的缺漏率（不含本次），新到舊 */
  recentMissingRates: number[];
}

export interface AlertRules {
  emptyRunThreshold: number;
  missingRateJump: number;
  /** 缺漏率判定的最少筆數，避免小樣本誤報 */
  minItemsForRate?: number;
}

export function evaluateRunAlerts(
  r: RunOutcome,
  rules: AlertRules,
): { fire: Alert[]; resolve: string[] } {
  const fire: Alert[] = [];
  const resolve: string[] = [];
  const failureKey = `failure:${r.sourceId}`;
  const emptyKey = `empty:${r.sourceId}`;
  const rateKey = `missing-rate:${r.sourceId}`;

  if (!r.succeeded) {
    fire.push({
      key: failureKey,
      title: `來源擷取失敗：${r.sourceId}`,
      lines: [r.error ?? '未知錯誤'],
    });
    return { fire, resolve };
  }
  resolve.push(failureKey);

  if (r.itemsFound === 0 && r.consecutiveEmptyRuns >= rules.emptyRunThreshold) {
    fire.push({
      key: emptyKey,
      title: `來源連續 ${r.consecutiveEmptyRuns} 次 0 筆：${r.sourceId}`,
      lines: ['可能是網站改版、選擇器失效或 robots.txt 變更（R9），請檢查最新快照'],
    });
  } else if (r.itemsFound > 0) {
    resolve.push(emptyKey);
  }

  const minItems = rules.minItemsForRate ?? 5;
  if (r.itemsFound >= minItems && r.recentMissingRates.length > 0) {
    const rate = r.itemsMissingFields / r.itemsFound;
    const baseline = r.recentMissingRates.reduce((a, b) => a + b, 0) / r.recentMissingRates.length;
    if (rate - baseline > rules.missingRateJump) {
      fire.push({
        key: rateKey,
        title: `欄位缺漏率突增：${r.sourceId}`,
        lines: [
          `本次缺漏率 ${(rate * 100).toFixed(0)}%（${r.itemsMissingFields}/${r.itemsFound}），近期平均 ${(baseline * 100).toFixed(0)}%`,
          '可能是頁面結構變動導致欄位解析失敗（R9）',
        ],
      });
    } else {
      resolve.push(rateKey);
    }
  }
  return { fire, resolve };
}
