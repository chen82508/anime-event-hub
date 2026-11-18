/**
 * robots.txt 解析與判定（RFC 9309）。純函式。
 *
 * - 群組以 User-agent 的 product token 比對（不分大小寫）；找不到時退回 `*`。
 * - Allow / Disallow 以「最長匹配」決定，等長時 Allow 優先；支援 `*` 與結尾 `$`。
 * - 另讀取非標準的 Crawl-delay（秒），供節流參考。
 */

export interface RobotsRule {
  allow: boolean;
  /** 原始 path pattern（已做百分比編碼正規化） */
  pattern: string;
  regex: RegExp;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySec: number | null;
}

export interface RobotsTxt {
  groups: RobotsGroup[];
  sitemaps: string[];
}

/** 判定時的特殊狀態（RFC 9309 §2.3.1）：4xx → 全部允許；5xx/網路錯誤 → 全部禁止 */
export const ALLOW_ALL: RobotsTxt = { groups: [], sitemaps: [] };
export const DISALLOW_ALL: RobotsTxt = {
  groups: [{ agents: ['*'], rules: [compileRule(false, '/')], crawlDelaySec: null }],
  sitemaps: [],
};

function normalizePath(p: string): string {
  // 統一百分比編碼大小寫，並把非 ASCII 字元編碼，讓規則與 URL 以相同形式比較
  return p
    .replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase())
    .replace(/[^\x21-\x7E]/gu, (c) => encodeURIComponent(c));
}

function compileRule(allow: boolean, rawPattern: string): RobotsRule {
  const pattern = normalizePath(rawPattern);
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return { allow, pattern, regex: new RegExp(`^${source}${anchored ? '$' : ''}`) };
}

/** 解析 robots.txt 內容 */
export function parseRobotsTxt(text: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (!current) continue; // 群組外的規則忽略
    if (key === 'allow' || key === 'disallow') {
      // 空的 Disallow 代表不限制
      if (value === '') continue;
      current.rules.push(compileRule(key === 'allow', value));
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
    }
  }
  return { groups, sitemaps };
}

/** UA 字串 → product token（`AnimeEventHubTW-Bot/0.1 (+...)` → `animeeventhubtw-bot`） */
export function productToken(userAgent: string): string {
  return (userAgent.trim().split(/[\s/]/)[0] ?? '').toLowerCase();
}

/** 取適用於此 UA 的群組：先找 product token 完全相同者，否則 `*`（同名多群組合併） */
export function selectGroup(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const token = productToken(userAgent);
  const pick = (name: string) => robots.groups.filter((g) => g.agents.includes(name));
  let matched = pick(token);
  if (matched.length === 0) matched = pick('*');
  if (matched.length === 0) return null;
  return {
    agents: matched.flatMap((g) => g.agents),
    rules: matched.flatMap((g) => g.rules),
    crawlDelaySec: matched.reduce<number | null>(
      (acc, g) => (g.crawlDelaySec === null ? acc : Math.max(acc ?? 0, g.crawlDelaySec)),
      null,
    ),
  };
}

export interface RobotsDecision {
  allowed: boolean;
  /** 決定結果的規則（無規則命中時為 null） */
  rule: RobotsRule | null;
}

/** 判斷 path（含 query）是否允許擷取 */
export function isAllowedByRobots(
  robots: RobotsTxt,
  userAgent: string,
  pathWithQuery: string,
): RobotsDecision {
  const group = selectGroup(robots, userAgent);
  if (!group) return { allowed: true, rule: null };
  const path = normalizePath(pathWithQuery || '/');
  if (path === '/robots.txt') return { allowed: true, rule: null };
  let best: RobotsRule | null = null;
  for (const rule of group.rules) {
    if (!rule.regex.test(path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return { allowed: best ? best.allow : true, rule: best };
}

export function crawlDelayMs(robots: RobotsTxt, userAgent: string): number | null {
  const sec = selectGroup(robots, userAgent)?.crawlDelaySec;
  return sec === null || sec === undefined ? null : Math.round(sec * 1000);
}
