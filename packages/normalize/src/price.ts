/**
 * 票價解析（tech-spec T4）：`NT$1,200`、`$800 / $1,500`、`免費入場`、`預售/現場` → min / max / isFree。
 *
 * 規則：
 * - 金額需有幣別標示（`NT$`、`$`、`NTD`、`TWD`、`新台幣`）或「元」，或緊接在票種標籤後（`預售 800`）；
 *   避免把「限量 100 張」「每人限購 4 張」當成票價。
 * - `NT$800~1,500` 的區間上限可省略幣別。
 * - 只寫免費 → isFree = true、min = max = 0；免費入場但另有付費票種 → isFree = false、min = 0。
 * - 金額超過上限（預設 200,000）視為解析錯誤 → ambiguous。
 */
import { cleanText } from './text';

export interface ParsedPrice {
  min: number;
  max: number;
  isFree: boolean;
  /** 解析出的所有金額（依出現順序，未去重），供除錯 */
  amounts: number[];
}

export type PriceParseResult =
  { kind: 'ok'; value: ParsedPrice } | { kind: 'ambiguous'; reason: string } | { kind: 'missing' };

export interface PriceParseOptions {
  /** 單一金額上限，預設 200,000 */
  maxAmount?: number;
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)`;
/** 幣別在前：NT$1,200、NTD 800、新台幣 500 元 */
const CURRENCY_PREFIX_RE = new RegExp(
  String.raw`(?:NT\s*\$|NTD|TWD|新台幣|台幣|臺幣|\$)\s*${NUM}(?:\s*(?:元|圓))?(?:\s*(?:~|-|–|〜|至|到)\s*(?:NT\s*\$|\$)?\s*${NUM}(?!\s*(?:張|人|名|位|組|份|日|天)))?`,
  'giu',
);
/** 「元」在後：1,200元 */
const YUAN_SUFFIX_RE = new RegExp(String.raw`(?<![\d,$])${NUM}\s*(?:元|圓)(?!\s*起)`, 'gu');
/** 「元起」：800元起 → 只知道下限 */
const YUAN_FROM_RE = new RegExp(String.raw`(?<![\d,$])${NUM}\s*(?:元|圓)\s*起`, 'gu');
/** 票種標籤後的裸數字：預售 800 / 現場：1000 */
const LABELED_RE = new RegExp(
  String.raw`(?:預售|現場|全票|優待票|學生票|早鳥|一般|單日|兩日|二日|雙日|套票|VIP|搖滾區|身障|愛心|票價|門票|入場券)\s*(?:票|券|價|席|區)?\s*[:：]?\s*${NUM}(?![\d.]|\s*(?:張|人|名|位|組|份|日|天|%|折))`,
  'giu',
);

const FREE_RE =
  /(免費|免入場費|免門票|免票|不收費|自由入場|入場無料|入場免費|free\s*(?:entry|admission)?\b)/iu;
const MISSING_RE = /(未定|待定|另行公告|另行通知|待公布|請見|詳見|依.*公告|tba|tbd)/iu;

function toInt(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s.replaceAll(',', ''));
  return Number.isSafeInteger(n) ? n : null;
}

export function parsePrice(
  text: string | null | undefined,
  options: PriceParseOptions = {},
): PriceParseResult {
  const maxAmount = options.maxAmount ?? 200_000;
  const t = cleanText(text ?? '');
  if (t.length === 0) return { kind: 'missing' };

  const amounts: number[] = [];
  // 依序抽出，已用過的區段以空白遮蔽，避免同一數字被不同規則重複計算
  let rest = t;
  const take = (re: RegExp, groups: number[]) => {
    rest = rest.replace(re, (...args: unknown[]) => {
      for (const g of groups) {
        const n = toInt(args[g] as string | undefined);
        if (n !== null) amounts.push(n);
      }
      return ' '.repeat((args[0] as string).length);
    });
  };
  take(CURRENCY_PREFIX_RE, [1, 2]);
  take(YUAN_FROM_RE, [1]);
  take(YUAN_SUFFIX_RE, [1]);
  take(LABELED_RE, [1]);

  const free = FREE_RE.test(t);

  if (amounts.length === 0) {
    if (free) return { kind: 'ok', value: { min: 0, max: 0, isFree: true, amounts: [] } };
    if (MISSING_RE.test(t)) return { kind: 'missing' };
    return /\d/.test(t) ? { kind: 'ambiguous', reason: `無法辨識票價：${t}` } : { kind: 'missing' };
  }

  const tooLarge = amounts.find((n) => n > maxAmount);
  if (tooLarge !== undefined) return { kind: 'ambiguous', reason: `金額異常：${tooLarge}` };

  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  if (max === 0) return { kind: 'ok', value: { min: 0, max: 0, isFree: true, amounts } };
  // 「免費入場」＋付費票種（如 VIP 優先入場券）→ 下限 0，但不是免費活動
  return { kind: 'ok', value: { min: free ? 0 : min, max, isFree: false, amounts } };
}
