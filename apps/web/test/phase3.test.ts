import { LINE_REPLY, signLineBody } from '@aeh/notify';
import { describe, expect, it } from 'vitest';
import { handleLineWebhook, type LineWebhookOps } from '../src/lib/line-webhook';
import { lineAddFriendUrl } from '../src/lib/notify-config';
import {
  activeDatePreset,
  datePresetRange,
  parseDiscoveryQuery,
  toSearchString,
} from '../src/lib/public/filters';

const tw = (s: string) => new Date(`${s}+08:00`);

describe('快速日期篩選（今天／本週末／30 天內）', () => {
  it('本週末：平日 → 這週六日；週六 → 今明；週日 → 今天', () => {
    expect(datePresetRange('weekend', tw('2026-11-25T12:00:00'))).toEqual({
      from: '2026-11-28',
      to: '2026-11-29',
    }); // 週三
    expect(datePresetRange('weekend', tw('2026-11-28T09:00:00'))).toEqual({
      from: '2026-11-28',
      to: '2026-11-29',
    }); // 週六
    expect(datePresetRange('weekend', tw('2026-11-29T22:00:00'))).toEqual({
      from: '2026-11-29',
      to: '2026-11-29',
    }); // 週日
    // 台灣時間週五深夜（UTC 仍是週五）→ 週六日
    expect(datePresetRange('weekend', new Date('2026-11-27T15:30:00Z'))).toEqual({
      from: '2026-11-28',
      to: '2026-11-29',
    });
  });

  it('今天／30 天內（跨月）', () => {
    const now = tw('2026-11-25T00:10:00');
    expect(datePresetRange('today', now)).toEqual({ from: '2026-11-25', to: '2026-11-25' });
    expect(datePresetRange('next30', now)).toEqual({ from: '2026-11-25', to: '2026-12-24' });
  });

  it('activeDatePreset：只有 from/to 正好相符才算選取；可與其它條件並存於 URL', () => {
    const now = tw('2026-11-25T12:00:00');
    const q = parseDiscoveryQuery({ from: '2026-11-28', to: '2026-11-29', type: 'concert' });
    expect(activeDatePreset(q, now)).toBe('weekend');
    expect(activeDatePreset(parseDiscoveryQuery({ from: '2026-11-28' }), now)).toBeNull();
    expect(toSearchString(q, datePresetRange('today', now))).toBe(
      '?type=concert&from=2026-11-25&to=2026-11-25',
    );
  });
});

describe('LINE webhook 處理', () => {
  const SECRET = 'channel-secret';
  function fakeOps(linkResult: Awaited<ReturnType<LineWebhookOps['link']>> = 'linked') {
    const log: string[] = [];
    const ops: LineWebhookOps = {
      async link(code, userId) {
        log.push(`link:${code}:${userId}`);
        return linkResult;
      },
      async unlink(userId) {
        log.push(`unlink:${userId}`);
        return true;
      },
      async reply(token, text) {
        log.push(`reply:${token}:${text}`);
      },
    };
    return { ops, log };
  }
  const body = (events: unknown[]) => JSON.stringify({ destination: 'Uxxx', events });
  const textEvent = (text: string, userId = 'U1') => ({
    type: 'message',
    replyToken: 'r1',
    source: { type: 'user', userId },
    message: { type: 'text', text },
  });

  it('簽章錯誤 → 401，不處理任何事件', async () => {
    const { ops, log } = fakeOps();
    const raw = body([textEvent('綁定 ABC234')]);
    expect(await handleLineWebhook(raw, 'bad', SECRET, ops)).toEqual({ status: 401, handled: 0 });
    expect(await handleLineWebhook(raw, null, SECRET, ops)).toEqual({ status: 401, handled: 0 });
    expect(log).toEqual([]);
  });

  it('綁定指令：綁定成功／碼無效都回覆固定文字', async () => {
    const ok = fakeOps('linked');
    const raw = body([textEvent('綁定 abc234')]);
    expect(await handleLineWebhook(raw, signLineBody(raw, SECRET), SECRET, ok.ops)).toEqual({
      status: 200,
      handled: 1,
    });
    expect(ok.log).toEqual(['link:ABC234:U1', `reply:r1:${LINE_REPLY.linked}`]);

    const bad = fakeOps('invalid_code');
    await handleLineWebhook(raw, signLineBody(raw, SECRET), SECRET, bad.ops);
    expect(bad.log.at(-1)).toBe(`reply:r1:${LINE_REPLY.invalidCode}`);
  });

  it('解除綁定、加好友回覆說明、封鎖自動解除、群組訊息忽略', async () => {
    const { ops, log } = fakeOps();
    const raw = body([
      textEvent('解除綁定'),
      { type: 'follow', replyToken: 'r2', source: { type: 'user', userId: 'U2' } },
      { type: 'unfollow', source: { type: 'user', userId: 'U3' } },
      { ...textEvent('綁定 ABC234'), source: { type: 'group', groupId: 'G1', userId: 'U4' } },
      textEvent('你好'),
    ]);
    const r = await handleLineWebhook(raw, signLineBody(raw, SECRET), SECRET, ops);
    expect(r).toEqual({ status: 200, handled: 4 });
    expect(log).toEqual([
      'unlink:U1',
      `reply:r1:${LINE_REPLY.unlinked}`,
      `reply:r2:${LINE_REPLY.help}`,
      'unlink:U3',
      `reply:r1:${LINE_REPLY.help}`,
    ]);
  });

  it('簽章正確但 JSON 錯誤 → 400', async () => {
    const { ops } = fakeOps();
    expect(await handleLineWebhook('{oops', signLineBody('{oops', SECRET), SECRET, ops)).toEqual({
      status: 400,
      handled: 0,
    });
  });

  it('加好友連結', () => {
    expect(lineAddFriendUrl('@123abcde')).toBe('https://line.me/R/ti/p/%40123abcde');
    expect(lineAddFriendUrl('123abcde')).toBe('https://line.me/R/ti/p/%40123abcde');
  });
});
