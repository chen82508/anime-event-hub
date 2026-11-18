/**
 * pg_trgm `similarity()` 的 TypeScript 實作，供單元測試與 DB 以外的比對使用。
 * 與 PostgreSQL 一致：以非字母數字切詞、每個詞前補兩個空白、後補一個空白，取三字元組集合的 Jaccard 係數。
 * 實際去重查詢在 DB 端以 pg_trgm 計算（@aeh/db 的 findDedupCandidates）。
 */
const WORD_RE = /[\p{L}\p{N}]+/gu;

export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.toLowerCase().matchAll(WORD_RE)) {
    const chars = [' ', ' ', ...m[0], ' '];
    for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(''));
  }
  return out;
}

export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}
