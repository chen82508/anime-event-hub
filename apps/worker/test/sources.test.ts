import { describe, expect, it } from 'vitest';
import { selectSources, type SourceRow } from '../src/sources';

const rows: SourceRow[] = [
  { id: 'kktix', enabled: true, schedule: 'daily' },
  { id: 'cwt', enabled: true, schedule: 'weekly' },
  { id: 'ff', enabled: true, schedule: 'weekly' },
  { id: 'muse', enabled: false, schedule: 'daily' },
  { id: 'mightymedia', enabled: true, schedule: 'daily' },
];

describe('selectSources', () => {
  it('未指定頻率 → 所有 enabled 來源', () => {
    expect(selectSources(rows)).toEqual(['kktix', 'cwt', 'ff', 'mightymedia']);
  });

  it('daily → 不含每週擷取的年度大展（C8）', () => {
    expect(selectSources(rows, 'daily')).toEqual(['kktix', 'mightymedia']);
  });

  it('weekly → 只有每週來源', () => {
    expect(selectSources(rows, 'weekly')).toEqual(['cwt', 'ff']);
  });

  it('停用的來源一律排除', () => {
    expect(selectSources(rows, 'daily')).not.toContain('muse');
  });
});
