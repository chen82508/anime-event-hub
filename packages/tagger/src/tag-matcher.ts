/**
 * 作品 / 代理商 / 聲優 / 歌手標籤比對（tech-spec T7、C5、R14）。
 *
 * - 來源推論（如木棉花官網 → 代理商「木棉花」）→ 字典比對；字典沒命中就不標，不自動建立新標籤。
 * - 名稱與別名經 normalizeForMatch 後，最左最長匹配（「鬼滅之刃」優先於「鬼滅」，且不重疊）。
 * - 整詞邊界（R14）：
 *   - 純拉丁字母的別名（如 `EVA`、`Ado`）一律需要邊界，避免命中 `evangelist`、`adore`。
 *   - ≤ 2 字的中日文別名需要邊界，除非列入白名單（辨識度高、不易誤判者）。
 * - 每個命中都附 `matchedBy`（寫入 event_tag.matched_by），供審核者追查。
 */
import type { SourceId, TagKind, TagOrigin } from '@aeh/core';
import { LongestMatcher, normalizeForMatch } from '@aeh/normalize';

export interface TagRecord {
  /** DB id（從 DB 載入時有） */
  id?: number;
  kind: TagKind;
  slug: string;
  name: string;
  aliases: readonly string[];
}

/** 來源本身即代表某代理商（C5 來源推論）。值為 tag slug（kind = agency） */
export const SOURCE_AGENCY_TAG: Readonly<Partial<Record<SourceId, string>>> = {
  muse: 'muse',
  mightymedia: 'mighty-media',
};

/**
 * ≤ 2 字但辨識度高、可不要求邊界的別名（以 normalizeForMatch 後的形式比對）。
 * 例：「鬼滅快閃店」應命中「鬼滅」；「尖端」「東立」「青文」則容易出現在一般詞彙中，不列入。
 */
export const DEFAULT_SHORT_ALIAS_WHITELIST: readonly string[] = [
  '鬼滅',
  '柯南',
  '原神',
  '曼迪',
  '羚邦',
];

export interface TagHit<T extends TagRecord = TagRecord> {
  tag: T;
  origin: Extract<TagOrigin, 'source' | 'dict'>;
  /** 例：`source:muse`、`name:葬送的芙莉蓮`、`alias:鬼滅の刃` */
  matchedBy: string;
}

export interface TagMatcherOptions {
  shortAliasWhitelist?: readonly string[];
  /** 視為「短別名」的長度上限（字元數，不含空白），預設 2 */
  shortAliasMaxLength?: number;
  sourceAgencyTags?: Readonly<Partial<Record<SourceId, string>>>;
}

interface PatternValue<T> {
  tag: T;
  via: 'name' | 'alias';
  raw: string;
}

const LATIN_ONLY_RE = /^[\p{Script=Latin}\p{Nd} ]+$/u;

/** 依標籤種類、slug 排序，讓輸出順序穩定 */
const KIND_ORDER: Record<TagKind, number> = { agency: 0, work: 1, voice_actor: 2, artist: 3 };

export class TagMatcher<T extends TagRecord = TagRecord> {
  private readonly matcher: LongestMatcher<PatternValue<T>>;
  private readonly bySlug = new Map<string, T>();
  private readonly sourceAgencyTags: Readonly<Partial<Record<SourceId, string>>>;
  /** 因過短而要求邊界的 pattern（除錯 / 字典維護用） */
  readonly boundaryPatterns: ReadonlySet<string>;

  constructor(tags: readonly T[], options: TagMatcherOptions = {}) {
    const whitelist = new Set(
      (options.shortAliasWhitelist ?? DEFAULT_SHORT_ALIAS_WHITELIST).map(normalizeForMatch),
    );
    const maxShort = options.shortAliasMaxLength ?? 2;
    const boundary = new Set<string>();
    const entries = tags.flatMap((tag) => {
      this.bySlug.set(`${tag.kind}:${tag.slug}`, tag);
      const raws: [PatternValue<T>['via'], string][] = [
        ['name', tag.name],
        ...tag.aliases.map((a) => ['alias', a] as [PatternValue<T>['via'], string]),
      ];
      return raws.map(([via, raw]) => {
        const pattern = normalizeForMatch(raw);
        const needsBoundary =
          LATIN_ONLY_RE.test(pattern) ||
          ([...pattern.replaceAll(' ', '')].length <= maxShort && !whitelist.has(pattern));
        if (needsBoundary) boundary.add(pattern);
        return { pattern, value: { tag, via, raw }, boundary: needsBoundary };
      });
    });
    this.matcher = new LongestMatcher(entries);
    this.boundaryPatterns = boundary;
    this.sourceAgencyTags = options.sourceAgencyTags ?? SOURCE_AGENCY_TAG;
  }

  /**
   * @param texts 要比對的文字（標題，以及擷取器提供的其它詮釋性欄位）；各段分開比對，不會跨段命中
   */
  match(input: { texts: readonly string[]; sourceId?: SourceId }): TagHit<T>[] {
    const hits = new Map<string, TagHit<T>>();

    const agencySlug = input.sourceId ? this.sourceAgencyTags[input.sourceId] : undefined;
    const sourceTag = agencySlug ? this.bySlug.get(`agency:${agencySlug}`) : undefined;
    if (input.sourceId && sourceTag) {
      hits.set(`agency:${sourceTag.slug}`, {
        tag: sourceTag,
        origin: 'source',
        matchedBy: `source:${input.sourceId}`,
      });
    }

    for (const text of input.texts) {
      for (const m of this.matcher.findAll(normalizeForMatch(text))) {
        for (const v of m.values) {
          const key = `${v.tag.kind}:${v.tag.slug}`;
          if (!hits.has(key))
            hits.set(key, { tag: v.tag, origin: 'dict', matchedBy: `${v.via}:${v.raw}` });
        }
      }
    }

    return [...hits.values()].sort(
      (a, b) =>
        KIND_ORDER[a.tag.kind] - KIND_ORDER[b.tag.kind] ||
        (a.tag.slug < b.tag.slug ? -1 : a.tag.slug > b.tag.slug ? 1 : 0),
    );
  }
}
