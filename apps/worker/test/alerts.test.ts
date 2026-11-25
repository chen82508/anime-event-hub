import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { sendTestAlert } from '../src/alerts';

const logger = pino({ level: 'silent' });
const URL_ = 'https://hooks.slack.com/services/T000/B000/XXXX';

function fakeFetch(impl: () => Promise<Response>) {
  return vi.fn<typeof fetch>(impl);
}

describe('sendTestAlert', () => {
  it('slack 模式：以正式模板 POST 到 webhook，2xx → sent', async () => {
    const f = fakeFetch(async () => new Response('ok', { status: 200 }));
    const r = await sendTestAlert({
      mode: 'slack',
      webhookUrl: URL_,
      origin: '本機',
      logger,
      fetch: f,
    });
    expect(r.status).toBe('sent');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(URL_);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)) as { text: string };
    expect(body.text).toBe(r.text);
    expect(r.text).toContain('*[Anime Event Hub] 測試告警*');
    expect(r.text).toContain('• 來源：本機');
  });

  it('webhook 回應非 2xx → failed，附上狀態碼', async () => {
    const f = fakeFetch(async () => new Response('invalid_token', { status: 403 }));
    const r = await sendTestAlert({
      mode: 'slack',
      webhookUrl: URL_,
      origin: 'x',
      logger,
      fetch: f,
    });
    expect(r).toMatchObject({ status: 'failed', error: 'HTTP 403' });
  });

  it('連線失敗 → failed，不拋錯', async () => {
    const f = fakeFetch(async () => {
      throw new Error('fetch failed');
    });
    const r = await sendTestAlert({
      mode: 'slack',
      webhookUrl: URL_,
      origin: 'x',
      logger,
      fetch: f,
    });
    expect(r).toMatchObject({ status: 'failed', error: 'fetch failed' });
  });

  it('console 模式或沒有 webhook → 不送出，回 console', async () => {
    const f = fakeFetch(async () => new Response('ok'));
    expect(
      (await sendTestAlert({ mode: 'console', webhookUrl: URL_, origin: 'x', logger, fetch: f }))
        .status,
    ).toBe('console');
    expect((await sendTestAlert({ mode: 'slack', origin: 'x', logger, fetch: f })).status).toBe(
      'console',
    );
    expect(f).not.toHaveBeenCalled();
  });
});
