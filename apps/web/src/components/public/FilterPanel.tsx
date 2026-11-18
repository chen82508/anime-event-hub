import {
  EVENT_TYPES,
  EVENT_TYPE_LABEL,
  REGIONS,
  REGION_LABEL,
  TAG_KINDS,
  TAG_KIND_LABEL,
} from '@aeh/core';
import type { PublicEventTag, PublicTagFacet } from '@aeh/db';
import { CleanForm } from './CleanForm';
import Link from 'next/link';
import {
  SALE_LABEL,
  SALE_OPTIONS,
  tagParamKey,
  toSearchString,
  type DiscoveryQuery,
} from '@/lib/public/filters';

/** 前台不提供「其他」類型篩選（僅作為後台判定的保底分類） */
const FILTER_TYPES = EVENT_TYPES.filter((t) => t !== 'other');

/**
 * 多條件篩選面板。GET 表單（next/form）：條件全部進 URL，可分享、可上一頁，
 * 沒有 JS 時也能送出。群組內為 OR、群組間為 AND。
 */
export function FilterPanel({
  query,
  facets,
  selectedTags,
}: {
  query: DiscoveryQuery;
  facets: PublicTagFacet[];
  /** 已選但目前沒有未結束活動的標籤（例如從詳情頁點過來），仍需顯示為已勾選 */
  selectedTags: PublicEventTag[];
}) {
  const selected = new Set(query.tags.map(tagParamKey));
  const options = new Map<string, PublicEventTag & { count?: number }>();
  for (const t of selectedTags) options.set(tagParamKey(t), t);
  for (const f of facets) options.set(tagParamKey(f), f);
  const byKind = TAG_KINDS.map((kind) => ({
    kind,
    tags: [...options.values()].filter((t) => t.kind === kind),
  })).filter((g) => g.tags.length > 0);

  return (
    <CleanForm action="/" className="filter-form" scroll={false}>
      {query.view !== 'list' && <input type="hidden" name="view" value={query.view} />}
      {query.view === 'calendar' && query.month && (
        <input type="hidden" name="month" value={query.month} />
      )}

      <label className="field">
        <span className="field-label">關鍵字</span>
        <input
          type="search"
          name="q"
          defaultValue={query.q}
          placeholder="活動名稱、作品、聲優…"
          maxLength={100}
          enterKeyHint="search"
        />
      </label>

      <fieldset className="field">
        <legend className="field-label">地區</legend>
        <div className="pill-group">
          {REGIONS.map((r) => (
            <label key={r} className="pill">
              <input
                type="checkbox"
                name="region"
                value={r}
                defaultChecked={query.regions.includes(r)}
              />
              <span>{REGION_LABEL[r]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend className="field-label">活動類型</legend>
        <div className="pill-group">
          {FILTER_TYPES.map((t) => (
            <label key={t} className="pill">
              <input
                type="checkbox"
                name="type"
                value={t}
                defaultChecked={query.types.includes(t)}
              />
              <span>{EVENT_TYPE_LABEL[t]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend className="field-label">日期區間</legend>
        <div className="date-range">
          <label htmlFor="f-from">從</label>
          <input id="f-from" type="date" name="from" defaultValue={query.from ?? ''} />
          <label htmlFor="f-to">到</label>
          <input id="f-to" type="date" name="to" defaultValue={query.to ?? ''} />
        </div>
      </fieldset>

      <fieldset className="field">
        <legend className="field-label">開賣狀態</legend>
        <div className="pill-group">
          <label className="pill">
            <input type="radio" name="sale" value="" defaultChecked={!query.sale} />
            <span>不限</span>
          </label>
          {SALE_OPTIONS.map((s) => (
            <label key={s} className="pill">
              <input type="radio" name="sale" value={s} defaultChecked={query.sale === s} />
              <span>{SALE_LABEL[s]}</span>
            </label>
          ))}
        </div>
        <p className="field-hint">僅含已公布開賣時間的活動</p>
      </fieldset>

      {byKind.length > 0 && (
        <fieldset className="field">
          <legend className="field-label">代理商・作品・聲優</legend>
          <div className="tag-groups">
            {byKind.map((g) => (
              <div key={g.kind} className="tag-group">
                <span className="tag-group-label">{TAG_KIND_LABEL[g.kind]}</span>
                <div className="pill-group">
                  {g.tags.map((t) => (
                    <label key={tagParamKey(t)} className="pill pill-sm">
                      <input
                        type="checkbox"
                        name="tag"
                        value={tagParamKey(t)}
                        defaultChecked={selected.has(tagParamKey(t))}
                      />
                      <span>
                        {t.name}
                        {t.count !== undefined && <small> {t.count}</small>}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
      )}

      <div className="filter-actions">
        <button type="submit" className="btn btn-primary">
          套用篩選
        </button>
        <Link
          href={`/${toSearchString(query, { regions: [], types: [], tags: [], q: '', from: null, to: null, sale: null })}`}
          className="btn btn-ghost"
          scroll={false}
        >
          清除
        </Link>
      </div>
    </CleanForm>
  );
}
