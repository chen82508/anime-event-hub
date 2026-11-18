/**
 * 日期與時間解析（tech-spec T4、R1–R3、R5）。
 *
 * 原則：
 * - 一律以 Asia/Taipei 解讀（R1）；不使用 `new Date(string)`。
 * - 無法唯一決定 → `ambiguous`，不猜（C4）。
 * - 缺年份：以基準日（公告日優先，否則擷取日）為準，取「結束日 ≥ 基準日」的最近年份；
 *   推論出的日期離基準日超過 `maxForwardDays` 視為異常 → ambiguous（R2）。
 *
 * 支援格式：西元/民國年（`2026/11/16`、`2026-11-16`、`2026.11.16`、`2026年11月16日`、`115年11月16日`、`115/11/16`）、
 * `11/16(六)`、`11月16日`、`十一月十六日`、全形數字、區間（`11/16–11/20`、`11/16-20`、跨月、跨年）、
 * 連續日期列舉（`11/16(六)、11/17(日)`）、`即日起至…`、時間 `19:30` / `下午7點半` / `7:30PM` / `19時30分`、
 * 時段 `10:00-18:00`、`18:00開場 19:00開演`（取開演）。
 */
import { TIMEZONE } from '@aeh/core';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { cleanText } from './text';

// ── 型別 ──────────────────────────────────────────────────

export interface DateParseOptions {
  /**
   * 缺年份推論的基準日（台灣日曆日 YYYY-MM-DD）。
   * 傳入公告發布日（`RawEventCandidate.publishedOn`）；沒有時才用擷取日。
   */
  referenceDate: string;
  /**
   * 推論年份後距基準日超過此天數 → ambiguous（R2「差距異常」）。預設 240（約 8 個月）：
   * 公告日之後兩個多月才發的回顧文（如 11/18 發布「9/1 活動花絮」）不會被誤推成隔年。
   */
  maxForwardDays?: number;
  /** 活動區間最長天數，超過 → ambiguous。預設 366 */
  maxSpanDays?: number;
}

export interface ParsedEventDate {
  /** 台灣日曆日 YYYY-MM-DD */
  startDate: string;
  endDate: string | null;
  /** HH:mm（台灣時間）；無時刻為 null */
  startTime: string | null;
  endTime: string | null;
  startAt: Date;
  /**
   * - 有結束時刻：結束日（或開始日）的該時刻
   * - 全天活動且為區間：結束日 23:59:59（含當日）
   * - 單日且無結束時刻：null
   */
  endAt: Date | null;
  /** 無時刻，以日曆日解讀（R1） */
  allDay: boolean;
  /** 年份由基準日推論而非明載（R2） */
  yearInferred: boolean;
  /** `即日起至…`：開始日取基準日 */
  openStart: boolean;
}

export type DateParseResult =
  | { kind: 'ok'; value: ParsedEventDate }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'missing' };

export const DEFAULT_MAX_FORWARD_DAYS = 240;

// ── 公用工具 ──────────────────────────────────────────────

const DAY_MS = 86_400_000;

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatYmd({ y, m, d }: Ymd): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function isValidYmd({ y, m, d }: Ymd): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** 日序（只用於比較與相減，與時區無關） */
function dayNumber({ y, m, d }: Ymd): number {
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** 0 = 週日 … 6 = 週六 */
function weekdayOf(ymd: Ymd): number {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(s: string): Ymd | null {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return null;
  const ymd = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return isValidYmd(ymd) ? ymd : null;
}

/** 台灣時間的某日某時刻 → UTC Date */
export function taipeiDateTime(date: string, time = '00:00', seconds = 0): Date {
  return fromZonedTime(`${date}T${time}:${pad2(seconds)}`, TIMEZONE);
}

/** Date → 台灣日曆日 YYYY-MM-DD（例如由擷取時間求基準日） */
export function taipeiDateString(at: Date): string {
  return formatInTimeZone(at, TIMEZONE, 'yyyy-MM-dd');
}

// ── 前處理 ────────────────────────────────────────────────

const CN_DIGIT: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 中文數字（≤ 99）→ 整數；不支援者回傳 null */
export function chineseNumeralToInt(s: string): number | null {
  if (s.length === 0) return null;
  if (s === '廿') return 20;
  if (s === '卅') return 30;
  const tensPrefix = s[0] === '廿' ? 2 : s[0] === '卅' ? 3 : null;
  if (tensPrefix !== null) {
    const rest = s.slice(1);
    const unit = CN_DIGIT[rest];
    return rest.length === 1 && unit !== undefined ? tensPrefix * 10 + unit : null;
  }
  const idx = s.indexOf('十');
  if (idx === -1) {
    // 逐位：一一五 → 115（僅用於少見的年份寫法）
    let n = 0;
    for (const ch of s) {
      const v = CN_DIGIT[ch];
      if (v === undefined) return null;
      n = n * 10 + v;
    }
    return n;
  }
  if (s.indexOf('十', idx + 1) !== -1) return null;
  const tensPart = s.slice(0, idx);
  const unitPart = s.slice(idx + 1);
  const tens = tensPart === '' ? 1 : CN_DIGIT[tensPart];
  const unit = unitPart === '' ? 0 : CN_DIGIT[unitPart];
  if (tens === undefined || unit === undefined || tensPart.length > 1 || unitPart.length > 1) {
    return null;
  }
  return tens * 10 + unit;
}

/**
 * 只轉換緊接在 年/月/日/號/點/時/分 之前的中文數字。
 * 「週六」「(日)」之類的星期不受影響（前面是 週/周/期/拜/括號 時不轉換）。
 */
const CN_NUMERAL_RE =
  /(?<![週周期拜(（])([〇零一二兩三四五六七八九十廿卅]+)(?=\s*[年月日號号點点時时分])/gu;

function convertChineseNumerals(s: string): string {
  return s.replace(CN_NUMERAL_RE, (all, num: string) => {
    const n = chineseNumeralToInt(num);
    return n === null ? all : String(n);
  });
}

/** 區間連接符統一成 `~`（ASCII `-` 保留，因為 ISO 日期也用它） */
const RANGE_DASH_RE = /[–—―‐‑−〜]/gu;

function preprocess(s: string): string {
  return convertChineseNumerals(cleanText(s)).replace(RANGE_DASH_RE, '~');
}

// ── 日期 token ────────────────────────────────────────────

interface DateToken {
  y: number | null;
  m: number;
  d: number;
  /** 只有「日」（如 `11/16-20` 的 20、`12月12 / 13日` 的 13），月份沿用前一個 token */
  dayOnly: boolean;
  /** dayOnly 與前一個 token 的關係：`-` 為區間、`、` `/` 為列舉 */
  dayOnlyLink?: 'range' | 'list';
  /** 0–6，來源標註的星期 */
  weekday: number | null;
  start: number;
  end: number;
}

const FULL_SEP_RE = /(民國\s*)?(\d{3,4})([/.-])(\d{1,2})\3(\d{1,2})(?!\d)/y;
const FULL_CJK_RE = /(民國\s*)?(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/y;
const MD_CJK_RE = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/y;
const MD_SEP_RE = /(\d{1,2})[/.](\d{1,2})(?![\d:]|[/.]\d)/y;
const DAY_ONLY_RE = /(\d{1,2})\s*[日號号]?(?![\d/.:月點点時])/y;
const RANGE_SEP_RE = /\s*(?:起\s*)?(?:~|-|至|到)\s*/y;
/** `12月12 / 13日`、`12/5、6`：列舉分隔後只有「日」 */
const LIST_DAY_SEP_RE = /\s*[、,，/&]\s*/y;

const WEEKDAY_CN: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};
const WEEKDAY_EN: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};
const WEEKDAY_PAREN_RE = /\s*[(（[]\s*(?:週|周|星期|禮拜)?\s*([一二三四五六日天])\s*[)）\]]/y;
const WEEKDAY_BARE_RE = /\s*(?:週|周|星期|禮拜)([一二三四五六日天])/y;
const WEEKDAY_EN_RE =
  /\s*[(（]?\s*(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?\.?(?![a-z])\s*[)）]?/iy;

function execAt(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}

/** 年份字串 → 西元年；民國年（含 3 位數年份）+1911。不合理者回傳 null */
function toGregorianYear(raw: string, roc: boolean): number | null {
  const n = Number(raw);
  if (roc || raw.length === 3) {
    const y = n + 1911;
    return y >= 1990 && y <= 2100 ? y : null;
  }
  if (raw.length === 4 && n >= 1990 && n <= 2100) return n;
  return null;
}

function readWeekday(s: string, i: number): { weekday: number; end: number } | null {
  for (const re of [WEEKDAY_PAREN_RE, WEEKDAY_BARE_RE]) {
    const m = execAt(re, s, i);
    if (m) return { weekday: WEEKDAY_CN[m[1] as string] as number, end: re.lastIndex };
  }
  const m = execAt(WEEKDAY_EN_RE, s, i);
  if (m) {
    return {
      weekday: WEEKDAY_EN[(m[1] as string).toLowerCase()] as number,
      end: WEEKDAY_EN_RE.lastIndex,
    };
  }
  return null;
}

/** 在位置 i 嘗試讀一個完整日期（年月日或月日） */
function readDateAt(s: string, i: number): Omit<DateToken, 'weekday' | 'dayOnly'> | null {
  if (i > 0 && /\d/.test(s[i - 1] as string)) return null;
  let m = execAt(FULL_SEP_RE, s, i);
  if (m) {
    const y = toGregorianYear(m[2] as string, m[1] !== undefined);
    if (y !== null)
      return { y, m: Number(m[4]), d: Number(m[5]), start: i, end: FULL_SEP_RE.lastIndex };
  }
  m = execAt(FULL_CJK_RE, s, i);
  if (m) {
    const y = toGregorianYear(m[2] as string, m[1] !== undefined);
    if (y !== null)
      return { y, m: Number(m[3]), d: Number(m[4]), start: i, end: FULL_CJK_RE.lastIndex };
  }
  m = execAt(MD_CJK_RE, s, i);
  if (m) return { y: null, m: Number(m[1]), d: Number(m[2]), start: i, end: MD_CJK_RE.lastIndex };
  m = execAt(MD_SEP_RE, s, i);
  if (m) return { y: null, m: Number(m[1]), d: Number(m[2]), start: i, end: MD_SEP_RE.lastIndex };
  return null;
}

function scanDateTokens(s: string): DateToken[] {
  const tokens: DateToken[] = [];
  let i = 0;
  while (i < s.length) {
    const base = readDateAt(s, i);
    if (!base) {
      i += 1;
      continue;
    }
    const wd = readWeekday(s, base.end);
    const token: DateToken = {
      ...base,
      dayOnly: false,
      weekday: wd?.weekday ?? null,
      end: wd?.end ?? base.end,
    };
    tokens.push(token);
    i = token.end;

    // `11/16-20`：連接符後只有「日」；`12月12 / 13日`、`12/5、6、7`：列舉後只有「日」
    for (let first = true; ; first = false) {
      const last = tokens[tokens.length - 1] as DateToken;
      let link: 'range' | 'list' | null = null;
      let at = i;
      if (first && execAt(RANGE_SEP_RE, s, i)) {
        link = 'range';
        at = RANGE_SEP_RE.lastIndex;
      } else if ((first || last.dayOnlyLink === 'list') && execAt(LIST_DAY_SEP_RE, s, i)) {
        link = 'list';
        at = LIST_DAY_SEP_RE.lastIndex;
      }
      if (!link || readDateAt(s, at)) break;
      const dm = execAt(DAY_ONLY_RE, s, at);
      if (!dm) break;
      const wd2 = readWeekday(s, DAY_ONLY_RE.lastIndex);
      const end = wd2?.end ?? DAY_ONLY_RE.lastIndex;
      tokens.push({
        y: null,
        m: token.m,
        d: Number(dm[1]),
        dayOnly: true,
        dayOnlyLink: link,
        weekday: wd2?.weekday ?? null,
        start: at,
        end,
      });
      i = end;
      if (link === 'range') break;
    }
  }
  return tokens;
}

// ── 時間 token ────────────────────────────────────────────

interface TimeToken {
  h: number;
  min: number;
  label: 'start' | 'door' | null;
  start: number;
  end: number;
}

const TIME_RE =
  /(上午|早上|中午|下午|午後|晚上|傍晚|凌晨|夜間|am|pm|a\.m\.|p\.m\.)?\s*(\d{1,2})\s*(?::\s*(\d{2})|[點点時时]\s*(?:(半)|(\d{1,2})\s*分?)?)\s*(am|pm|a\.m\.|p\.m\.)?|(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)/giu;

const TIME_RANGE_RE = new RegExp(
  `(?:${TIME_RE.source})\\s*(?:~|-|至|到)\\s*(?:${TIME_RE.source})`,
  'giu',
);
const LABEL_RE = /(開演|演出開始|開唱|start)|(開場|入場|進場|報到|open)/giu;
const LABEL_WINDOW = 6;

/** 取距離時間 token 最近的標籤（`開場18:00／開演19:00`、`18:00開場 19:00開演` 都能正確對應） */
function nearestLabel(s: string, start: number, end: number): TimeToken['label'] {
  let best: { dist: number; label: 'start' | 'door' } | null = null;
  const from = Math.max(0, start - LABEL_WINDOW);
  const to = Math.min(s.length, end + LABEL_WINDOW);
  for (const m of s.slice(from, to).matchAll(LABEL_RE)) {
    const ls = from + m.index;
    const le = ls + m[0].length;
    if (ls < end && le > start) continue;
    const gapText = le <= start ? s.slice(le, start) : s.slice(end, ls);
    // 標籤與時間之間隔著分隔符（`開放入場／18:00`）→ 該標籤屬於另一個時間
    const dist = gapText.length + (/[/|,，、;；]/u.test(gapText) ? 100 : 0);
    const label = m[1] !== undefined ? 'start' : 'door';
    // 同距離時以後方標籤為準（`19:00開演` 的寫法較常見）
    if (!best || dist < best.dist || (dist === best.dist && ls >= end)) best = { dist, label };
  }
  return best?.label ?? null;
}

function applyPeriod(h: number, period: string | undefined): number | null {
  if (h > 24) return null;
  if (!period) return h;
  const p = period.toLowerCase().replaceAll('.', '');
  if (p === 'pm' || p === '下午' || p === '午後' || p === '晚上' || p === '傍晚' || p === '夜間') {
    return h < 12 ? h + 12 : h;
  }
  if (p === '中午') return h === 12 ? 12 : h < 6 ? h + 12 : h;
  if (p === 'am' || p === '上午' || p === '早上' || p === '凌晨') return h === 12 ? 0 : h;
  return h;
}

function scanTimeTokens(s: string): TimeToken[] | 'invalid' {
  const tokens: TimeToken[] = [];
  for (const m of s.matchAll(TIME_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > 0 && /\d/.test(s[start - 1] as string)) continue;
    let h: number | null;
    let min: number;
    if (m[7] !== undefined) {
      h = applyPeriod(Number(m[7]), m[8]);
      min = 0;
    } else {
      h = applyPeriod(Number(m[2]), m[1] ?? m[6]);
      min =
        m[3] !== undefined
          ? Number(m[3])
          : m[4] !== undefined
            ? 30
            : m[5] !== undefined
              ? Number(m[5])
              : 0;
    }
    if (h === null || min > 59 || (h === 24 && min > 0)) return 'invalid';
    tokens.push({ h, min, label: nearestLabel(s, start, end), start, end });
  }
  return tokens;
}

function fmtTime(t: TimeToken): string {
  // 24:00 視為當日 23:59（例如營業至 24:00）
  return t.h === 24 ? '23:59' : `${pad2(t.h)}:${pad2(t.min)}`;
}

type TimeResolution =
  | { kind: 'ok'; startTime: string | null; endTime: string | null }
  | { kind: 'ambiguous'; reason: string };

const TIME_RANGE_GAP_RE = /^\s*(?:~|-|至|到)\s*$/u;

function resolveTimes(s: string): TimeResolution {
  const scanned = scanTimeTokens(s);
  if (scanned === 'invalid') return { kind: 'ambiguous', reason: '時間格式不合法' };
  let tokens = scanned;
  if (tokens.length === 0) return { kind: 'ok', startTime: null, endTime: null };

  // 開場/入場時間只是參考；有其它時間時捨去
  if (tokens.some((t) => t.label !== 'door')) tokens = tokens.filter((t) => t.label !== 'door');
  const labeled = tokens.filter((t) => t.label === 'start');
  if (labeled.length === 1) {
    const st = labeled[0] as TimeToken;
    const idx = tokens.indexOf(st);
    const next = tokens[idx + 1];
    const endTime =
      next && TIME_RANGE_GAP_RE.test(s.slice(st.end, next.start)) ? fmtTime(next) : null;
    return { kind: 'ok', startTime: fmtTime(st), endTime };
  }
  if (labeled.length > 1) return { kind: 'ambiguous', reason: '有多個開演時間（可能為多場次）' };

  if (tokens.length === 1)
    return { kind: 'ok', startTime: fmtTime(tokens[0] as TimeToken), endTime: null };
  if (tokens.length === 2) {
    const [a, b] = tokens as [TimeToken, TimeToken];
    if (TIME_RANGE_GAP_RE.test(s.slice(a.end, b.start))) {
      return { kind: 'ok', startTime: fmtTime(a), endTime: fmtTime(b) };
    }
  }
  return { kind: 'ambiguous', reason: '有多個時間（可能為多場次）' };
}

/**
 * 逐日列出時刻（`12/5（六）10:30–17:00 12/6（日）10:30–17:00`、`11/28 18:00開演 11/29 18:00開演`）：
 * 每個日期後面各自有可解析的時刻 → 開始取第一天、結束取最後一天。不符合此型態時回傳 null。
 */
function resolvePerDayTimes(
  text: string,
  tokens: DateToken[],
  links: ('range' | 'list' | 'other')[],
  timeExtra: string,
): TimeResolution | null {
  if (tokens.length < 2 || timeExtra.length > 0 || links.some((l) => l !== 'list')) return null;
  const perDay: { startTime: string; endTime: string | null }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const seg = text.slice((tokens[i] as DateToken).end, tokens[i + 1]?.start ?? text.length);
    const r = resolveTimes(seg);
    if (r.kind !== 'ok' || r.startTime === null) return null;
    perDay.push({ startTime: r.startTime, endTime: r.endTime });
  }
  return {
    kind: 'ok',
    startTime: (perDay[0] as { startTime: string }).startTime,
    endTime: (perDay[perDay.length - 1] as { endTime: string | null }).endTime,
  };
}

// ── 日期分組與年份推論 ────────────────────────────────────

const MISSING_RE =
  /(未定|待定|另行公告|另行通知|另行公布|待公布|敬請期待|coming\s*soon|\btba\b|\btbd\b)/iu;
const OPEN_START_RE = /(即日起|即日|現正|開跑中)/u;
const LIST_GAP_RE = /^[\s、,，&和及與/／・·]*$/u;
const RANGE_GAP_RE = /^\s*(?:起\s*)?(?:~|-|至|到)\s*$/u;
/** 日期之間可忽略的填充字 */
const GAP_FILLER_RE =
  /(起|止|開始|結束|為止|截止|期間|開放入場|正式開演|開場|開演|入場|進場|open|start)/giu;

function md(t: { m: number; d: number }): number {
  return t.m * 100 + t.d;
}

type Ok<T> = { ok: true; value: T } | { ok: false; reason: string };

/** 依明載年份前後傳遞，補齊整組 token 的年份（假設 token 依時間順序排列） */
/** 回傳因跨年推論而年份不同的相鄰 token 索引（i 與 i+1） */
function fillYearsFromKnown(tokens: DateToken[]): Set<number> {
  const wrapped = new Set<number>();
  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1] as DateToken;
    const cur = tokens[i] as DateToken;
    if (cur.y === null && prev.y !== null) {
      const wrap = md(cur) < md(prev);
      cur.y = prev.y + (wrap ? 1 : 0);
      if (wrap) wrapped.add(i - 1);
    }
  }
  for (let i = tokens.length - 2; i >= 0; i--) {
    const next = tokens[i + 1] as DateToken;
    const cur = tokens[i] as DateToken;
    if (cur.y === null && next.y !== null) {
      const wrap = md(cur) > md(next);
      cur.y = next.y - (wrap ? 1 : 0);
      if (wrap) wrapped.add(i);
    }
  }
  return wrapped;
}

/** 跨年推論只接受合理的短區間（如 12/28–1/3）；`11/16–11/10` 這類不視為跨年 */
const MAX_WRAP_SPAN_DAYS = 183;

function resolveYears(
  tokens: DateToken[],
  ref: Ymd,
  maxForwardDays: number,
): Ok<{ dates: Ymd[]; inferred: boolean }> {
  let inferred = false;
  if (tokens.every((t) => t.y === null)) {
    // 以最後一個日期（結束日）為錨點：取 ≥ 基準日的最近年份（R2）
    const anchor = tokens[tokens.length - 1] as DateToken;
    let y = ref.y;
    if (dayNumber({ y, m: anchor.m, d: anchor.d }) < dayNumber(ref)) y += 1;
    const anchorYmd = { y, m: anchor.m, d: anchor.d };
    if (!isValidYmd(anchorYmd)) return { ok: false, reason: `日期不存在：${anchor.m}/${anchor.d}` };
    const ahead = dayNumber(anchorYmd) - dayNumber(ref);
    if (ahead > maxForwardDays) {
      return {
        ok: false,
        reason: `未標年份，推論為 ${formatYmd(anchorYmd)}，距基準日 ${ahead} 天（可能是已結束的活動）`,
      };
    }
    anchor.y = y;
    inferred = true;
  }
  const wrapped = fillYearsFromKnown(tokens);

  const dates: Ymd[] = [];
  for (const t of tokens) {
    const ymd = { y: t.y as number, m: t.m, d: t.d };
    if (!isValidYmd(ymd)) return { ok: false, reason: `日期不存在：${formatYmd(ymd)}` };
    if (t.weekday !== null && weekdayOf(ymd) !== t.weekday) {
      return { ok: false, reason: `${formatYmd(ymd)} 與標註的星期不符` };
    }
    dates.push(ymd);
  }
  for (const i of wrapped) {
    const a = dates[i] as Ymd;
    const b = dates[i + 1] as Ymd;
    if (a.m === b.m || dayNumber(b) - dayNumber(a) > MAX_WRAP_SPAN_DAYS) {
      return { ok: false, reason: `日期順序異常：${formatYmd(a)} → ${b.m}/${b.d}` };
    }
  }
  return { ok: true, value: { dates, inferred } };
}

// ── 主函式 ────────────────────────────────────────────────

/**
 * 解析活動日期與時間。
 *
 * @param dateText 日期文字（可含時間），如 `2026/11/16(一) 19:30`
 * @param timeText 另外提供的時間文字（如 KKTIX 的「時間」欄），可省略
 */
export function parseEventDate(
  dateText: string | null | undefined,
  timeText: string | null | undefined,
  options: DateParseOptions,
): DateParseResult {
  const ref = parseIsoDate(options.referenceDate);
  if (!ref) throw new Error(`referenceDate 必須是 YYYY-MM-DD：${options.referenceDate}`);
  const maxForwardDays = options.maxForwardDays ?? DEFAULT_MAX_FORWARD_DAYS;
  const maxSpanDays = options.maxSpanDays ?? 366;

  const text = preprocess(dateText ?? '');
  const timeExtra = preprocess(timeText ?? '');
  if (text.length === 0) return { kind: 'missing' };

  const tokens = scanDateTokens(text);
  if (tokens.length === 0) {
    if (MISSING_RE.test(text)) return { kind: 'missing' };
    if (/\d{1,2}\s*月/u.test(text) || /(上旬|中旬|下旬|月底|月初|年底|年初)/u.test(text)) {
      return { kind: 'ambiguous', reason: '只有月份或模糊時段，沒有確切日期' };
    }
    return { kind: 'ambiguous', reason: `無法辨識日期：${text}` };
  }

  // 去掉日期 token 後的剩餘文字（找時間用）
  let rest = '';
  let cursor = 0;
  for (const t of tokens) {
    rest += text.slice(cursor, t.start) + ' ';
    cursor = t.end;
  }
  rest += text.slice(cursor);

  // 同一日期重複出現（`11/1南部首亮相！11/1 高雄…`）→ 視為單一日期
  const firstTok = tokens[0] as DateToken;
  if (
    tokens.length > 1 &&
    tokens.every(
      (t) =>
        !t.dayOnly &&
        t.m === firstTok.m &&
        t.d === firstTok.d &&
        (t.y === null || firstTok.y === null || t.y === firstTok.y),
    )
  ) {
    const y = tokens.find((t) => t.y !== null)?.y ?? null;
    tokens.splice(1);
    firstTok.y = y;
  }

  // 判斷 token 之間的關係：區間 / 列舉 / 其它
  const links: ('range' | 'list' | 'other')[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1] as DateToken;
    const cur = tokens[i] as DateToken;
    if (cur.dayOnly) {
      links.push(cur.dayOnlyLink ?? 'range');
      continue;
    }
    // 先移除時段（10:00-18:00），避免其中的連接符被當成日期區間
    const gap = text
      .slice(prev.end, cur.start)
      .replace(TIME_RANGE_RE, ' ')
      .replace(TIME_RE, ' ')
      .replace(GAP_FILLER_RE, ' ');
    links.push(RANGE_GAP_RE.test(gap) ? 'range' : LIST_GAP_RE.test(gap) ? 'list' : 'other');
  }
  if (links.includes('other')) return { kind: 'ambiguous', reason: '包含多組日期' };
  if (links.includes('range') && tokens.length > 2) {
    return { kind: 'ambiguous', reason: '包含多個日期區間（可能為多場次）' };
  }

  // 即日起至 X / ~X 止：只有一個日期且位於結束位置
  const head = text.slice(0, (tokens[0] as DateToken).start);
  const openStart =
    tokens.length === 1 && (OPEN_START_RE.test(head) || /(?:~|-|至|到)\s*$/u.test(head));

  // `11/30-2` 這種「日」比開始日小的寫法無法判斷是否跨月 → 不猜
  for (let i = 1; i < tokens.length; i++) {
    const cur = tokens[i] as DateToken;
    if (cur.dayOnly && cur.d <= (tokens[i - 1] as DateToken).d) {
      return { kind: 'ambiguous', reason: '區間結束日小於開始日，無法判斷是否跨月' };
    }
  }
  const resolved = resolveYears(tokens, ref, maxForwardDays);
  if (!resolved.ok) return { kind: 'ambiguous', reason: resolved.reason };
  const { dates, inferred } = resolved.value;

  let startYmd: Ymd;
  let endYmd: Ymd | null;
  if (openStart) {
    startYmd = ref;
    endYmd = dates[0] as Ymd;
  } else if (dates.length === 1) {
    startYmd = dates[0] as Ymd;
    endYmd = null;
  } else if (links[0] === 'range') {
    startYmd = dates[0] as Ymd;
    endYmd = dates[1] as Ymd;
  } else {
    // 列舉：必須是連續日期，才合併成單一區間（R5）
    for (let i = 1; i < dates.length; i++) {
      if (dayNumber(dates[i] as Ymd) - dayNumber(dates[i - 1] as Ymd) !== 1) {
        return { kind: 'ambiguous', reason: '列舉的日期不連續（可能為多場次）' };
      }
    }
    startYmd = dates[0] as Ymd;
    endYmd = dates[dates.length - 1] as Ymd;
  }

  if (endYmd) {
    const span = dayNumber(endYmd) - dayNumber(startYmd);
    if (span < 0) return { kind: 'ambiguous', reason: '結束日早於開始日' };
    if (span > maxSpanDays) return { kind: 'ambiguous', reason: `區間長達 ${span} 天` };
    if (span === 0) endYmd = null;
  }

  const times =
    resolvePerDayTimes(text, tokens, links, timeExtra) ?? resolveTimes(`${rest} ${timeExtra}`);
  if (times.kind === 'ambiguous') return times;

  const startDate = formatYmd(startYmd);
  const endDate = endYmd ? formatYmd(endYmd) : null;
  const allDay = times.startTime === null;
  const startAt = taipeiDateTime(startDate, times.startTime ?? '00:00');
  let endAt: Date | null = null;
  if (times.endTime !== null) {
    endAt = taipeiDateTime(endDate ?? startDate, times.endTime, times.endTime === '23:59' ? 59 : 0);
  } else if (endDate !== null) {
    endAt = taipeiDateTime(endDate, '23:59', 59);
  }
  if (endAt && endAt < startAt)
    return { kind: 'ambiguous', reason: '結束時間早於開始時間（可能跨夜）' };

  return {
    kind: 'ok',
    value: {
      startDate,
      endDate,
      startTime: times.startTime,
      endTime: times.endTime,
      startAt,
      endAt,
      allDay,
      yearInferred: inferred,
      openStart,
    },
  };
}

export type SaleParseResult =
  | { kind: 'ok'; at: Date; yearInferred: boolean }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'missing' };

/**
 * 開賣時間（如 `10/1(四) 12:00 開賣`、`售票期間 2026/10/01 12:00 ~ 11/15`）。
 * 取區間的開始；沒有時刻時取當日 00:00（台灣時間）。
 */
export function parseSaleStart(
  text: string | null | undefined,
  options: DateParseOptions,
): SaleParseResult {
  const r = parseEventDate(text, undefined, options);
  if (r.kind !== 'ok') return r;
  if (r.value.openStart) return { kind: 'ambiguous', reason: '開賣時間為「即日起」' };
  return { kind: 'ok', at: r.value.startAt, yearInferred: r.value.yearInferred };
}
