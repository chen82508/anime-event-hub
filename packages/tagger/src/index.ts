// @aeh/tagger — 活動類型推論、關鍵字/別名字典比對（純函式，見 tech-spec T7）
import type { EventType, ReviewReason, SourceId, TypeKeywordGroup } from '@aeh/core';
import { TagMatcher, type TagHit, type TagMatcherOptions, type TagRecord } from './tag-matcher';
import {
  TypeClassifier,
  type TypeClassification,
  type TypeClassifierOptions,
} from './type-classifier';

export * from './tag-matcher';
export * from './type-classifier';

export interface TaggerInput {
  title: string;
  sourceId?: SourceId;
  typeHint?: EventType | null;
  /** 標題以外、可供標籤比對的詮釋性文字（如場館、演出者欄位） */
  extraTexts?: readonly string[];
}

export interface TaggerResult<T extends TagRecord = TagRecord> {
  type: TypeClassification;
  tags: TagHit<T>[];
  reviewReasons: ReviewReason[];
}

/** 類型判定 ＋ 標籤比對。字典在建立時編譯一次，之後的 `tag()` 為純函式 */
export class Tagger<T extends TagRecord = TagRecord> {
  private readonly classifier: TypeClassifier;
  private readonly tagMatcher: TagMatcher<T>;

  constructor(
    dicts: { typeKeywords: readonly TypeKeywordGroup[]; tags: readonly T[] },
    options: { type?: TypeClassifierOptions; tags?: TagMatcherOptions } = {},
  ) {
    this.classifier = new TypeClassifier(dicts.typeKeywords, options.type);
    this.tagMatcher = new TagMatcher(dicts.tags, options.tags);
  }

  tag(input: TaggerInput): TaggerResult<T> {
    const type = this.classifier.classify(input);
    const tags = this.tagMatcher.match({
      texts: [input.title, ...(input.extraTexts ?? [])],
      sourceId: input.sourceId,
    });
    return { type, tags, reviewReasons: type.reviewReasons };
  }
}
