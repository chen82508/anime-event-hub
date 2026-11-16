# CLAUDE.md — Anime Event Hub TW (MVP)

台灣動漫活動整合平台：從代理商官網、售票平台、同人展與綜合展官網定時擷取活動資訊，經**規則式**正規化、標籤、去重後彙整呈現；規則無法處理的資料進入**人工審核佇列**。

- 企劃書：`docs/proposal.md`（v2.1）— 範圍與「為什麼」
- 技術規格：`docs/tech-spec.md`（v0.2，D1–D7 已確認）— 架構、資料模型、任務拆解（T0–T10）
- 有疑義時以 tech-spec 為準；需要改動已確認決策（✅）時，先詢問使用者，不要自行變更。

目前進度：**T0（Monorepo 骨架）完成**。各套件 `src/index.ts` 內的 `TODO(Tn)` 標示對應的 tech-spec 任務。

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
  scrapers/      @aeh/scrapers   src/<source>/ 每來源一個子目錄（kktix, cwt, muse, ff, medialink…）
data/dictionaries/   場館、地區、類型關鍵字、作品/聲優/代理商別名（YAML，seed 用）
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

---

## 開發慣例

- **時區**：一律以 `Asia/Taipei` 解析（`@aeh/core` 的 `TIMEZONE`），DB 用 `timestamptz` 存 UTC。區分 `all_day` 與有時刻的活動。使用 `date-fns-tz`，不要用 `new Date('2026-11-16')`（會被當成 UTC）。
- **字串比對**：比對一律經 `normalizeForMatch()`（T4 實作）；**顯示一律用原文**。
- **人工覆寫**：管理者改過的欄位寫入 `locked_fields`，重新擷取不得覆蓋；來源變動改標 `source_changed` 待審。
- **去重**：寧可漏合併（進待審），不要誤合併。灰色區間 → `possible_duplicate`。
- **門檻值設定化**：KKTIX 規模門檻、連續 N 次 0 筆告警（預設 3）等都放設定，不寫死。
- **測試**：解析器一律用離線 HTML fixture（`fixtures/*.html`，保存原始 bytes），測試不打真實網站。DB 整合測試用 `DATABASE_URL_TEST`。
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
pnpm db:seed           # 匯入 data/dictionaries/*.yaml（T2/T3 實作）
pnpm db:studio         # Drizzle Studio

# 開發
pnpm dev                                   # turbo：web（:3000）+ worker（tsx watch）
pnpm --filter @aeh/web dev                 # 只跑後台
pnpm crawl --source kktix --dry-run        # 單一來源（T9 實作）
pnpm crawl --all
pnpm crawl --source kktix --from-snapshot <id>
pnpm reparse --source muse                 # 以既存快照重跑解析，不打網路
pnpm --filter @aeh/worker cli dedup|cleanup

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
