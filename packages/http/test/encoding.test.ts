import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  charsetFromContentType,
  charsetFromMarkup,
  decodeBody,
  normalizeEncodingLabel,
} from '../src';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

describe('decodeBody（R10）', () => {
  it('Big5：依 meta 宣告解碼', () => {
    const r = decodeBody(fixture('big5-meta.html'), 'text/html');
    expect(r).toMatchObject({ encoding: 'big5', source: 'meta' });
    expect(r.text).toContain('開拓動漫祭 FF 台北場');
    expect(r.text).toContain('台北世貿一館');
  });

  it('Big5：header 與 meta 都沒宣告 → 位元組偵測', () => {
    const r = decodeBody(fixture('big5-no-meta.html'), 'text/html');
    expect(r).toMatchObject({ encoding: 'big5', source: 'detected' });
    expect(r.text).toContain('臺北國際動漫節');
  });

  it('header 宣告優先於 meta', () => {
    const r = decodeBody(fixture('big5-meta.html'), 'text/html; charset=BIG5');
    expect(r).toMatchObject({ encoding: 'big5', source: 'header' });
  });

  it('header 說 UTF-8 但實際是 Big5 → 改用 meta，不產生亂碼', () => {
    const r = decodeBody(fixture('big5-meta.html'), 'text/html; charset=utf-8');
    expect(r).toMatchObject({ encoding: 'big5', source: 'meta' });
    expect(r.text).not.toContain('�');
  });

  it('UTF-8 頁面', () => {
    const r = decodeBody(fixture('utf8.html'), 'text/html; charset=UTF-8');
    expect(r).toMatchObject({ encoding: 'utf-8', source: 'header' });
    expect(r.text).toContain('ぼっち・ざ・ろっく！');
  });

  it('UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('台北')]);
    expect(decodeBody(bytes)).toEqual({ text: '台北', encoding: 'utf-8', source: 'bom' });
  });

  it('無法無損解碼 → fallback（UTF-8 取代字元）', () => {
    const r = decodeBody(new Uint8Array([0xc0, 0x80, 0xff]));
    expect(r.source).toBe('fallback');
  });
});

describe('編碼標籤', () => {
  it.each([
    ['UTF-8', 'utf-8'],
    ['utf8', 'utf-8'],
    ['Big5', 'big5'],
    ['big5-hkscs', 'big5'],
    ['CP950', 'big5'],
    ['"big5"', 'big5'],
    ['shift_jis', null],
    [null, null],
  ])('%s → %s', (label, expected) => {
    expect(normalizeEncodingLabel(label)).toBe(expected);
  });

  it('charsetFromContentType', () => {
    expect(charsetFromContentType('text/html; charset="Big5"')).toBe('Big5');
    expect(charsetFromContentType('text/html')).toBeNull();
  });

  it('charsetFromMarkup：meta charset / http-equiv / XML 宣告', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(charsetFromMarkup(enc('<meta charset="big5">'))).toBe('big5');
    expect(
      charsetFromMarkup(enc('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=big5">')),
    ).toBe('big5');
    expect(charsetFromMarkup(enc('<?xml version="1.0" encoding="UTF-8"?><rss/>'))).toBe('UTF-8');
    expect(charsetFromMarkup(enc('<html></html>'))).toBeNull();
  });
});
