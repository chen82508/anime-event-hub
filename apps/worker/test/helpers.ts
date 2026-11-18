import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DICTIONARY_DIR,
  createDb,
  loadDictionaries,
  runMigrations,
  seedDictionaries,
  type DbHandle,
} from '@aeh/db';
import { PoliteClient, SnapshotStore } from '@aeh/http';
import { createRegistry } from '@aeh/scrapers';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { createAlerter, type Alert } from '../src/alerts';
import { DEFAULT_PIPELINE_CONFIG, type PipelineDeps } from '../src/pipeline';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
if (!process.env.DATABASE_URL_TEST) {
  try {
    process.loadEnvFile(join(REPO, '.env'));
  } catch {
    /* 沒有 .env → 略過整合測試 */
  }
}

/** worker 專用測試 DB（與 @aeh/db 的整合測試分開，turbo 平行執行時互不干擾） */
export const WORKER_TEST_DB_URL = (() => {
  const base = process.env.DATABASE_URL_TEST;
  if (!base) return undefined;
  const u = new URL(base);
  u.pathname = `${u.pathname.slice(1).replace(/_test$/, '')}_worker_test`;
  return u.href;
})();

export async function freshWorkerDb(): Promise<DbHandle> {
  const base = process.env.DATABASE_URL_TEST!;
  const name = new URL(WORKER_TEST_DB_URL!).pathname.slice(1);
  if (!name.endsWith('_test')) throw new Error(`拒絕使用非測試資料庫：${name}`);
  const admin = createDb(base, { max: 1 });
  try {
    const exists = await admin.db.execute(sql`select 1 from pg_database where datname = ${name}`);
    if (exists.length === 0) await admin.db.execute(sql.raw(`create database "${name}"`));
  } finally {
    await admin.close();
  }
  const handle = createDb(WORKER_TEST_DB_URL!, { max: 4 });
  await handle.db.execute(sql`drop schema if exists drizzle cascade`);
  await handle.db.execute(sql`drop schema public cascade`);
  await handle.db.execute(sql`create schema public`);
  await runMigrations(handle.db);
  await seedDictionaries(handle.db, await loadDictionaries(DEFAULT_DICTIONARY_DIR));
  return handle;
}

export function scraperFixture(dir: string, name: string): Buffer {
  return readFileSync(join(REPO, 'packages/scrapers/src', dir, 'fixtures', name));
}

export type Routes = Record<string, () => Response>;

export async function makeDeps(handle: DbHandle, routes: Routes, opts: { webhook?: boolean } = {}) {
  const snapDir = await mkdtemp(join(tmpdir(), 'aeh-worker-'));
  const store = new SnapshotStore(snapDir);
  let clock = Date.UTC(2026, 10, 18, 4, 0); // 2026-11-18 12:00 台灣時間
  const client = new PoliteClient({
    userAgent: 'AnimeEventHubTW-Bot/test',
    snapshots: store,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    maxRetries: 0,
    fetch: (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/robots.txt'))
        return new Response('User-agent: *\nAllow: /', { status: 200 });
      const route = routes[url];
      return route ? route() : new Response('not found', { status: 404 });
    }) as typeof fetch,
  });
  const sent: { text: string }[] = [];
  const alerts: Alert[] = [];
  const logger = pino({ level: 'silent' });
  const realAlerter = createAlerter({
    mode: opts.webhook ? 'slack' : 'console',
    webhookUrl: 'https://hooks.slack.invalid/test',
    db: handle.db,
    throttleMs: 60 * 60_000,
    logger,
    fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as { text: string });
      return new Response('ok');
    }) as typeof fetch,
  });
  const deps: PipelineDeps = {
    db: handle.db,
    store,
    client,
    scrapers: createRegistry(),
    alerter: {
      send: async (a) => {
        alerts.push(a);
        await realAlerter.send(a);
      },
      resolve: (k) => realAlerter.resolve(k),
    },
    logger,
    config: { ...DEFAULT_PIPELINE_CONFIG },
  };
  return {
    deps,
    sent,
    alerts,
    store,
    cleanupDir: () => rm(snapDir, { recursive: true, force: true }),
  };
}

export const html =
  (buf: Buffer | string, type = 'text/html; charset=utf-8') =>
  () =>
    new Response(buf, { status: 200, headers: { 'content-type': type } });
