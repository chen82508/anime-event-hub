import { TAG_KIND_LABEL } from '@aeh/core';
import type { PublicEventTag } from '@aeh/db';
import Link from 'next/link';

/** 標籤：點擊即以該標籤篩選列表 */
export function TagChips({ tags, max }: { tags: PublicEventTag[]; max?: number }) {
  const shown = max ? tags.slice(0, max) : tags;
  const rest = tags.length - shown.length;
  return (
    <ul className="tag-chips">
      {shown.map((t) => (
        <li key={`${t.kind}:${t.slug}`}>
          <Link
            href={`/?tag=${encodeURIComponent(`${t.kind}:${t.slug}`)}`}
            className={`tag-chip tag-${t.kind}`}
            title={`${TAG_KIND_LABEL[t.kind]}：${t.name}`}
          >
            {t.name}
          </Link>
        </li>
      ))}
      {rest > 0 && <li className="tag-more">+{rest}</li>}
    </ul>
  );
}
