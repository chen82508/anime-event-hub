/**
 * 字典比對引擎：最左最長匹配（leftmost-longest），不重疊。
 * 場館、縣市（本套件）與標籤、類型關鍵字（@aeh/tagger）共用。
 *
 * - pattern 與 text 必須由呼叫端以**同一個**正規化函式處理（通常是 normalizeForMatch / compactForMatch）。
 * - 同一 pattern 可對應多個 value（例如同名的作品與歌手），比對時一併回傳。
 * - `boundary` 為 true 的 pattern 需整詞邊界（R14）：前後字元不可與 pattern 首/尾字元同屬一類文字。
 */

export interface MatcherEntry<T> {
  /** 已正規化的 pattern（空字串會被忽略） */
  pattern: string;
  value: T;
  /** 是否要求整詞邊界 */
  boundary?: boolean;
}

export interface Match<T> {
  pattern: string;
  /** 命中的 values（同 pattern 多個條目時有多個），依加入順序 */
  values: T[];
  start: number;
  end: number;
}

type CharClass = 'latin' | 'cjk' | 'hangul' | 'other';

const LATIN_RE = /[\p{Script=Latin}\p{Nd}]/u;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆]/u;
const HANGUL_RE = /\p{Script=Hangul}/u;

export function charClass(ch: string | undefined): CharClass {
  if (ch === undefined) return 'other';
  if (LATIN_RE.test(ch)) return 'latin';
  if (CJK_RE.test(ch)) return 'cjk';
  if (HANGUL_RE.test(ch)) return 'hangul';
  return 'other';
}

/** [start, end) 是否位於整詞邊界：前一字與首字不同類、末字與後一字不同類 */
export function isWordBoundary(text: string, start: number, end: number): boolean {
  const first = charClass(text[start]);
  const last = charClass(text[end - 1]);
  const before = charClass(text[start - 1]);
  const after = charClass(text[end]);
  return (first === 'other' || before !== first) && (last === 'other' || after !== last);
}

interface Bucket<T> {
  pattern: string;
  boundary: boolean;
  values: T[];
}

export class LongestMatcher<T> {
  /** 首字元 → 以該字元開頭的 pattern（長到短） */
  private readonly byFirstChar = new Map<string, Bucket<T>[]>();

  constructor(entries: Iterable<MatcherEntry<T>>) {
    const byPattern = new Map<string, Bucket<T>>();
    for (const e of entries) {
      if (e.pattern.length === 0) continue;
      const existing = byPattern.get(e.pattern);
      if (existing) {
        existing.values.push(e.value);
        // 同一 pattern 只要有任一條目要求邊界，就要求邊界（保守）
        existing.boundary ||= e.boundary ?? false;
      } else {
        byPattern.set(e.pattern, {
          pattern: e.pattern,
          boundary: e.boundary ?? false,
          values: [e.value],
        });
      }
    }
    for (const b of byPattern.values()) {
      const first = b.pattern[0] as string;
      const list = this.byFirstChar.get(first) ?? [];
      list.push(b);
      this.byFirstChar.set(first, list);
    }
    for (const list of this.byFirstChar.values()) {
      // 長的優先；同長度依字典序，確保結果穩定
      list.sort((a, b) => b.pattern.length - a.pattern.length || (a.pattern < b.pattern ? -1 : 1));
    }
  }

  /** 從左到右掃描，每個位置取最長且通過邊界檢查的 pattern，命中後跳過該段（不重疊） */
  findAll(text: string): Match<T>[] {
    const out: Match<T>[] = [];
    let i = 0;
    while (i < text.length) {
      const hit = this.longestAt(text, i);
      if (hit) {
        out.push(hit);
        i = hit.end;
      } else {
        i += 1;
      }
    }
    return out;
  }

  private longestAt(text: string, i: number): Match<T> | null {
    const candidates = this.byFirstChar.get(text[i] as string);
    if (!candidates) return null;
    for (const c of candidates) {
      const end = i + c.pattern.length;
      if (end > text.length) continue;
      if (!text.startsWith(c.pattern, i)) continue;
      if (c.boundary && !isWordBoundary(text, i, end)) continue;
      return { pattern: c.pattern, values: [...c.values], start: i, end };
    }
    return null;
  }
}
