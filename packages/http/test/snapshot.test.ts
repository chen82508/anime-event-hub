import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SnapshotStore, extensionFor, sha256Hex, taipeiDay } from '../src';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aeh-snap-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('SnapshotStore', () => {
  const bytes = new TextEncoder().encode('<html>hi</html>');

  it('以 來源/台灣日期/雜湊 存放原始 bytes，可讀回', async () => {
    const store = new SnapshotStore(root);
    // UTC 11/15 16:30 = 台灣 11/16 00:30 → 歸在 11/16
    const fetchedAt = new Date(Date.UTC(2026, 10, 15, 16, 30));
    const r = await store.save({ sourceId: 'kktix', fetchedAt, bytes, contentType: 'text/html' });
    expect(r.storagePath).toBe(`kktix/2026-11-16/${sha256Hex(bytes)}.html`);
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.read(r.storagePath)).toEqual(bytes);
  });

  it('同內容重複寫入不產生多個檔案', async () => {
    const store = new SnapshotStore(root);
    const fetchedAt = new Date(Date.UTC(2026, 10, 16, 3));
    await store.save({ sourceId: 'muse', fetchedAt, bytes, contentType: 'text/html' });
    await store.save({ sourceId: 'muse', fetchedAt, bytes, contentType: 'text/html' });
    expect(await readdir(join(root, 'muse', '2026-11-16'))).toHaveLength(1);
  });

  it('拒絕跳出根目錄的路徑', async () => {
    const store = new SnapshotStore(root);
    await expect(store.read('../etc/passwd')).rejects.toThrow('超出');
    await expect(store.read('/etc/passwd')).rejects.toThrow('超出');
  });

  it('需要絕對路徑', () => {
    expect(() => new SnapshotStore('var/snapshots')).toThrow('絕對路徑');
  });

  it('removeDaysBefore 只刪除早於基準日的日期目錄', async () => {
    const store = new SnapshotStore(root);
    for (const day of [14, 15, 16]) {
      await store.save({
        sourceId: 'cwt',
        fetchedAt: new Date(Date.UTC(2026, 9, day, 4)),
        bytes: new TextEncoder().encode(String(day)),
        contentType: 'text/html',
      });
    }
    expect(await store.removeDaysBefore('2026-10-16')).toEqual([
      'cwt/2026-10-14',
      'cwt/2026-10-15',
    ]);
    expect(await readdir(join(root, 'cwt'))).toEqual(['2026-10-16']);
    await expect(store.removeDaysBefore('2026/10/16')).rejects.toThrow();
  });
});

describe('小工具', () => {
  it('taipeiDay', () => {
    expect(taipeiDay(new Date(Date.UTC(2026, 0, 1, 15, 59)))).toBe('2026-01-01');
    expect(taipeiDay(new Date(Date.UTC(2026, 0, 1, 16, 0)))).toBe('2026-01-02');
  });
  it.each([
    ['text/html; charset=utf-8', 'html'],
    ['application/rss+xml', 'xml'],
    ['application/json', 'json'],
    ['text/plain', 'txt'],
    ['image/png', 'bin'],
    [null, 'html'],
  ])('extensionFor(%s) → %s', (ct, ext) => {
    expect(extensionFor(ct)).toBe(ext);
  });
});
