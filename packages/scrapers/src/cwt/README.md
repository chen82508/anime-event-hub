# CWT 台灣同人誌販售會

- **端點**：`https://www.comicworld.com.tw/Acts/tw`（台灣場活動一覽）。`/Acts/hk` 為香港場，不擷取（只收台灣活動）。
- **robots.txt**（2026-11-18 檢查）：不存在（404）→ 依 RFC 9309 視為全部允許。
- **external_id**：詳細頁 `/Act1/<數字>` 的數字。
- **欄位**：每張 `.activity` 卡片
  - `.a_c_tit` → 標題（如 `【CWT-74】(台北場)`）
  - `活動日期` → `2026年12月12 / 13日`（「12 / 13日」為同月兩日，normalize 已支援）
  - `活動地點`、`地　　址`（標籤中有全形空白）→ `venueText` / `addressText`
- **類型**：來源推論 `doujin`（`typeHint`，tagger 也有 `SOURCE_DEFAULT_TYPE.cwt`）。
- **已知例外**：列表頁沒有票價與時刻 → 全天活動、票價空白；詳細頁 `/Act1/<id>` 的「活動資訊」區塊在 2026-11-18 為空白，暫不擷取。
- **fixture**：`fixtures/acts-tw-2026-11-18.html`（真實快照）
