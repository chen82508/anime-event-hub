import { describe, expect, it } from 'vitest';
import { TIMEZONE } from '../src';

describe('constants', () => {
  it('固定使用台灣時區', () => {
    expect(TIMEZONE).toBe('Asia/Taipei');
  });
});
