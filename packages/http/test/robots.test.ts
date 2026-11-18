import { describe, expect, it } from 'vitest';
import {
  ALLOW_ALL,
  DISALLOW_ALL,
  crawlDelayMs,
  isAllowedByRobots,
  parseRobotsTxt,
  productToken,
  selectGroup,
} from '../src';

const UA = 'AnimeEventHubTW-Bot/0.1 (+https://example.invalid/contact)';
const allowed = (txt: string, path: string, ua = UA) =>
  isAllowedByRobots(parseRobotsTxt(txt), ua, path).allowed;

describe('parseRobotsTxt / isAllowedByRobots（RFC 9309）', () => {
  const txt = `
# comment
User-agent: *
Disallow: /admin/
Disallow: /search
Allow: /search/about
Disallow: /*.pdf$
Disallow: /private*/secret
Crawl-delay: 5

User-agent: BadBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
`;

  it.each([
    ['/', true],
    ['/events/123', true],
    ['/admin/', false],
    ['/admin/users', false],
    ['/administrator', true],
    ['/search', false],
    ['/search?q=x', false],
    ['/search/about', true],
    ['/files/a.pdf', false],
    ['/files/a.pdf?x=1', true],
    ['/private-zone/secret', false],
    ['/robots.txt', true],
  ])('%s → %s', (path, ok) => {
    expect(allowed(txt, path)).toBe(ok);
  });

  it('依 UA product token 選擇群組，找不到時退回 *', () => {
    expect(allowed(txt, '/events', 'BadBot/2.0')).toBe(false);
    expect(allowed(txt, '/events', UA)).toBe(true);
  });

  it('最長匹配優先；等長時 Allow 優先', () => {
    const t = 'User-agent: *\nDisallow: /page\nAllow: /page\nDisallow: /a\nAllow: /a/b';
    expect(allowed(t, '/page')).toBe(true);
    expect(allowed(t, '/a/b/c')).toBe(true);
    expect(allowed(t, '/a/c')).toBe(false);
  });

  it('空的 Disallow 代表不限制', () => {
    expect(allowed('User-agent: *\nDisallow:', '/anything')).toBe(true);
  });

  it('連續的 User-agent 行共用同一組規則', () => {
    const t = 'User-agent: a\nUser-agent: animeeventhubtw-bot\nDisallow: /x';
    expect(allowed(t, '/x')).toBe(false);
  });

  it('百分比編碼與非 ASCII 路徑以相同形式比較', () => {
    const t = 'User-agent: *\nDisallow: /活動/';
    expect(allowed(t, '/%E6%B4%BB%E5%8B%95/1')).toBe(false);
    expect(allowed(t, '/%e6%b4%bb%e5%8b%95/1')).toBe(false);
  });

  it('Crawl-delay 與 Sitemap', () => {
    const robots = parseRobotsTxt(txt);
    expect(crawlDelayMs(robots, UA)).toBe(5000);
    expect(crawlDelayMs(robots, 'BadBot')).toBeNull();
    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('ALLOW_ALL / DISALLOW_ALL', () => {
    expect(isAllowedByRobots(ALLOW_ALL, UA, '/x').allowed).toBe(true);
    expect(isAllowedByRobots(DISALLOW_ALL, UA, '/x').allowed).toBe(false);
  });

  it('productToken / selectGroup', () => {
    expect(productToken(UA)).toBe('animeeventhubtw-bot');
    expect(selectGroup(parseRobotsTxt(''), UA)).toBeNull();
  });
});
