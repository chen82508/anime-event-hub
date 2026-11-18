import Link from 'next/link';
import { toSearchString, type DiscoveryQuery, type View } from '@/lib/public/filters';

const LABEL: Record<View, string> = { list: '列表', calendar: '月曆' };

/** 列表 / 月曆切換（保留篩選條件） */
export function ViewToggle({ query }: { query: DiscoveryQuery }) {
  return (
    <nav className="view-toggle" aria-label="檢視方式">
      {(['list', 'calendar'] as const).map((v) => (
        <Link
          key={v}
          href={`/${toSearchString(query, { view: v })}`}
          aria-current={query.view === v ? 'page' : undefined}
          scroll={false}
        >
          {LABEL[v]}
        </Link>
      ))}
    </nav>
  );
}
