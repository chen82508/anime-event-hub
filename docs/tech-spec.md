# 🛠️ 技術規格書：台灣動漫活動整合平台 (Anime Event Hub TW — MVP)

> **版本**：v0.2（D1–D7 已確認）｜**對應企劃**：`docs/proposal.md` v2.1｜**日期**：2026-11-16
> **狀態標記**：✅ 已確認（來自企劃書或使用者指示） / 🟡 本文件提議，待確認 / ❓ 待決策

---

## 0. 文件目的與範圍

本文件將企劃書 v2.1 轉為可執行的技術決策與 Phase 1 任務清單。範圍以 **Phase 1：資料結構與擷取管線** 為主，Phase 0（PoC）與 Phase 2/3 僅列出與 Phase 1 有介面關係的部分。

---

## 1. 核心約束（Non-negotiables）

| # | 約束 | 來源 | 對實作的意義 |
|---|---|---|---|
| C1 | **全 TypeScript monorepo** | ✅ 使用者指示 | 擷取器、解析器、API、前端共用型別；不引入 Python 爬蟲 |
| C2 | **單語系：繁體中文** | ✅ 企劃 §2 | 無 i18n 框架、無翻譯欄位；標題**保留來源原文**（含日文），不翻譯 |
| C3 | **完全不串接 LLM** | ✅ 企劃 §0、§2 | 所有解析/分類/文案皆為規則或模板；同一輸入必得同一輸出（可重現） |
| C4 | **規則解析 ＋ 人工審核佇列** | ✅ 企劃 §4 | 任一必要欄位抽取失敗 → `pending_review`，**不自動上架** |
| C5 | **標籤：來源推論 → 關鍵字字典 → 人工補標** | ✅ 企劃 §3 | 未命中字典者**不自動建立新標籤** |
| C6 | **僅收錄在台灣舉辦之活動** | ✅ 企劃 §2 | 需有「非台灣場館 → 排除」規則；線上活動需台灣主辦/售票 |
| C7 | **本機 Docker 優先** | ✅ 使用者指示 | `docker compose up` 即可起 DB；不依賴任何雲端服務即可完整開發與測試 |
| C8 | **合規擷取** | ✅ 企劃 §4 | 遵守 `robots.txt`、每來源請求間隔 ≥ 數秒、每日 1 次（大展每週 1 次）、只存詮釋性資料、強制保留原始連結 |
| C9 | **不轉載完整文案與主視覺** | ✅ 企劃 §4 | DB 不存公告全文供前台顯示；原始快照僅供除錯，保留 ≤ 30 天 |
| C10 | **拓元、ibon 暫緩；不爬社群平台** | ✅ 企劃 §3、§5 | 不實作這些擷取器 |
| C11 | **單一 Worker、無佇列/分散式** | ✅ 企劃 §6.3 | 數百筆/年量級；排程在單一 process 內序列執行即可 |

---

## 2. 技術選型 🟡

| 層面 | 選擇 | 理由 |
|---|---|---|
| Runtime | Node.js 22 LTS | 原生 `fetch`、穩定 ESM |
| Monorepo | pnpm workspaces ＋ Turborepo | 輕量、快取建置與測試 |
| 語言設定 | TypeScript `strict: true`、ESM、共用 `tsconfig.base.json` | |
| DB | PostgreSQL 16（Docker） ✅ D2 | `pg_trgm` 支援去重的模糊比對；企劃允許 SQLite，但 PG 對 trigram/JSONB 支援較佳 |
| ORM / Migration | Drizzle ORM ＋ drizzle-kit | 型別推導佳、SQL 透明、migration 為純 SQL 檔 |
| 驗證 | zod | 擷取結果 → 領域模型的邊界驗證 |
| HTML 解析 | cheerio | 靜態 HTML 足夠；**MVP 不引入 headless browser**（若 PoC 發現必要再評估 Playwright） |
| RSS/Atom | fast-xml-parser 或 rss-parser | |
| HTTP | 原生 fetch ＋ 自製 `PoliteClient`（robots、rate limit、retry、UA、編碼偵測） | |
| 日期 | date-fns ＋ date-fns-tz（時區固定 `Asia/Taipei`） | 避免 JS `Date` 時區陷阱 |
| 排程 | node-cron（worker 內） ＋ CLI 手動觸發 | 符合 C11 |
| Log | pino（JSON） | |
| 測試 | Vitest ＋ HTML fixture 快照 | 解析器以離線 fixture 測試，不打真實網站 |
| Lint/Format | ESLint (typescript-eslint) ＋ Prettier | |
| 審核後台 / 前台 | Next.js（App Router），Phase 1 僅建 `/admin` 審核頁 ✅ D1 | Phase 2 前台共用同一 app 與元件 |
| 告警 | Slack Incoming Webhook ✅ D5 | URL 由 `SLACK_WEBHOOK_URL` 提供；未設定時（如本機/測試）降級為 log |
| 原始快照 | 檔案系統 `./var/snapshots`（Docker volume）✅ D4 | DB 只存路徑與 `content_hash` |

---

## 3. Repository 結構 🟡

```
anime-event-hub/
├─ apps/
│  ├─ worker/            # 排程 + CLI（crawl / reparse / dedup / alert）
│  └─ web/               # Next.js：Phase 1 只做 /admin 審核；Phase 2 做前台
├─ packages/
│  ├─ core/              # 領域型別、zod schema、enum（EventType, Region, Status…）
│  ├─ db/                # Drizzle schema、migrations、seed、repository 函式
│  ├─ http/              # PoliteClient：robots.txt、節流、重試、編碼
│  ├─ normalize/         # 文字正規化、日期/時間、票價、場館/地區解析
│  ├─ tagger/            # 類型推論、關鍵字字典比對
│  ├─ dedup/             # 去重鍵、候選比對、合併
│  └─ scrapers/          # 每來源一個子目錄，實作共同 Scraper 介面
│     ├─ kktix/
│     ├─ muse/
│     ├─ medialink/      # 曼迪
│     ├─ cwt/
│     ├─ ff/
│     └─ ...
├─ data/dictionaries/    # 場館、地區、類型關鍵字、作品/聲優/代理商別名（YAML，seed 用）
├─ docker/               # compose 相關設定
├─ docker-compose.yml
├─ docs/
└─ CLAUDE.md / README.md
```

**相依方向**（不得反向）：`core` ← `normalize` / `tagger` / `dedup` ← `scrapers` ← `apps/*`；`db` 只被 `apps/*` 與 pipeline 編排層使用。解析器（`normalize`、`tagger`、`scrapers` 的 parse 部分）**必須是純函式、不觸碰 DB 與網路**，以利 fixture 測試。

---

## 4. 資料處理管線

```
fetch (PoliteClient)
  └─▶ raw_snapshot（存 HTML/XML + hash，30 天）
        └─▶ parse（來源專屬，純函式）──▶ RawEventCandidate[]
              └─▶ normalize（文字/日期/票價/場館/地區）
                    └─▶ validate（必要欄位、台灣範圍、規模門檻）
                          ├─ 失敗 ─▶ status = pending_review（附 review_reasons）
                          └─ 通過 ─▶ tag ─▶ dedup ─▶ upsert event ＋ event_source
                                                      └─ 疑似重複 ─▶ pending_review（reason: possible_duplicate）
```

### 4.1 Scraper 介面

```ts
interface Scraper {
  id: SourceId;                       // 'kktix' | 'muse' | ...
  schedule: 'daily' | 'weekly';
  listUrls(): string[];               // 列表頁（含分頁/關鍵字）
  parseList(html: string, url: string): ListItem[];          // 純函式
  parseDetail?(html: string, url: string): RawEventCandidate; // 純函式
  inferType?(c: RawEventCandidate): EventType | null;         // 來源推論（如 CWT → 同人展）
}
```

### 4.2 必要欄位（缺任一即待審）

`title`、`start_at`（至少到日期）、`venue` 或 `is_online`、`source_url`。
選填：`end_at`、`price_min/max`、`sale_start_at`、`city`。

### 4.3 審核原因代碼（`review_reasons[]`）

`missing_date` / `ambiguous_date` / `missing_venue` / `unknown_venue` / `outside_taiwan` / `possible_duplicate` / `type_unresolved` / `below_scale_threshold` / `parse_error` / `source_changed`（已發布活動的來源內容變動）

---

## 5. 資料模型（初稿）🟡

| 表 | 主要欄位 | 說明 |
|---|---|---|
| `source` | `id`, `name`, `kind`(agency/ticketing/doujin/expo), `base_url`, `schedule`, `enabled`, `last_success_at`, `consecutive_empty_runs` | 告警依據 |
| `crawl_run` | `id`, `source_id`, `started_at`, `finished_at`, `status`, `items_found`, `error` | 每次執行紀錄 |
| `raw_snapshot` | `id`, `source_id`, `url`, `fetched_at`, `content_hash`, `storage_path`, `encoding` | 本體存於 `./var/snapshots/<source>/<yyyy-mm-dd>/<hash>.html`；保留 30 天，排程清理（檔案與列一起刪） |
| `source_item` | `id`, `source_id`, `external_id`, `url`, `content_hash`, `parsed`(JSONB), `event_id`(nullable), `first_seen_at`, `last_seen_at` | `UNIQUE(source_id, external_id)`；idempotent upsert |
| `event` | `id`, `title`(原文), `title_normalized`, `type`, `start_at`, `end_at`, `all_day`, `venue_id`, `is_online`, `region`, `price_min`, `price_max`, `is_free`, `sale_start_at`, `status`, `review_reasons[]`, `locked_fields[]`, `created_at`, `updated_at`, `published_at` | 時間一律 `timestamptz`（UTC 儲存） |
| `event_source` | `event_id`, `source_item_id`, `url`, `is_primary` | 一活動多來源連結 |
| `venue` | `id`, `name`, `aliases[]`, `city`, `region`, `address` | 場館字典 |
| `tag` | `id`, `kind`(work/agency/voice_actor/artist), `name`, `aliases[]` | 別名字典 |
| `event_tag` | `event_id`, `tag_id`, `origin`(source/dict/manual) | |
| `type_keyword` | `id`, `event_type`, `keyword`, `priority` | 類型關鍵字字典 |
| `audit_log` | `id`, `actor`, `action`, `entity`, `entity_id`, `diff`(JSONB), `at` | 人工操作追蹤 |

**Enum**
- `EventType`：`concert` 演唱會 / `fan_meeting` 見面會 / `exhibition` 展覽 / `popup_cafe` 快閃店・咖啡廳 / `doujin` 同人展 / `expo` 綜合動漫展 / `other`
- `Region`：`north` / `central` / `south` / `east` / `islands` / `online`
- `EventStatus`：`pending_review` / `published` / `hidden` / `cancelled` / `ended`

**地區對照（✅ D3）**：北＝基隆、台北、新北、桃園、新竹市/縣、宜蘭；中＝苗栗、台中、彰化、南投、雲林；南＝嘉義市/縣、台南、高雄、屏東；東＝花蓮、台東；離島＝澎湖、金門、連江。

**人工覆寫保護**：管理者修改過的欄位寫入 `locked_fields`，後續重新擷取**不得覆蓋**；來源內容變動時改標 `source_changed` 待審。

---

## 6. 本機開發環境（Docker 優先）🟡

- `docker-compose.yml`：`postgres:16`（啟用 `pg_trgm`）＋ 選配 `adminer`；`profiles: [full]` 時加上 `worker`、`web` 容器。
- 日常開發：DB 在 Docker，`worker` / `web` 在 host 以 `pnpm dev` 執行（熱重載較快）。
- `.env.example`：`DATABASE_URL`、`ADMIN_BASIC_AUTH`、`CRAWL_USER_AGENT`、`CRAWL_MIN_INTERVAL_MS`、`SLACK_WEBHOOK_URL`（Slack webhook 已建立，URL 只放 `.env`、不進版控；未設則告警降級為 log）、`SNAPSHOT_DIR`（預設 `./var/snapshots`）、`TZ=Asia/Taipei`。
- 常用指令（預定）：
  - `pnpm db:up` / `pnpm db:migrate` / `pnpm db:seed`
  - `pnpm crawl --source kktix [--dry-run] [--from-snapshot <id>]`
  - `pnpm reparse --source muse`（以既存快照重跑解析，不打網路）
  - `pnpm test` / `pnpm lint` / `pnpm typecheck`

---

## 7. Phase 1 任務拆解

> **Phase 0 併入（✅ D6）**：完成 T0–T5 ＋ T6 前三個擷取器（KKTIX、CWT、木棉花）後即開始實際收資料 2–4 週，作為 PoC；期間持續進行 T7–T10，PoC 結束後校正門檻值並補齊其餘來源。

### T0｜Monorepo 骨架與開發環境
- **檔案**：`package.json`、`pnpm-workspace.yaml`、`turbo.json`、`tsconfig.base.json`、`.eslintrc`/`eslint.config.js`、`.prettierrc`、`docker-compose.yml`、`.env.example`、`.nvmrc`、`CLAUDE.md`、`README.md`
- **DoD**：全新 clone 後 `pnpm i && pnpm db:up && pnpm typecheck && pnpm test` 全綠；CI-like 指令於 README 說明。

### T1｜領域模型 `packages/core`
- **檔案**：`src/enums.ts`、`src/schemas/event.ts`（zod）、`src/schemas/candidate.ts`、`src/review-reasons.ts`、`src/index.ts`
- **DoD**：所有 enum 與 zod schema 皆有單元測試；`RawEventCandidate` → `NormalizedEvent` 型別可在其他套件引用。

### T2｜資料庫 `packages/db`
- **檔案**：`src/schema/*.ts`（§5 各表）、`drizzle.config.ts`、`migrations/0000_init.sql`、`src/seed.ts`、`src/repositories/{event,sourceItem,crawlRun,dictionary}.ts`
- **DoD**：migration 可在空 DB 上套用與重套；seed 匯入 `data/dictionaries/*.yaml`；`UNIQUE(source_id, external_id)` 與 `pg_trgm` 索引存在；repository 有整合測試（使用 Docker DB）。

### T3｜字典資料 `data/dictionaries`
- **檔案**：`venues.yaml`（~30 場館含別名、城市）、`regions.yaml`（縣市 → 地區）、`event-type-keywords.yaml`、`tags-agency.yaml`、`tags-works.yaml`、`tags-voice-actors.yaml`
- **DoD**：主要場館（台北世貿、南港展覽館 1/2 館、花博爭艷館、台中國際展覽館、高雄展覽館、Legacy、Zepp New Taipei 等）皆有條目；YAML 有 schema 驗證，seed 時錯誤會中止。

### T4｜正規化 `packages/normalize`
- **檔案**：`src/text.ts`（NFKC、全半形、臺/台、空白/括號/emoji 清理、標題比對用正規化）、`src/date.ts`、`src/price.ts`、`src/venue.ts`、`src/region.ts`、`test/fixtures/*.txt`
- **DoD**：
  - 日期解析涵蓋：西元/民國年、`11/16(六)`、`2026.11.16`、`11月16日`、區間（`11/16–11/20`、跨月、跨年）、`即日起至…`、`19:30`/`下午7點半`、全形數字、缺年份推論。
  - 無法唯一決定者回傳 `ambiguous` 而非猜測。
  - 票價：`NT$1,200`、`$800 / $1,500`、`免費入場`、`預售/現場` → `min/max/is_free`。
  - 測試案例 ≥ 60 條，皆以真實格式樣本（去識別）為主。

### T5｜HTTP 與擷取框架 `packages/http` ＋ `packages/scrapers/_shared`
- **檔案**：`http/src/polite-client.ts`、`http/src/robots.ts`、`http/src/encoding.ts`、`scrapers/src/types.ts`、`scrapers/src/registry.ts`
- **DoD**：robots.txt 禁止路徑會拒絕請求並記錄；同 host 最小間隔可設定（預設 ≥ 3 秒）；指數退避重試 ≤ 3 次；可偵測 Big5/UTF-8；所有回應寫入 `SNAPSHOT_DIR` 並於 `raw_snapshot` 登記。

### T6｜各來源擷取器 `packages/scrapers/<source>`
- **順序**：KKTIX（高結構）→ CWT（中）→ 木棉花（低）→ FF → 曼迪 → 動漫節/漫博 → 其它代理商 1–2 家（✅ D7：PoC 檢視各官網結構後再選定）
- **每個來源檔案**：`index.ts`（Scraper 實作）、`parse.ts`、`fixtures/*.html`、`parse.test.ts`、`README.md`（來源結構筆記、robots 規則、已知例外）
- **DoD（每來源）**：fixture 解析測試通過；`--dry-run` 可列印候選結果；`external_id` 穩定（不依賴列表順序）；KKTIX 另需關鍵字 ＋ 規模門檻過濾（場館白名單／票價），門檻值於 PoC 後校正。

### T7｜標籤 `packages/tagger`
- **檔案**：`src/type-classifier.ts`（來源推論 → 關鍵字 → `type_unresolved`）、`src/tag-matcher.ts`（別名比對，最長匹配優先）、`src/index.ts`
- **DoD**：同一輸入結果穩定；可回傳「命中哪條規則」作為除錯資訊；短別名（≤2 字）需整詞邊界或白名單，避免誤命中。

### T8｜去重 `packages/dedup`
- **檔案**：`src/key.ts`（正規化標題 ＋ 開始日期 ＋ 場館）、`src/candidates.ts`（trigram 相似度查候選）、`src/merge.ts`
- **DoD**：完全命中 key → 自動合併並新增 `event_source`；相似度落在灰色區間 → 不合併，標 `possible_duplicate` 待審；合併不覆寫 `locked_fields`。

### T9｜管線編排與 Worker `apps/worker`
- **檔案**：`src/pipeline.ts`、`src/cli.ts`（crawl / reparse / dedup / cleanup）、`src/scheduler.ts`、`src/alerts.ts`
- **DoD**：同一快照重跑兩次結果相同（idempotent）；單一來源失敗不影響其他來源；`連續 N 次 0 筆`（預設 N=3）、來源執行失敗、欄位缺漏率突增皆以 Slack webhook 告警（`apps/worker/src/alerts.ts`；同一告警需節流避免洗版；webhook 失敗不得中斷管線）；快照 30 天清理排程。

### T10｜人工審核佇列 `apps/web/(admin)`
- **頁面**：待審列表（依原因篩選）、單筆編輯（欄位補齊、類型覆寫、加標籤）、「新增標籤 / 別名」「新增場館」快捷操作、疑似重複的合併/拆分、發布/隱藏
- **DoD**：Basic Auth 保護；每次操作寫入 `audit_log` 並更新 `locked_fields`；新增別名後可一鍵對待審資料重新標籤。

### Phase 1 整體 DoD
1. 所有已啟用來源可於本機 `pnpm crawl --all` 完整跑完，無未處理例外。
2. 產出的活動中，通過驗證者自動 `published`，其餘皆帶有至少一個 `review_reason`。
3. 待審比例、每來源筆數可由 `crawl_run` 查詢（用於對照企劃 §6 推估值）。
4. 解析相關套件測試覆蓋率 ≥ 80%（`normalize`、`tagger`、`dedup`）。

---

## 8. 技術風險與注意事項

| # | 風險 / 盲點 | 說明 | 對策 |
|---|---|---|---|
| R1 | **時區** | `new Date('2026-11-16')` 視為 UTC，台灣顯示會差 8 小時；只有日期的活動被誤轉成前一天 | 一律以 `Asia/Taipei` 解析；區分 `all_day` 與有時刻活動；禁止在 parse 層使用無時區 `Date` 建構 |
| R2 | **缺年份推論** | 公告常只寫「11/16」，跨年公告（12 月發的 1 月活動）易推錯 | 以公告發布日為基準，取「≥ 發布日的最近日期」；推論結果標記 `year_inferred`，差距異常則 `ambiguous_date` |
| R3 | **民國年與中文數字** | `115年`、`十一月`、全形 `１１／１６` | 先 NFKC 再解析；民國年 +1911；單元測試涵蓋 |
| R4 | **字串正規化不一致** | 臺/台、全半形、`～`/`~`/`－`、`【】`、日文 `・`、零寬字元、emoji | 單一 `normalizeForMatch()` 用於比對；**顯示一律用原文**；正規化函式變更須重跑去重測試 |
| R5 | **一則公告多場次/多城市** | 巡迴快閃、CWT 多場次、演唱會多日 | 定義規則：不同場館 → 拆成多筆活動；同場館連續日期 → 單筆 `start/end`；無法判斷 → 待審 |
| R6 | **去重誤合併 / 漏合併** | 不同來源標題差異大（「【台北】XXX 快閃店」vs「XXX POP UP STORE」） | 寧可漏合併（待審），不要誤合併；灰色區間進待審 |
| R7 | **人工修改被重爬覆蓋** | 每日重新擷取會蓋掉人工補齊的欄位 | `locked_fields` 機制；來源變動改走 `source_changed` 待審 |
| R8 | **`external_id` 不穩定** | 部分代理商無 ID，以 URL 或標題當 key，改版即重複建檔 | 優先使用 URL 中的 ID；退而求其次用 `正規化URL`；記錄於來源 README |
| R9 | **選擇器失效靜默** | 改版後回傳 0 筆或欄位全空，但不報錯 | 0 筆告警 ＋「欄位缺漏率突增」告警；parse 輸出經 zod 驗證 |
| R10 | **編碼** | 舊網站可能為 Big5，或 header 與 meta 不一致 | 依 header → meta → 偵測 順序解碼；fixture 保存原始 bytes |
| R11 | **非活動公告混入** | 代理商「最新消息」大量為商品/授權新聞 | 來源層排除關鍵字（「預購」「發售」「代理決定」）＋ 無日期/場館者直接待審或略過（記錄略過原因） |
| R12 | **海外活動誤收** | 標題含「東京」「大阪」或日本場館 | 場館字典無命中且出現海外地名 → `outside_taiwan` |
| R13 | **合規** | KKTIX 等平台條款、robots 變動 | 每來源 README 記錄 robots 檢查日期；UA 標示專案名稱與聯絡方式（不放個人資料於程式碼，改走 env） |
| R14 | **別名誤命中** | 短作品名（如二字作品名）命中無關標題 | 最長匹配優先、短別名需邊界或白名單、記錄命中規則以便除錯 |
| R15 | **Phase 0 數字未校正** | 企劃 §6 為推估值 | 門檻值（KKTIX 規模、N 次 0 筆）皆設為設定值，不寫死 |

---

## 9. 決策紀錄 ✅（2026-11-16 確認）

| # | 問題 | 決策 |
|---|---|---|
| D1 | Phase 1 審核介面形式 | Next.js `/admin`，Phase 2 前台共用同一 app |
| D2 | DB | PostgreSQL 16 |
| D3 | 地區劃分 | 宜蘭 → 北、苗栗 → 中（見 §5） |
| D4 | 原始快照儲存 | 檔案系統 `./var/snapshots`（Docker volume），DB 存路徑與 hash |
| D5 | 告警管道 | Slack Incoming Webhook（已建立）；URL 於 `.env` 的 `SLACK_WEBHOOK_URL` 設定，不進版控 |
| D6 | Phase 0 執行方式 | 併入 Phase 1：T0–T5 ＋ 前三個擷取器完成即開始 PoC 收資料 |
| D7 | 其它代理商選擇 | 待 PoC 檢視各官網結構後決定 |
