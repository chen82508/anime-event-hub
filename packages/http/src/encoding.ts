/**
 * 回應編碼偵測與解碼（R10）。純函式。
 *
 * 順序：BOM → Content-Type header → HTML `<meta>` / XML 宣告 → 位元組偵測。
 * 宣告的編碼若無法無損解碼（例如 header 說 UTF-8、實際是 Big5），改用下一個候選，避免亂碼。
 */

export type SupportedEncoding = 'utf-8' | 'big5';
export type EncodingSource = 'bom' | 'header' | 'meta' | 'detected' | 'fallback';

export interface DecodedBody {
  text: string;
  encoding: SupportedEncoding;
  source: EncodingSource;
}

const LABELS: Record<string, SupportedEncoding> = {
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  'unicode-1-1-utf-8': 'utf-8',
  big5: 'big5',
  'big5-hkscs': 'big5',
  'cn-big5': 'big5',
  csbig5: 'big5',
  'x-x-big5': 'big5',
  cp950: 'big5',
  ms950: 'big5',
  'windows-950': 'big5',
};

/** 編碼標籤 → 支援的編碼；不支援者回傳 null */
export function normalizeEncodingLabel(label: string | null | undefined): SupportedEncoding | null {
  if (!label) return null;
  return (
    LABELS[
      label
        .trim()
        .toLowerCase()
        .replace(/^["']|["']$/g, '')
    ] ?? null
  );
}

export function charsetFromContentType(contentType: string | null | undefined): string | null {
  const m = /charset\s*=\s*("?)([^";\s]+)\1/i.exec(contentType ?? '');
  return m ? (m[2] as string) : null;
}

/** 從前 4KB 找 `<meta charset>`、`<meta http-equiv content="...charset=">`、`<?xml encoding="">` */
export function charsetFromMarkup(bytes: Uint8Array): string | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const xml = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  if (xml) return xml[1] as string;
  const meta = /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  return meta ? (meta[1] as string) : null;
}

function tryDecode(bytes: Uint8Array, encoding: SupportedEncoding): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function decodeBody(bytes: Uint8Array, contentType?: string | null): DecodedBody {
  // BOM
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', source: 'bom' };
  }

  const candidates: [SupportedEncoding | null, EncodingSource][] = [
    [normalizeEncodingLabel(charsetFromContentType(contentType)), 'header'],
    [normalizeEncodingLabel(charsetFromMarkup(bytes)), 'meta'],
    ['utf-8', 'detected'],
    ['big5', 'detected'],
  ];
  for (const [enc, source] of candidates) {
    if (!enc) continue;
    const text = tryDecode(bytes, enc);
    if (text !== null) return { text, encoding: enc, source };
  }
  // 都無法無損解碼：以 UTF-8 取代無效位元組
  return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', source: 'fallback' };
}
