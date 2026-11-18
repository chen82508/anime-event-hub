import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HttpRequestError,
  PoliteClient,
  RobotsDisallowedError,
  SnapshotStore,
  parseRetryAfter,
  type HttpLogger,
  type PoliteClientOptions,
  type SnapshotRecord,
} from '../src';

const UA = 'AnimeEventHubTW-Bot/0.1 (+https://example.invalid/contact)';

type Route = Response | Error | ((req: Request) => Response | Error);

/** 假時鐘＋假 fetch：記錄每次請求的時間點與 sleep 長度，不真的等待 */
function harness(routes: Record<string, Route | Route[]>, opts: Partial<PoliteClientOptions> = {}) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const calls: { url: string; at: number; headers: Headers }[] = [];
  const logs: { level: string; obj: object; msg?: string }[] = [];
  const counters = new Map<string, number>();

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, at: clock, headers: req.headers });
    const entry = routes[req.url];
    if (entry === undefined) return new Response('not found', { status: 404 });
    const n = counters.get(req.url) ?? 0;
    counters.set(req.url, n + 1);
    const route = Array.isArray(entry) ? (entry[Math.min(n, entry.length - 1)] as Route) : entry;
    const res = typeof route === 'function' ? route(req) : route;
    if (res instanceof Error) throw res;
    return res.clone();
  }) as typeof fetch;

  const logger: HttpLogger = {
    debug: (obj, msg) => logs.push({ level: 'debug', obj, msg }),
    info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
  };
  const snapshots: SnapshotRecord[] = [];
  const client = new PoliteClient({
    userAgent: UA,
    snapshots: new SnapshotStore(root),
    fetch: fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    logger,
    onSnapshot: (r) => {
      snapshots.push(r);
    },
    ...opts,
  });
  const pageCalls = (url: string) => calls.filter((c) => c.url === url);
  /** 推進假時鐘（模擬經過一段時間，不計入 sleeps） */
  const sleepFor = async (ms: number) => {
    clock += ms;
  };
  return { client, calls, sleeps, logs, snapshots, pageCalls, sleepFor };
}

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
const robots = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aeh-http-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('PoliteClient：設定檢查', () => {
  it('同 host 間隔不得低於 3 秒', () => {
    expect(
      () =>
        new PoliteClient({
          userAgent: UA,
          snapshots: new SnapshotStore(root),
          minIntervalMs: 1000,
        }),
    ).toThrow('3000');
  });
  it('重試次數 0–3', () => {
    expect(
      () => new PoliteClient({ userAgent: UA, snapshots: new SnapshotStore(root), maxRetries: 4 }),
    ).toThrow();
  });
  it('UA 不可為空', () => {
    expect(
      () => new PoliteClient({ userAgent: ' ', snapshots: new SnapshotStore(root) }),
    ).toThrow();
  });
});

describe('PoliteClient：robots.txt', () => {
  it('禁止的路徑拒絕請求並記錄，不發出頁面請求', async () => {
    const h = harness({
      'https://a.test/robots.txt': robots('User-agent: *\nDisallow: /private/'),
      'https://a.test/private/1': html('secret'),
    });
    await expect(
      h.client.get('https://a.test/private/1', { sourceId: 'kktix' }),
    ).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(h.pageCalls('https://a.test/private/1')).toHaveLength(0);
    expect(h.logs.some((l) => l.level === 'warn' && l.msg?.includes('robots.txt 禁止'))).toBe(true);
  });

  it('robots.txt 每個 origin 只讀一次', async () => {
    const h = harness({
      'https://a.test/robots.txt': robots('User-agent: *\nAllow: /'),
      'https://a.test/1': html('1'),
      'https://a.test/2': html('2'),
    });
    await h.client.get('https://a.test/1', { sourceId: 'kktix' });
    await h.client.get('https://a.test/2', { sourceId: 'kktix' });
    expect(h.pageCalls('https://a.test/robots.txt')).toHaveLength(1);
  });

  it('robots.txt 快取到期後重讀，網站更新的規則會生效（M1）', async () => {
    let body = 'User-agent: *\nAllow: /';
    const h = harness({
      'https://a.test/robots.txt': () => robots(body),
      'https://a.test/x': html('ok'),
    });
    await h.client.get('https://a.test/x', { sourceId: 'kktix' });
    body = 'User-agent: *\nDisallow: /x';
    // 24 小時內仍用快取
    await h.client.get('https://a.test/x', { sourceId: 'kktix' });
    // 推進時鐘超過 24 小時（透過 sleep 推進假時鐘）
    await h.sleepFor(24 * 60 * 60 * 1000 + 1);
    await expect(h.client.get('https://a.test/x', { sourceId: 'kktix' })).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
    expect(h.pageCalls('https://a.test/robots.txt')).toHaveLength(2);
  });

  it('robots.txt 暫時故障 → 1 小時後重試，恢復後可繼續擷取（M1）', async () => {
    let down = true;
    const h = harness(
      {
        'https://a.test/robots.txt': () =>
          down ? new Response('down', { status: 503 }) : robots(''),
        'https://a.test/x': html('ok'),
      },
      { maxRetries: 0 },
    );
    await expect(h.client.get('https://a.test/x', { sourceId: 'kktix' })).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
    down = false;
    await h.sleepFor(60 * 60 * 1000 + 1);
    expect((await h.client.get('https://a.test/x', { sourceId: 'kktix' })).status).toBe(200);
  });

  it('robots.txt 404 → 全部允許', async () => {
    const h = harness({ 'https://a.test/x': html('ok') });
    expect((await h.client.get('https://a.test/x', { sourceId: 'kktix' })).status).toBe(200);
  });

  it('robots.txt 5xx（重試後仍失敗）→ 全部禁止', async () => {
    const h = harness({
      'https://a.test/robots.txt': new Response('down', { status: 503 }),
      'https://a.test/x': html('ok'),
    });
    await expect(h.client.get('https://a.test/x', { sourceId: 'kktix' })).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
    expect(h.pageCalls('https://a.test/robots.txt')).toHaveLength(4);
    expect(await h.client.isAllowed('https://a.test/y')).toBe(false);
  });

  it('robots.txt 連線失敗 → 全部禁止', async () => {
    const h = harness(
      { 'https://a.test/robots.txt': new TypeError('fetch failed') },
      { maxRetries: 0 },
    );
    await expect(h.client.get('https://a.test/x', { sourceId: 'kktix' })).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
  });

  it('轉址到被禁止的路徑 → 拒絕', async () => {
    const h = harness({
      'https://a.test/robots.txt': robots('User-agent: *\nDisallow: /members'),
      'https://a.test/go': new Response(null, {
        status: 302,
        headers: { location: '/members/login' },
      }),
    });
    await expect(h.client.get('https://a.test/go', { sourceId: 'kktix' })).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
  });
});

describe('PoliteClient：節流', () => {
  it('同一 host 的請求間隔 ≥ 3 秒（robots.txt 也計入）', async () => {
    const h = harness({
      'https://a.test/robots.txt': robots(''),
      'https://a.test/1': html('1'),
      'https://a.test/2': html('2'),
    });
    await h.client.get('https://a.test/1', { sourceId: 'kktix' });
    await h.client.get('https://a.test/2', { sourceId: 'kktix' });
    const times = h.calls.map((c) => c.at);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(3000);
    }
  });

  it('並行呼叫同一 host 也會排隊', async () => {
    const h = harness({
      'https://a.test/robots.txt': robots(''),
      'https://a.test/1': html('1'),
      'https://a.test/2': html('2'),
      'https://a.test/3': html('3'),
    });
    await Promise.all(
      ['1', '2', '3'].map((p) => h.client.get(`https://a.test/${p}`, { sourceId: 'kktix' })),
    );
    // robots.txt 之後，三個頁面各自等滿 3 秒（依序排隊，不會同時發出）
    expect(h.sleeps).toEqual([3000, 3000, 3000]);
    expect(h.calls).toHaveLength(4);
  });

  it('不同 host 不互相等待', async () => {
    const h = harness({ 'https://a.test/x': html('a'), 'https://b.test/x': html('b') });
    await h.client.get('https://a.test/x', { sourceId: 'kktix' });
    const before = h.sleeps.length;
    await h.client.get('https://b.test/x', { sourceId: 'kktix' });
    // b.test：robots（第一次，不等）→ 頁面（等 3 秒）
    expect(h.sleeps.slice(before)).toEqual([3000]);
  });

  it('Crawl-delay 較長時採用之', async () => {
    const h = harness({
      'https://a.test/robots.txt': robots('User-agent: *\nCrawl-delay: 10'),
      'https://a.test/1': html('1'),
    });
    await h.client.get('https://a.test/1', { sourceId: 'kktix' });
    expect(h.sleeps).toEqual([10_000]);
  });
});

describe('PoliteClient：重試', () => {
  it('5xx 後成功：指數退避，記錄重試次數', async () => {
    const h = harness({
      'https://a.test/robots.txt': robots(''),
      'https://a.test/x': [
        new Response('err', { status: 503 }),
        new Response('err', { status: 502 }),
        html('ok'),
      ],
    });
    const r = await h.client.get('https://a.test/x', { sourceId: 'kktix' });
    expect(r).toMatchObject({ status: 200, ok: true, retries: 2, text: 'ok' });
    // 節流 3000 → 退避 2000 → 節流補 1000 → 退避 4000（已超過間隔，不再等）
    expect(h.sleeps).toEqual([3000, 2000, 1000, 4000]);
  });

  it('最多重試 3 次；仍失敗則回傳最後的回應（ok = false）並寫入快照', async () => {
    const h = harness({
      'https://a.test/robots.txt': robots(''),
      'https://a.test/x': new Response('err', { status: 500 }),
    });
    const r = await h.client.get('https://a.test/x', { sourceId: 'kktix' });
    expect(r).toMatchObject({ status: 500, ok: false, retries: 3 });
    expect(h.pageCalls('https://a.test/x')).toHaveLength(4);
    expect(h.snapshots).toHaveLength(1);
  });

  it('連線錯誤重試用盡 → HttpRequestError', async () => {
    const h = harness({
      'https://a.test/robots.txt': robots(''),
      'https://a.test/x': new TypeError('fetch failed'),
    });
    const err = await h.client
      .get('https://a.test/x', { sourceId: 'kktix' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpRequestError);
    expect((err as HttpRequestError).cause).toBeInstanceOf(TypeError);
    expect(h.pageCalls('https://a.test/x')).toHaveLength(4);
  });

  it('404 不重試', async () => {
    const h = harness({
      'https://a.test/robots.txt': robots(''),
      'https://a.test/x': new Response('nope', { status: 404 }),
    });
    const r = await h.client.get('https://a.test/x', { sourceId: 'kktix' });
    expect(r).toMatchObject({ status: 404, ok: false, retries: 0 });
  });

  it('429 尊重 Retry-After（上限 maxRetryDelayMs）', async () => {
    const h = harness({
      'https://a.test/robots.txt': robots(''),
      'https://a.test/x': [
        new Response('slow down', { status: 429, headers: { 'retry-after': '20' } }),
        html('ok'),
      ],
    });
    await h.client.get('https://a.test/x', { sourceId: 'kktix' });
    expect(h.sleeps).toContain(20_000);

    const h2 = harness(
      {
        'https://a.test/robots.txt': robots(''),
        'https://a.test/x': [
          new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
          html('ok'),
        ],
      },
      { maxRetryDelayMs: 30_000 },
    );
    await h2.client.get('https://a.test/x', { sourceId: 'kktix' });
    expect(Math.max(...h2.sleeps)).toBe(30_000);
  });

  it('parseRetryAfter', () => {
    expect(parseRetryAfter('5', 0)).toBe(5000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 0)).toBe(10_000);
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});

describe('PoliteClient：回應處理', () => {
  it('送出 UA、解碼 Big5、寫入快照並呼叫 onSnapshot', async () => {
    const big5 = readFileSync(fileURLToPath(new URL('./fixtures/big5-meta.html', import.meta.url)));
    const h = harness({
      'https://a.test/robots.txt': robots(''),
      'https://a.test/news': new Response(big5, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    });
    const r = await h.client.get('https://a.test/news', { sourceId: 'ff', crawlRunId: 42 });
    expect(h.calls.every((c) => c.headers.get('user-agent') === UA)).toBe(true);
    expect(r.encoding).toBe('big5');
    expect(r.text).toContain('開拓動漫祭');
    expect(r.snapshot).toMatchObject({
      sourceId: 'ff',
      crawlRunId: 42,
      url: 'https://a.test/news',
      httpStatus: 200,
      encoding: 'big5',
    });
    expect(h.snapshots).toEqual([r.snapshot]);
    const stored = await new SnapshotStore(root).read(r.snapshot.storagePath);
    expect(Buffer.from(stored).equals(big5)).toBe(true);
  });

  it('跟隨轉址，快照記錄最終 URL', async () => {
    const h = harness({
      'https://a.test/robots.txt': robots(''),
      'https://a.test/old': new Response(null, {
        status: 301,
        headers: { location: 'https://a.test/new' },
      }),
      'https://a.test/new': html('moved'),
    });
    const r = await h.client.get('https://a.test/old', { sourceId: 'kktix' });
    expect(r).toMatchObject({
      requestedUrl: 'https://a.test/old',
      finalUrl: 'https://a.test/new',
      text: 'moved',
    });
    expect(r.snapshot.url).toBe('https://a.test/new');
  });

  it('轉址次數上限', async () => {
    const h = harness(
      {
        'https://a.test/robots.txt': robots(''),
        'https://a.test/loop': new Response(null, { status: 302, headers: { location: '/loop' } }),
      },
      { maxRedirects: 2 },
    );
    await expect(h.client.get('https://a.test/loop', { sourceId: 'kktix' })).rejects.toThrow(
      '轉址次數',
    );
  });

  it('回應超過大小上限 → 錯誤且不重試', async () => {
    const h = harness(
      { 'https://a.test/robots.txt': robots(''), 'https://a.test/big': html('x'.repeat(2000)) },
      { maxBytes: 1000 },
    );
    await expect(h.client.get('https://a.test/big', { sourceId: 'kktix' })).rejects.toThrow('超過');
    expect(h.pageCalls('https://a.test/big')).toHaveLength(1);
  });

  it('不支援的協定', async () => {
    const h = harness({});
    await expect(h.client.get('ftp://a.test/x', { sourceId: 'kktix' })).rejects.toThrow('協定');
  });
});

describe('PoliteClient：本機 HTTP server（真實 fetch，不打外部網站）', () => {
  let server: Server;
  let base: string;
  const hits: string[] = [];

  beforeEach(async () => {
    hits.length = 0;
    server = createServer((req, res) => {
      hits.push(`${req.url} ${req.headers['user-agent']}`);
      if (req.url === '/robots.txt') {
        res
          .writeHead(200, { 'content-type': 'text/plain' })
          .end('User-agent: *\nDisallow: /secret');
      } else if (req.url === '/start') {
        res.writeHead(302, { location: '/events' }).end();
      } else if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h1>活動列表</h1>');
      } else if (req.url === '/to-secret') {
        res.writeHead(302, { location: '/secret' }).end();
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function realClient() {
    let clock = 0;
    return new PoliteClient({
      userAgent: UA,
      snapshots: new SnapshotStore(root),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
  }

  it('手動跟隨轉址並逐跳檢查 robots', async () => {
    const client = realClient();
    const r = await client.get(`${base}/start`, { sourceId: 'kktix' });
    expect(r).toMatchObject({ status: 200, finalUrl: `${base}/events` });
    expect(r.text).toContain('活動列表');
    expect(hits.map((h) => h.split(' ')[0])).toEqual(['/robots.txt', '/start', '/events']);
    expect(hits.every((h) => h.endsWith(UA))).toBe(true);

    await expect(client.get(`${base}/to-secret`, { sourceId: 'kktix' })).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
    expect(hits.some((h) => h.startsWith('/secret'))).toBe(false);
  });
});
