# CLAUDE.md — Anime Event Hub TW (MVP)

台灣動漫活動整合平台：從代理商官網、售票平台、同人展與綜合展官網定時擷取活動資訊，經**規則式**正規化、標籤、去重後彙整呈現；規則無法處理的資料進入**人工審核佇列**。

- 企劃書：`docs/proposal.md`（v2.1）— 範圍與「為什麼」
- 技術規格：`docs/tech-spec.md`（v0.2，D1–D7 已確認）— 架構、資料模型、任務拆解（T0–T10）
- 有疑義時以 tech-spec 為準；需要改動已確認決策（✅）時，先詢問使用者，不要自行變更。

目前進度：**Phase 1 的 T0–T10 皆已實作**（core、db、字典、normalize、http、scrapers、tagger、dedup、worker、/admin）。擷取器：KKTIX、CWT、FF、曼迪以 2026-11-18 的真實快照為 fixture；**木棉花官網無法連線，擷取器為未驗證（synthetic）狀態，pipeline 預設略過**；tica／comic_exhibition 尚未實作（待 PoC 檢視官網）。

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
- **日期**：`parseEventDate(dateText, timeText, { referenceDate })`，`referenceDate` 傳公告日（沒有才用擷取日）。缺年份以「結束日 ≥ 基準日」推論並標 `yearInferred`；星期不符、多場次、不連續日期、`11/30-2` 之類一律回 `ambiguous`。全天區間的 `endAt` = 結束日 23:59:59（台灣時間）。
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

## 開發慣例

- **時區**：一律以 `Asia/Taipei` 解析（`@aeh/core` 的 `TIMEZONE`），DB 用 `timestamptz` 存 UTC。區分 `all_day` 與有時刻的活動。使用 `date-fns-tz`，不要用 `new Date('2026-11-16')`（會被當成 UTC）。
- **字串比對**：比對一律經 `normalizeForMatch()`（T4 實作）；**顯示一律用原文**。
- **人工覆寫**：管理者改過的欄位寫入 `locked_fields`，重新擷取不得覆蓋；來源變動改標 `source_changed` 待審。
- **去重**：寧可漏合併（進待審），不要誤合併。灰色區間 → `possible_duplicate`。
- **門檻值設定化**：KKTIX 規模門檻、連續 N 次 0 筆告警（預設 3）等都放設定，不寫死。
- **測試**：解析器一律用離線 HTML fixture（`fixtures/*.html`，保存原始 bytes），測試不打真實網站。DB 整合測試用 `DATABASE_URL_TEST`（`packages/db/test/helpers.ts` 會 drop schema 重建，僅允許名稱以 `_test` 結尾的 DB）；worker 的管線整合測試另外自動建立 `<name>_worker_test`，避免 turbo 平行執行時互相 drop schema。未設定時略過並警告，因此 `pnpm test` 前要先 `pnpm db:up`。
- **告警**：Slack webhook（`SLACK_WEBHOOK_URL`），未設定時降級為 log；webhook 失敗不得中斷管線。
- **機密**：`.env` 不進版控；不要把 webhook URL、個人聯絡資料寫進程式碼。
- **語言**：程式碼識別字用英文；註解、UI、log 訊息、文件可用繁體中文。
- TypeScript：`strict` + `noUncheckedIndexedAccess`；ESM；`moduleResolution: Bundler`（相對 import 不需副檔名）；型別 import 用 `import type`。

---

## 常用指令

> 需求：Node ≥ 22.12（`.nvmrc` = 22）、pnpm 12、Docker。首次請 `cp .env.example .env`。

```bash
pnpm i                 # 安裝（esbuild 的 install script 已在 pnpm-workspace.yaml allowBuilds 允許）

# 資料庫（Docker，host 埠預設 5433）
pnpm db:up             # 啟動 PostgreSQL 16 並等待 healthy
pnpm db:down           # 停止（保留資料）
pnpm db:reset          # 刪除 volume 重建（會重跑 docker/postgres/init）
pnpm db:psql           # 進入 psql
pnpm db:generate       # drizzle-kit 依 schema 產生 migration（packages/db/migrations）
pnpm db:migrate        # 套用 migration
pnpm db:seed           # 驗證並匯入 data/dictionaries/*.yaml（可重複執行）
pnpm db:studio         # Drizzle Studio

# 開發
pnpm dev                                   # turbo：web（:3000）+ worker（tsx watch）
pnpm --filter @aeh/web dev                 # 只跑後台
pnpm crawl --source kktix --dry-run        # 單一來源，只印結果不寫 DB
pnpm crawl --source cwt -v                 # 擷取並列出每筆的處理結果
pnpm crawl --all                           # DB 中 enabled 的來源
pnpm crawl --from-snapshot <raw_snapshot.id>
pnpm reparse --source kktix                # 以最近一次擷取的快照重跑解析，不打網路
pnpm --filter @aeh/worker cli dedup [--dry-run]   # 重算去重鍵並合併同鍵活動
pnpm --filter @aeh/worker cli cleanup             # 刪除逾期快照（≤ 30 天）、標記已結束活動
pnpm --filter @aeh/worker start            # 排程（node-cron，Asia/Taipei；CRON_DAILY / CRON_WEEKLY / CRON_CLEANUP）

# 品質檢查
pnpm typecheck         # turbo → 各套件 tsc（web 先跑 next typegen）
pnpm test              # turbo → 各套件 vitest run
pnpm lint              # 根目錄 eslint（flat config）
pnpm format            # prettier --write（docs/、fixtures/ 不格式化）
pnpm check             # format:check + lint + typecheck + test（提交前跑這個）

# 單一套件
pnpm --filter @aeh/normalize test
pnpm --filter @aeh/normalize exec vitest      # watch mode
```

---

## 注意事項 / 已知陷阱

- **TypeScript 鎖在 `~6.0`**：typescript-eslint 目前只支援 `<6.1`，不要升到 TS 7。
- **本機 5432 已有 Postgres**：Docker DB 映射到 `POSTGRES_PORT`（預設 5433），`DATABASE_URL` 要一致。
- `docker/postgres/init/*.sql` 只在 volume **首次**建立時執行；第一支 migration 仍須自己 `CREATE EXTENSION IF NOT EXISTS pg_trgm;`。
- `pnpm --filter` 會把 cwd 換成套件目錄；worker 的 `SNAPSHOT_DIR` 相對路徑以 **repo 根目錄**為基準解析（`apps/worker/src/env.ts`）。
- `apps/web/next-env.d.ts` 由 Next 產生且已 gitignore；`typecheck` 會先 `next typegen`。
- `docker-compose.yml` 的 `profiles: [full]`（worker/web 容器）尚未加入，等兩個 app 有 Dockerfile 後補上。
- **被 Next 打包的套件不能用 `new URL('../x/', import.meta.url)`**：Turbopack 會把它當成資產解析而 build 失敗（`packages/db/src/env.ts` 改用 `path.join`）。
- KKTIX 的 `events.json` 在 Cloudflare 驗證之後，只用 Atom feed；不要嘗試繞過防護。
