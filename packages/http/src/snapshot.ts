/**
 * 原始回應快照（D4、C9）。
 *
 * 路徑：`<rootDir>/<sourceId>/<yyyy-mm-dd（台灣日期）>/<sha256>.<ext>`，保存**原始 bytes**（不轉碼），
 * 以便日後 `reparse` 與做成 fixture。同內容同日只寫一次。
 * DB 登記（raw_snapshot）由 apps 層透過 PoliteClient 的 `onSnapshot` 處理，本套件不碰 DB。
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TIMEZONE, type SourceId } from '@aeh/core';

/** 對應 raw_snapshot 表的欄位 */
export interface SnapshotRecord {
  sourceId: SourceId;
  crawlRunId: number | null;
  /** 最終 URL（跟隨轉址後） */
  url: string;
  fetchedAt: Date;
  httpStatus: number;
  contentType: string | null;
  /** sha256 hex */
  contentHash: string;
  /** 相對於 SNAPSHOT_DIR 的路徑（POSIX 分隔） */
  storagePath: string;
  encoding: string | null;
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Date → 台灣日期 YYYY-MM-DD */
export function taipeiDay(at: Date): string {
  return dayFormatter.format(at);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function extensionFor(contentType: string | null): string {
  const t = (contentType ?? '').toLowerCase();
  if (t.includes('html')) return 'html';
  if (t.includes('xml') || t.includes('rss') || t.includes('atom')) return 'xml';
  if (t.includes('json')) return 'json';
  if (t.startsWith('text/')) return 'txt';
  return t === '' ? 'html' : 'bin';
}

const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

export class SnapshotStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    if (!isAbsolute(rootDir)) throw new Error(`SnapshotStore 需要絕對路徑：${rootDir}`);
    this.rootDir = resolve(rootDir);
  }

  /** 寫入快照，回傳相對路徑與雜湊。內容相同的檔案已存在時不重寫 */
  async save(input: {
    sourceId: SourceId;
    fetchedAt: Date;
    bytes: Uint8Array;
    contentType: string | null;
  }): Promise<{ storagePath: string; contentHash: string }> {
    const contentHash = sha256Hex(input.bytes);
    const rel = [
      input.sourceId,
      taipeiDay(input.fetchedAt),
      `${contentHash}.${extensionFor(input.contentType)}`,
    ].join('/');
    const abs = this.resolveInside(rel);
    if (!(await exists(abs))) {
      await mkdir(dirname(abs), { recursive: true });
      // 先寫暫存檔再 rename，避免中斷時留下不完整的快照
      const tmp = `${abs}.${process.pid}.tmp`;
      await writeFile(tmp, input.bytes);
      await rename(tmp, abs);
    }
    return { storagePath: rel, contentHash };
  }

  /** 讀回原始 bytes（reparse / --from-snapshot 用） */
  async read(storagePath: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.resolveInside(storagePath)));
  }

  /**
   * 刪除早於 cutoffDay（台灣日期，不含當日）的日期目錄（保留期限 ≤ 30 天，C9）。
   * 回傳刪除的相對路徑。DB 端 raw_snapshot 的清理由呼叫端處理。
   */
  async removeDaysBefore(cutoffDay: string): Promise<string[]> {
    if (!DAY_DIR_RE.test(cutoffDay)) throw new Error(`cutoffDay 必須是 YYYY-MM-DD：${cutoffDay}`);
    const removed: string[] = [];
    for (const source of await safeReaddir(this.rootDir)) {
      const sourceDir = join(this.rootDir, source);
      if (!(await stat(sourceDir)).isDirectory()) continue;
      for (const day of await safeReaddir(sourceDir)) {
        if (DAY_DIR_RE.test(day) && day < cutoffDay) {
          await rm(join(sourceDir, day), { recursive: true, force: true });
          removed.push(`${source}/${day}`);
        }
      }
    }
    return removed.sort();
  }

  /** 相對路徑 → 絕對路徑，並阻擋 `..` 跳出根目錄 */
  private resolveInside(rel: string): string {
    const abs = resolve(this.rootDir, rel);
    const r = relative(this.rootDir, abs);
    if (r === '' || r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..')) {
      throw new Error(`快照路徑超出 SNAPSHOT_DIR：${rel}`);
    }
    return abs;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
