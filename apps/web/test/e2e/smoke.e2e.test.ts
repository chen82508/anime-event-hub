/**
 * 前台主要流程的 HTTP 煙霧測試（對執行中的網站，需已有已發布活動）：
 *   E2E_BASE_URL=http://localhost:3000 pnpm --filter @aeh/web test:e2e
 * 未設定 E2E_BASE_URL 時整組略過（一般 `pnpm test` 不需要啟動網站）。
 *
 * 涵蓋：列表 → 篩選（URL 狀態）→ 詳情頁官方連結導流 → 月曆 → 我的追蹤 → 404 → LINE webhook 保護。
 * 收藏／訂閱的 Server Action 互動以 DB 整合測試與瀏覽器手動驗證涵蓋。
 */
import { describe, expect, it } from 'vitest';

const BASE = process.env.E2E_BASE_URL?.replace(/\/+$/, '');

async function get(path: string): Promise<{ status: number; html: string }> {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  // React SSR 會在相鄰文字節點間插入 <!-- -->，比對前移除
  return { status: res.status, html: (await res.text()).replaceAll('<!-- -->', '') };
}

const eventLinks = (html: string) => [...new Set(html.match(/\/events\/\d+/g) ?? [])];

describe.skipIf(!BASE)('前台煙霧測試（E2E_BASE_URL）', () => {
  it('列表：200、主要區塊、活動卡片與收藏按鈕', async () => {
    const { status, html } = await get('/');
    expect(status).toBe(200);
    expect(html).toContain('近期活動');
    expect(html).toContain('台灣動漫活動，一站看完');
    expect(html).toContain('本週末');
    expect(eventLinks(html).length).toBeGreaterThan(0);
    expect(html).toMatch(/aria-pressed="(true|false)"/);
  });

  it('篩選：條件寫在 URL、出現已套用 chip 與訂閱列；無效值忽略', async () => {
    const all = eventLinks((await get('/')).html).length;
    const { status, html } = await get('/?type=concert&region=mars');
    expect(status).toBe(200);
    expect(html).toContain('移除條件：演唱會');
    expect(html).toContain('有新活動上架時通知我');
    expect(eventLinks(html).length).toBeLessThanOrEqual(all);
    const none = await get('/?q=%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84%E6%B4%BB%E5%8B%95zzz');
    expect(none.html).toContain('沒有符合條件的活動');
  });

  it('詳情頁：標題、強制附官方連結（新分頁＋noopener）、收藏按鈕', async () => {
    const [first] = eventLinks((await get('/')).html);
    const { status, html } = await get(first!);
    expect(status).toBe(200);
    expect(html).toMatch(/<h1>[^<]+<\/h1>/);
    expect(html).toMatch(
      /<a href="https?:\/\/[^"]+" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-block btn-lg">/,
    );
    expect(html).toMatch(/已收藏|收藏/);
  });

  it('月曆：月份導覽與格線', async () => {
    const { status, html } = await get('/?view=calendar&month=2026-12');
    expect(status).toBe(200);
    expect(html).toContain('2026 年 12 月');
    expect(html).toContain('calendar-grid');
  });

  it('我的追蹤：未建立訪客也能瀏覽各區塊', async () => {
    const { status, html } = await get('/me');
    expect(status).toBe(200);
    for (const s of ['通知匣', '收藏的活動', '訂閱', '通知管道', '通知設定'])
      expect(html).toContain(s);
  });

  it('不存在或非公開的活動 → 404', async () => {
    expect((await get('/events/999999999')).status).toBe(404);
    expect((await get('/events/abc')).status).toBe(404);
  });

  it('LINE webhook：未設定 → 503；設定後簽章錯誤 → 401', async () => {
    const res = await fetch(`${BASE}/api/line/webhook`, {
      method: 'POST',
      body: '{"events":[]}',
      headers: { 'x-line-signature': 'invalid' },
    });
    expect([401, 503]).toContain(res.status);
  });

  it('PWA 資源：manifest、service worker、robots（/me、/admin 不索引）', async () => {
    expect((await get('/manifest.webmanifest')).status).toBe(200);
    expect((await get('/sw.js')).html).toContain("addEventListener('push'");
    const robots = (await get('/robots.txt')).html;
    expect(robots).toContain('Disallow: /admin');
    expect(robots).toContain('Disallow: /me');
  });
});
