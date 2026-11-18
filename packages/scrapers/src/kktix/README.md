# KKTIX

- **端點**：`https://kktix.com/events.atom?search=<關鍵字>`（Atom feed）
  - `events.json` 位於 Cloudflare 驗證之後（2026-11-18 實測 403 challenge），**不使用、不繞過**。
- **robots.txt**（2026-11-18 檢查）：`User-agent: * / Allow: /`
- **關鍵字**：預設 `動漫, 動畫, 聲優, 同人, cosplay`，可用 `KKTIX_KEYWORDS` 覆寫（R15）。多個關鍵字的結果以 `external_id` 去重。
- **external_id**：entry `<id>` 的 `Event/<數字>`（穩定，不依賴列表順序）。
- **欄位**：`<content>` 固定兩行
  - `時間：2026/12/05 18:30(+0800) ~ 2026/12/06 21:30(+0800)`（結束可省略日期或整段省略）→ `structured.startAt/endAt`（帶時區）
  - `地點：<場館> / <地址>` → `venueText` / `addressText`（地址常附「位於華山1914…」，normalize 只在場館欄未命中時才看地址）
  - `<published>` → `publishedOn`；`<author><name>` → notes（主辦）
- **規模門檻**：場館不在字典、且票價上限未達 `KKTIX_MIN_PRICE_MAX`（預設 1000）→ `below_scale_threshold`。Atom 沒有票價，所以目前「字典外場館」一律進待審，PoC 後校正。
- **已知例外**：
  - 同一場演唱會依票種拆成多個活動頁（如 GA / VIP）→ 標題不同，進 `possible_duplicate` 由人工合併。
  - 同店同日的多場 1v1 見面會標題相近 → 同樣進灰色區間（不同場次，人工確認後解除）。
  - 搜尋結果會混入非動漫活動（親子樂園、喜劇）與海外課程 → 類型無法判定 / `outside_taiwan`。
- **fixture**：`fixtures/search-2026-11-18.atom`（真實快照，原始 bytes）
