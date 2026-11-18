# 曼迪傳播 Mighty Media

> 曼迪的英文名是 Mighty Media（來源 id `mightymedia`）；Medialink 是**羚邦**，不是曼迪。

- **端點**：`https://www.mightymedia.com.tw/blog-feed.xml`（Wix blog RSS）。首頁為 Wix 動態頁（約 1.8 MB），不解析。
- **robots.txt**（2026-11-18 檢查）：`User-agent: * / Allow: / / Disallow: *?lightbox=`
- **external_id**：RSS `<guid>`（Wix 文章 ID）。
- **過濾**：只收分類「活動」；標題含商品/播映等字詞者略過（R11），記錄於 `source_item.skip_reason`。
- **低結構**：日期與場館只出現在標題（如 `…12/28高雄夢時代登場`），所以 `dateText` / `venueText` 都用標題；
  多數項目因場館不在字典而 `unknown_venue` 待審，香港等海外場次 → `outside_taiwan`。屬預期行為。
- **已知例外**：
  - Wix 在 CDATA 內又編碼一次 HTML 實體（`&#38;`）→ `decodeEntities()` 處理。
  - 標題常寫「9月起」「北中南三地」等模糊資訊 → `ambiguous_date` / `unknown_venue`。
- **來源推論**：代理商標籤 `mighty-media`（tagger 的 `SOURCE_AGENCY_TAG`）。
- **fixture**：`fixtures/blog-feed-2026-11-18.xml`（真實快照）
