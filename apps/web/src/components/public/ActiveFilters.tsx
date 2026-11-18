import { EVENT_TYPE_LABEL, REGION_LABEL } from '@aeh/core';
import type { PublicEventTag } from '@aeh/db';
import Link from 'next/link';
import { SALE_LABEL, tagParamKey, toSearchString, type DiscoveryQuery } from '@/lib/public/filters';

/** 目前套用的條件；每個 chip 都是「移除此條件」的連結 */
export function ActiveFilters({
  query,
  tagNames,
}: {
  query: DiscoveryQuery;
  tagNames: Map<string, string>;
}) {
  const chips: { key: string; label: string; href: string }[] = [];
  const href = (o: Partial<DiscoveryQuery>) => `/${toSearchString(query, o)}`;

  if (query.q) chips.push({ key: 'q', label: `「${query.q}」`, href: href({ q: '' }) });
  for (const r of query.regions)
    chips.push({
      key: `r-${r}`,
      label: REGION_LABEL[r],
      href: href({ regions: query.regions.filter((x) => x !== r) }),
    });
  for (const t of query.types)
    chips.push({
      key: `t-${t}`,
      label: EVENT_TYPE_LABEL[t],
      href: href({ types: query.types.filter((x) => x !== t) }),
    });
  for (const t of query.tags) {
    const k = tagParamKey(t);
    chips.push({
      key: `g-${k}`,
      label: tagNames.get(k) ?? t.slug,
      href: href({ tags: query.tags.filter((x) => tagParamKey(x) !== k) }),
    });
  }
  if (query.from || query.to)
    chips.push({
      key: 'date',
      label: `${query.from ?? ''} ～ ${query.to ?? ''}`,
      href: href({ from: null, to: null }),
    });
  if (query.sale)
    chips.push({ key: 'sale', label: SALE_LABEL[query.sale], href: href({ sale: null }) });

  if (!chips.length) return null;
  return (
    <ul className="active-filters" aria-label="目前的篩選條件">
      {chips.map((c) => (
        <li key={c.key}>
          <Link
            href={c.href}
            className="active-chip"
            scroll={false}
            aria-label={`移除條件：${c.label}`}
          >
            {c.label}
            <span aria-hidden>✕</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function tagNameMap(tags: PublicEventTag[]): Map<string, string> {
  return new Map(tags.map((t) => [tagParamKey(t), t.name]));
}
