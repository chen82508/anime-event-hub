# 開拓動漫祭 Fancy Frontier（FF）

- **端點**：`https://www.f-2.com.tw/`（首頁活動區塊；WordPress）
- **robots.txt**（2026-11-18 檢查）：只禁止 `/wp-admin/`。
- **external_id**：活動詳細頁 URL 路徑（解碼後），如 `activitys/fancy-frontier開拓動漫祭-48`。
- **結構**：兩個 `.Frontier-activity` 區塊
  - 「開拓動漫祭系列活動」→ `typeHint: doujin`
  - 「其他類型動漫活動」→ 演唱會等，不給 typeHint，交給關鍵字（所以 tagger 不再對 `ff` 設來源預設類型）
  - 每筆 `.activity-info`：`h2 > a`（標題、詳細頁）＋ `<p><strong>活動日期：</strong>…`、`票價資訊`、`活動地點`
- **欄位注意**：
  - 活動日期逐日列出並各自附時刻（`2027 年 2月 19日 （五） 10：30–17：00<br>…`）→ normalize 取第一天開始、最後一天結束
  - 演唱會寫「17:00 開場 / 18:00 開演」→ 取開演
  - 活動地點為 `名稱（地址）`；票價 `<p>` 未閉合（cheerio 會自動處理）
- **已知例外**：演唱會標題多半沒有類型關鍵字（如 `LISANI！TAIPEI 2026`）→ `type_unresolved` 進待審。
- **fixture**：`fixtures/home-2026-11-18.html`（真實快照）
