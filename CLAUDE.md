# CLAUDE.md — Anime Event Hub TW (MVP)

台灣動漫活動整合平台：從代理商官網、售票平台、同人展與綜合展官網定時擷取活動資訊，經**規則式**正規化、標籤、去重後彙整呈現；規則無法處理的資料進入**人工審核佇列**。

- 企劃書：`docs/proposal.md`（v2.1）— 範圍與「為什麼」
- 技術規格：`docs/tech-spec.md`（v0.2，D1–D7 已確認）— 架構、資料模型、任務拆解（T0–T10）
- 有疑義時以 tech-spec 為準；需要改動已確認決策（✅）時，先詢問使用者，不要自行變更。

目前進度：**Phase 1 的 T0–T10 皆已實作**（core、db、字典、normalize、http、scrapers、tagger、dedup、worker、/admin）。擷取器：KKTIX、CWT、FF、曼迪以 2026-11-18 的真實快照為 fixture；**木棉花官網無法連線，擷取器為未驗證（synthetic）狀態，pipeline 預設略過**；tica／comic_exhibition 尚未實作（待 PoC 檢視官網）。

**Phase 2（前台 Discovery）進行中**：列表／月曆、多條件篩選、活動詳情已實作；訂閱推播屬 Phase 3。

---

## 架構原則（Non-negotiables，見 tech-spec §1）

| 原則                                          | 實作上的意義                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **全 TypeScript monorepo**                    | 擷取器、解析器、API、前端共用型別。不要引入 Python 或其他語言的爬蟲。                                                                                                                |
| **單語系：繁體中文**                          | 不使用 i18n 框架、不建翻譯欄位。UI 文字直接寫繁中。活動標題**保留來源原文**（含日文作品名/聲優名），不翻譯。                                                                         |
| **完全不串接 LLM**                            | 所有解析、分類、推播文案都用規則／字典／固定模板。同一輸入必得同一輸出。不要加入任何 AI SDK 或 API 金鑰。                                                                            |
| **規則解析 ＋ 人工審核**                      | 必要欄位（`title`、`start_at`、`venue` 或 `is_online`、`source_url`）任一缺漏 → `pending_review` 並附 `review_reasons[]`，**絕不自動上架**。無法唯一判定時回傳 `ambiguous`，不要猜。 |
| **標籤：來源推論 → 關鍵字字典 → 人工補標**    | 字典沒命中就不標，**不自動建立新標籤**。                                                                                                                                             |
| **僅收錄在台灣舉辦的活動**                    | 非台灣場館/海外地名 → `outside_taiwan`。                                                                                                                                             |
| **本機 Docker 優先**                          | `docker compose` 起 DB 即可完整開發與測試，不依賴任何雲端服務。                                                                                                                      |
| **合規擷取**                                  | 遵守 `robots.txt`；同 host 間隔 ≥ 3 秒；每日 1 次（年度大展每週 1 次）；只存詮釋性資料；每筆活動必附原始連結。原始快照僅供除錯，保留 ≤ 30 天。                                       |
| **拓元（tixcraft）、ibon 暫緩；不爬社群平台** | 不實作這些擷取器（X / Facebook / Instagram 亦同）。                                                                                                                                  |
| **單一 Worker、無佇列**                       | 數百筆/年量級，排程在單一 process 內序列執行。不要引入 Redis / BullMQ / 分散式架構。                                                                                                 |

---

## Repository 結構（pnpm workspaces ＋ Turborepo）

```
apps/
  worker/        @aeh/worker   排程（node-cron）+ CLI（crawl / reparse / dedup / cleanup），tsx 執行
  web/           @aeh/web      Next.js App Router；Phase 1 只做 /admin 審核後台（app/(admin)/admin）
packages/
  core/          @aeh/core       領域型別、zod schema、enum（EventType / Region / EventStatus…）
  db/            @aeh/db         Drizzle schema、migrations（純 SQL）、seed、repository
  http/          @aeh/http       PoliteClient：robots.txt、節流、重試、編碼偵測（Big5/UTF-8）
  normalize/     @aeh/normalize  文字（NFKC、臺/台…）、日期、票價、場館/地區解析
  tagger/        @aeh/tagger     類型推論、別名字典比對（最長匹配優先）
  dedup/         @aeh/dedup      去重鍵（正規化標題＋開始日期＋場館）、候選、合併
  scrapers/      @aeh/scrapers   src/<source>/ 每來源一個子目錄（kktix, cwt, muse, ff, mightymedia…）
data/dictionaries/   縣市、場館、類型關鍵字、來源、作品/代理商/聲優/歌手別名（YAML，seed 用）
docker/postgres/init/ DB 首次初始化 SQL（pg_trgm、測試 DB）
var/snapshots/       原始快照（gitignored）
```

### 相依方向（不得反向）

```
core ← normalize / tagger / dedup ← scrapers ← apps/*
core ← http ← apps/*
core ← db   ← apps/*（db 只給 apps 與 pipeline 編排層用）
```

- `core`、`normalize`、`tagger`、`dedup` 以及 `scrapers` 的 parse 函式**必須是純函式**：不碰 DB、不碰網路、不讀環境變數、不使用無時區的 `new Date(string)`。ESLint `no-restricted-imports` 會擋下違規 import。
- 內部套件**不需要 build**：`package.json` 的 `exports` 直接指向 `./src/index.ts`，由 tsx / vitest / Next（`transpilePackages`）處理。新增被 web 使用的套件時，記得加進 `apps/web/next.config.ts` 的 `transpilePackages`。
- 套件命名 `@aeh/<name>`；workspace 相依寫 `"workspace:*"`；第三方版本統一寫在 `pnpm-workspace.yaml` 的 `catalog:`，各套件以 `"catalog:"` 引用。

### 領域模型與資料庫重點

- **Enum 單一事實來源**：`packages/core/src/enums.ts` 的 `as const` tuple → zod schema、Drizzle `pgEnum`、繁中標籤都由此衍生。新增 enum 值：改 core → `pnpm db:generate` 產生 migration。
- **地區對照（D3）**：`CITY_REGION`（core）為準；`regions.yaml` 只放縣市別名，seed 時交叉驗證。`venue.region` 由 `city` 推得，YAML 不重複填寫。縣市正規名稱一律用「台」。
- **`event` 必要欄位可為 NULL**（待審資料），但 DB 有 CHECK 約束 `event_published_requirements`：`published` 時必須有 `start_at`、`type`、場館或線上、`published_at`，且 `review_reasons` 為空。對應的程式端判定是 core 的 `requiredFieldReasons()` / `isAutoPublishable()`。
- **Migration**：`drizzle-kit generate` 產生到 `packages/db/migrations/`。`0000_init.sql` 開頭的 `CREATE EXTENSION pg_trgm` 為手動加入，不可刪除。drizzle 的 `onConflict` target 不支援運算式索引（如 `lower(keyword)`），需要時改用原生 SQL。
- **Seed 語意**（`packages/db/src/dictionaries/seed.ts`）：單一 transaction；以 slug/id upsert；名稱等以 YAML 為準；**別名只追加不刪除**（保留後台新增者）；**不刪除** YAML 已移除的列；`source.enabled` 只在首次建立時套用。字典驗證失敗 → 不碰 DB 直接中止。
- **字典規則**：同一字典內，名稱/別名（不分大小寫）不可指向兩個條目；不收會指向多個場館的模糊別名（寧可 `unknown_venue` 待審）。
- **來源 ID**：曼迪傳播的英文名是 Mighty Media → `mightymedia`；`Medialink` 是**羚邦**（代理商標籤 `medialink`）。tech-spec 原寫的 `medialink/ # 曼迪` 已依此修正。

---

### 解析引擎重點（normalize / tagger / http）

- **比對一律用 `normalizeForMatch()`**（NFKC → 去零寬/emoji → 小寫 → 臺→台 → 標點符號轉空白）；場館/縣市用去空白的 `compactForMatch()`。改動正規化規則要重跑 tagger／dedup 測試。
- **字典比對**共用 `LongestMatcher`（最左最長、不重疊）。拉丁字母別名一律要求整詞邊界；≤2 字的中日文別名需邊界，除非在 `DEFAULT_SHORT_ALIAS_WHITELIST`。
- **日期**：`parseEventDate(dateText, timeText, { referenceDate })`，`referenceDate` 傳公告日（沒有才用擷取日）。缺年份以「結束日 ≥ 基準日」推論並標 `yearInferred`，推論結果距基準日超過 240 天（`DEFAULT_MAX_FORWARD_DAYS`）→ `ambiguous`；星期不符、多場次、不連續日期、`11/30-2` 之類一律回 `ambiguous`。全天區間的 `endAt` = 結束日 23:59:59（台灣時間）。
- **票價**：金額需有幣別／「元」／票種標籤，避免把「限量100張」當票價；「免費入場＋付費票種」→ `min = 0`、`isFree = false`。
- **場館**：命中多個場館 → `ambiguous`（R5，人工拆分）；未命中且無台灣縣市但有海外地名 → `outside_taiwan`；`venueReviewReasons()` 對應 §4.3。
- **類型**：擷取器 `typeHint` → `SOURCE_DEFAULT_TYPE`（cwt → doujin、tica/comic_exhibition → expo；FF 同時有同人展與演唱會，由擷取器依區塊給 typeHint）→ 關鍵字（priority 高者勝，同分不同類 → `type_unresolved`）。場館名中的「展覽館」等不算關鍵字。
- **標籤**：`SOURCE_AGENCY_TAG`（muse、mightymedia）為來源推論；命中結果的 `matchedBy` 寫入 `event_tag.matched_by`。
- **PoliteClient**：`minIntervalMs` < 3000 或 `maxRetries` > 3 直接拋錯；robots.txt 4xx = 全允許、5xx/連線失敗 = 全禁止；轉址手動跟隨並逐跳檢查 robots。快照存原始 bytes 於 `<source>/<台灣日期>/<sha256>.<ext>`，DB 登記透過 `onSnapshot` 回呼由 apps 層處理（http 不依賴 db）。
- **日期（續）**：`12月12 / 13日`、`12/5、6` 這類同月列舉、每天各自附時刻（取第一天開始／最後一天結束）、同一日期重複出現（視為單一日期）都已支援。
- **場館（續）**：先比對場館欄，未命中才看地址（KKTIX 地址常附「位於華山1914…」）。
- **樣本測試**：日期／票價樣本放在 `packages/normalize/test/fixtures/{dates,prices}.txt`（`輸入 | 時間 | 預期`），PoC 遇到新格式就加一行。

### 擷取器、管線、後台重點（scrapers / dedup / worker / web）

- **Scraper**（`packages/scrapers/src/<source>/`）：`listUrls()` ＋ 純函式 `parseList()`；`fixtureStatus: 'synthetic'` 表示來源結構未驗證，pipeline 預設略過（`--allow-unverified` 才執行）。每來源有 `README.md`（端點、robots 檢查日、external_id、已知例外）與真實 fixture。
- **必要欄位驗證**：`normalizeCandidate()`（`scrapers/src/_shared/validate.ts`）把候選轉成 `NormalizedEvent` 並給 `review_reasons`；任一原因 → `pending_review`。KKTIX 規模門檻：場館不在字典且票價上限 < `KKTIX_MIN_PRICE_MAX` → `below_scale_threshold`。
- **去重**（`@aeh/dedup` 純函式 ＋ `@aeh/db` 的 pg_trgm 查詢）：`dedup_key` = 正規化標題（去空白）｜台灣開始日｜場館 → 完全相同才自動合併；±`DEDUP_DATE_WINDOW_DAYS` 天、場館不衝突、相似度 ≥ `DEDUP_POSSIBLE_MIN` → `possible_duplicate`。TS 版 `trigramSimilarity()` 與 pg_trgm 結果一致（已對 DB 實測）。
- **重新擷取的合併規則**（`planSourceUpdate`）：主要來源覆寫未鎖定欄位；非主要來源只補 null。鎖定欄位只有在「來源值相較**上次解析**有變」時才標 `source_changed`（人工值本來就和來源不同，不能每次都標）。審核原因依新欄位重算（`pruneResolvedReasons()`，core），順序固定為 `REVIEW_REASONS` 的順序（否則重跑會被誤判為變更）。
- **Idempotent**：`source_item` 以內容 hash 判斷；`crawl` 內容未變就不處理，`reparse` 強制重算但結果相同時不產生任何寫入。整合測試涵蓋（`apps/worker/test/pipeline.test.ts`）。
- **告警**（`apps/worker/src/alerts.ts`）：規則（失敗、連續 N 次 0 筆、缺漏率突增）是純函式 `evaluateRunAlerts()`；節流狀態存 DB `alert_state`（CLI 與排程是不同 process）。`ALERT_MODE=console` 只寫 log。
- **後台**（`apps/web`）：`src/proxy.ts`（Next 16 的 middleware）做 Basic Auth，操作者名稱寫進 `x-admin-user` → `audit_log.actor`。Server Actions 在 `app/(admin)/admin/actions.ts`；欄位只有「實際有變」才寫入 `locked_fields`（表單的 23:59 存成 23:59:59，避免未改的表單被誤鎖）。發布前檢查必要欄位與審核原因，DB CHECK 約束是最後防線。
- **新 schema**（migration `0001_review_dedup_alerts`）：`event.dedup_key`、`event.review_notes`、`crawl_run.items_missing_fields`、`alert_state` 表。
- **人工狀態鎖**（`event.status_locked`，migration `0002`）：後台「退回待審／隱藏／取消／結束」會鎖定狀態，管線不再自動改變（含自動發布）；手動發布時解除。拆分出的新活動也是鎖定的待審。
- **執行鎖**：`crawl_run_one_running_uq`（partial unique index）保證同一來源同時只有一個執行中的 run（排程與手動 CLI 互斥）；超過 6 小時仍 running 的殘留 run 會被標為失敗。
- **線上活動（C6）**：海外地名優先於線上判定；只有 `ONLINE_TRUSTED_SOURCES`（kktix、cwt、ff）的線上活動可自動發布，其它來源 → `outside_taiwan` 待審並附說明。
- **robots.txt 快取**：24 小時（取得失敗 1 小時）後重讀，排程程序不必重啟就會套用網站的新規則。
- **KKTIX 規模門檻**：場館不在字典時，票價達 `KKTIX_MIN_PRICE_MAX` 或命中作品/聲優/歌手標籤（`KKTIX_TAG_PASSES`）才算達門檻。
- **後台編輯**：讓已發布活動不再符合發布條件時，自動退回待審並補上原因（不會撞 DB CHECK）。
- **前台**（`apps/web/src/app/(public)`，Phase 2）：查詢在 `@aeh/db` 的 `repositories/public-event.ts`，只回傳 `published`（月曆可含 `ended`），不回傳審核原因／`parsed`。篩選狀態全部放在 URL（`lib/public/filters.ts` 純函式解析，無效值忽略）；群組內 OR、群組間 AND。「已開賣」只依 `sale_start_at` 判定，未提供者不猜測。詳情頁必附主要來源連結（C8）。`loading.tsx` 只放在 `(discovery)` 群組：放在詳情頁上層會讓 `notFound()` 回 200。CSS 以 `--s-` 變數、`.site` 範圍隔離 admin 樣式。
- **測試覆蓋率**：`pnpm coverage`（normalize / tagger / dedup，門檻 80%）。
