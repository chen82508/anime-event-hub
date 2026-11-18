import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface FixtureCase {
  line: number;
  fields: string[];
}

/** 讀取 `a | b | 預期` 格式的樣本檔；`#` 開頭為註解，`@key value` 為設定 */
export function loadFixture(name: string): { meta: Record<string, string>; cases: FixtureCase[] } {
  const text = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
  const meta: Record<string, string> = {};
  const cases: FixtureCase[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) return;
    const at = /^@(\w+)\s+(.+)$/.exec(raw.trim());
    if (at) {
      meta[at[1] as string] = (at[2] as string).trim();
      return;
    }
    cases.push({ line: i + 1, fields: raw.split('|').map((f) => f.trim()) });
  });
  return { meta, cases };
}
