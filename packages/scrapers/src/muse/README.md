# 木棉花 Muse（⚠️ 結構未驗證）

- **狀態**：2026-11-18 檢查時 `www.e-muse.com.tw` 與 `e-muse.com.tw` 沒有 DNS A 記錄（NS 在 Cloudflare），無法取得真實頁面。
- 因此 `fixtureStatus: 'synthetic'`：parser 依常見新聞列表結構撰寫，`fixtures/news-synthetic.html` 為**合成樣本**。
  pipeline 預設**略過**此擷取器（crawl 回報 skipped），避免把錯誤解析的資料寫入 DB；確認結構後可用 `--allow-unverified` 試跑。
- **待辦（PoC）**：確認官網網址與 robots.txt → 抓真實快照取代合成 fixture → 改寫 selector → 把 `fixtureStatus` 改為 `real`。
- **預期處理**：低結構來源，日期/場館取自標題；只收「活動」分類；代理商標籤 `muse` 由來源推論。
