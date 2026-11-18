/**
 * 文字正規化（tech-spec T4 / R4）。
 *
 * - `cleanText()`：解析前的前處理（NFKC、零寬字元、空白），保留標點，供日期/票價解析使用。
 * - `normalizeForMatch()`：**唯一**的比對用正規化；字典比對、去重、標題鍵一律經過它。
 *   結果只用於比對，**顯示一律用原文**（C2）。
 *
 * 變更本檔的正規化規則時，必須重跑 tagger / dedup 測試（R4）。
 */

/** 零寬字元、BOM、變體選擇符、軟連字號等不可見字元 */
// 以跳脫序列表示（原字元不可見，勿改成字面字元）。皆為單一碼位，不是組合字元序列。
/* eslint-disable no-misleading-character-class */
const INVISIBLE_RE =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/** emoji 與圖形符號（含膚色修飾、區域旗幟字母） */
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u20E3]/gu;
/* eslint-enable no-misleading-character-class */

/** 各種空白（NFKC 會把全形空白 U+3000、NBSP 轉成一般空白，這裡再補上 tab/換行等） */
const WHITESPACE_RE = /\s+/gu;

/** 移除零寬字元與 emoji 以外的所有不可見字元，並統一空白 */
export function removeInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, '');
}

export function removeEmoji(s: string): string {
  return s.replace(EMOJI_RE, ' ');
}

/** 收斂連續空白並去頭尾 */
export function collapseWhitespace(s: string): string {
  return s.replace(WHITESPACE_RE, ' ').trim();
}

/**
 * 全形轉半形。NFKC 已涵蓋全形英數與符號（`１１／１６` → `11/16`、`ＮＴ＄` → `NT$`），
 * 並把半形片假名轉成全形；此函式即為 NFKC，單獨匯出以表明意圖。
 */
export function toHalfWidth(s: string): string {
  return s.normalize('NFKC');
}

/** 臺 → 台（縣市正規名稱一律用「台」，D3） */
export function unifyTai(s: string): string {
  return s.replaceAll('臺', '台');
}

/**
 * 解析前的前處理：NFKC、移除不可見字元、統一空白。保留標點與大小寫。
 * 不做 臺→台（日期、票價解析用不到；場館/縣市比對走 normalizeForMatch）。
 */
export function cleanText(s: string): string {
  return collapseWhitespace(removeInvisible(s.normalize('NFKC')));
}

/**
 * 標點與符號 → 空白。`\p{P}` 涵蓋 【】「」『』《》・〜～－…；`\p{S}` 涵蓋 ×☆★♪＄＋ 等。
 * 注意：片假名長音「ー」（\p{Lm}）與「々」不屬於標點，保留。
 */
const PUNCT_SYMBOL_RE = /[\p{P}\p{S}]+/gu;

/**
 * 比對用正規化（R4）：
 * 1. NFKC（全形→半形、相容字元）
 * 2. 移除零寬字元、變體選擇符；emoji → 空白
 * 3. 小寫
 * 4. 臺 → 台
 * 5. 標點、括號、符號 → 空白
 * 6. 收斂空白
 *
 * 同一輸入必得同一輸出；結果只用於比對，不可用於顯示。
 */
export function normalizeForMatch(s: string): string {
  let t = s.normalize('NFKC');
  t = removeInvisible(t);
  t = removeEmoji(t);
  t = t.toLowerCase();
  t = unifyTai(t);
  t = t.replace(PUNCT_SYMBOL_RE, ' ');
  return collapseWhitespace(t);
}

/** normalizeForMatch 後再移除所有空白；用於中日文為主、空白位置不穩定的比對（如場館名） */
export function compactForMatch(s: string): string {
  return normalizeForMatch(s).replaceAll(' ', '');
}

/**
 * 標題開頭常見的公告性前綴，對區分活動沒有幫助（比對前移除）。
 * 只移除「整段括號內容完全等於下列字詞」者；`【推しの子】` 之類的作品名不受影響。
 */
const TITLE_NOISE_PREFIXES = [
  '公告',
  '最新消息',
  '最新公告',
  '活動',
  '活動公告',
  '活動資訊',
  '活動訊息',
  '售票',
  '售票資訊',
  '售票公告',
  '情報',
  '新情報',
  '速報',
  '重要',
  '重要公告',
  '更新',
  'news',
  'info',
];
const TITLE_NOISE_SET = new Set(TITLE_NOISE_PREFIXES.map((w) => normalizeForMatch(w)));
const LEADING_BRACKET_RE =
  /^\s*[【[〔［(（〈《「『]([^】\]〕］)）〉》」』]{1,12})[】\]〕］)）〉》」』]\s*/u;

/**
 * 比對用標題（寫入 `event.title_normalized`，供去重與模糊搜尋）。
 * = 移除開頭的公告性括號前綴（可多個）後，再做 normalizeForMatch。
 */
export function normalizeTitle(title: string): string {
  let t = cleanText(title);
  for (;;) {
    const m = LEADING_BRACKET_RE.exec(t);
    if (!m || !TITLE_NOISE_SET.has(normalizeForMatch(m[1] ?? ''))) break;
    t = t.slice(m[0].length);
  }
  const normalized = normalizeForMatch(t);
  // 標題整段都是雜訊（極少見）時退回完整標題，避免得到空字串
  return normalized.length > 0 ? normalized : normalizeForMatch(title);
}
