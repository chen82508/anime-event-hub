/**
 * 活動類型判定（tech-spec T7、C5）：擷取器提示 → 來源推論 → 關鍵字字典 → type_unresolved。
 *
 * - 關鍵字以 normalizeForMatch 後最左最長匹配；拉丁字母關鍵字需整詞邊界（避免 `concert` 命中 `concerto`）。
 * - 命中多個類型時取 priority 最高者；最高 priority 有兩種以上類型 → 無法判定（不猜）。
 * - 場館名稱中的「展覽館」「展演中心」等不算類型關鍵字（先遮蔽再比對）。
 * - 回傳命中的規則，供審核後台除錯。
 */
import type { EventType, ReviewReason, SourceId, TypeKeywordGroup } from '@aeh/core';
import { LongestMatcher, normalizeForMatch } from '@aeh/normalize';

/**
 * 整個來源都是同一類型時的預設（擷取器可用 typeHint 覆寫）。
 * FF 官網同時刊登同人展與演唱會，不設預設，由擷取器依區塊給 typeHint。
 */
export const SOURCE_DEFAULT_TYPE: Readonly<Partial<Record<SourceId, EventType>>> = {
  cwt: 'doujin',
  tica: 'expo',
  comic_exhibition: 'expo',
};

/** 含有類型關鍵字、但其實是場館名稱的片語 */
export const DEFAULT_TYPE_STOP_PHRASES: readonly string[] = [
  '展覽館',
  '展覽中心',
  '展覽廳',
  '展演中心',
  '展演空間',
  '展演廳',
  '世貿展覽',
  '會展中心',
];

export interface TypeKeywordHit {
  keyword: string;
  type: EventType;
  priority: number;
}

export type TypeRule =
  | { kind: 'hint'; type: EventType }
  | { kind: 'source'; sourceId: SourceId; type: EventType }
  | { kind: 'keyword'; keyword: string; type: EventType; priority: number }
  | { kind: 'conflict'; types: EventType[]; priority: number }
  | { kind: 'none' };

export interface TypeClassification {
  type: EventType | null;
  rule: TypeRule;
  /** 所有命中的關鍵字（依出現順序），除錯用 */
  keywordHits: TypeKeywordHit[];
  reviewReasons: ReviewReason[];
}

export interface TypeClassifierInput {
  title: string;
  sourceId?: SourceId;
  /** 擷取器的來源推論（RawEventCandidate.typeHint） */
  typeHint?: EventType | null;
}

export interface TypeClassifierOptions {
  sourceDefaults?: Readonly<Partial<Record<SourceId, EventType>>>;
  stopPhrases?: readonly string[];
}

const LATIN_ONLY_RE = /^[\p{Script=Latin}\p{Nd} ]+$/u;

export class TypeClassifier {
  private readonly matcher: LongestMatcher<{ keyword: string; type: EventType; priority: number }>;
  private readonly stopMatcher: LongestMatcher<true>;
  private readonly sourceDefaults: Readonly<Partial<Record<SourceId, EventType>>>;

  constructor(groups: readonly TypeKeywordGroup[], options: TypeClassifierOptions = {}) {
    this.matcher = new LongestMatcher(
      groups.flatMap((g) =>
        g.keywords.map((kw) => {
          const pattern = normalizeForMatch(kw);
          return {
            pattern,
            value: { keyword: kw, type: g.type, priority: g.priority },
            boundary: LATIN_ONLY_RE.test(pattern),
          };
        }),
      ),
    );
    this.stopMatcher = new LongestMatcher(
      (options.stopPhrases ?? DEFAULT_TYPE_STOP_PHRASES).map((p) => ({
        pattern: normalizeForMatch(p),
        value: true as const,
      })),
    );
    this.sourceDefaults = options.sourceDefaults ?? SOURCE_DEFAULT_TYPE;
  }

  /** 只做關鍵字比對（不含提示與來源推論） */
  keywordHits(title: string): TypeKeywordHit[] {
    let text = normalizeForMatch(title);
    for (const m of this.stopMatcher.findAll(text)) {
      text = text.slice(0, m.start) + ' '.repeat(m.end - m.start) + text.slice(m.end);
    }
    return this.matcher.findAll(text).flatMap((m) => m.values);
  }

  classify(input: TypeClassifierInput): TypeClassification {
    const keywordHits = this.keywordHits(input.title);
    const ok = (type: EventType, rule: TypeRule): TypeClassification => ({
      type,
      rule,
      keywordHits,
      reviewReasons: [],
    });

    if (input.typeHint) return ok(input.typeHint, { kind: 'hint', type: input.typeHint });
    const sourceType = input.sourceId ? this.sourceDefaults[input.sourceId] : undefined;
    if (input.sourceId && sourceType) {
      return ok(sourceType, { kind: 'source', sourceId: input.sourceId, type: sourceType });
    }

    if (keywordHits.length === 0) {
      return {
        type: null,
        rule: { kind: 'none' },
        keywordHits,
        reviewReasons: ['type_unresolved'],
      };
    }
    const top = Math.max(...keywordHits.map((h) => h.priority));
    const topHits = keywordHits.filter((h) => h.priority === top);
    const types = [...new Set(topHits.map((h) => h.type))];
    if (types.length > 1) {
      return {
        type: null,
        rule: { kind: 'conflict', types, priority: top },
        keywordHits,
        reviewReasons: ['type_unresolved'],
      };
    }
    const hit = topHits[0] as TypeKeywordHit;
    return ok(hit.type, {
      kind: 'keyword',
      keyword: hit.keyword,
      type: hit.type,
      priority: hit.priority,
    });
  }
}

/** 規則 → 簡短說明（後台顯示 / log 用） */
export function describeTypeRule(rule: TypeRule): string {
  switch (rule.kind) {
    case 'hint':
      return `擷取器提示：${rule.type}`;
    case 'source':
      return `來源推論（${rule.sourceId}）：${rule.type}`;
    case 'keyword':
      return `關鍵字「${rule.keyword}」（priority ${rule.priority}）：${rule.type}`;
    case 'conflict':
      return `關鍵字衝突（priority ${rule.priority}）：${rule.types.join(' / ')}`;
    case 'none':
      return '無命中規則';
  }
}
