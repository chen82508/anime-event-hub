# Anime Event Hub TW 🎌

**台灣動漫活動整合平台（MVP）** — 把散落在代理商官網、售票平台、同人展與動漫展官網的活動資訊彙整到同一個地方，並提供開賣／舉辦提醒。

- 只收錄**在台灣舉辦**的活動（含日本 IP 來台展覽、海外聲優來台演出）
- 介面與內容僅提供**繁體中文**；活動標題保留來源原文
- **不使用 LLM**：擷取、正規化、標籤、去重全部採用規則與字典；規則處理不了的資料進入人工審核佇列
- MVP 來源：KKTIX、木棉花、曼迪、開拓動漫祭 FF、CWT、台北國際動漫節／漫畫博覽會（拓元、ibon 暫緩）

> ⚠️ 本專案為模擬提案（Simulated Project），文件中的資料規模為推估值。

📄 文件：[企劃書](docs/proposal.md) ・ [技術規格書](docs/tech-spec.md) ・ [CLAUDE.md](CLAUDE.md)（架構原則與指令速查）

---

## 技術棧

| 層面       | 選擇                                                            |
| ---------- | --------------------------------------------------------------- |
| Runtime    | Node.js 22 LTS（ESM）                                           |
| Monorepo   | pnpm workspaces ＋ Turborepo                                    |
| 語言       | TypeScript（strict）                                            |
| DB         | PostgreSQL 16 ＋ `pg_trgm`（Docker），Drizzle ORM / drizzle-kit |
| 解析       | cheerio、fast-xml-parser、zod、date-fns-tz                      |
| Worker     | node-cron、pino                                                 |
| 後台／前台 | Next.js（App Router）                                           |
| 測試／品質 | Vitest、ESLint（typescript-eslint）、Prettier                   |

## 專案結構

```
apps/
  worker/     排程 + CLI（crawl / reparse / dedup / cleanup）
  web/        Next.js：/admin 審核後台（Phase 1）、前台（Phase 2）、收藏／訂閱／我的追蹤（Phase 3）
packages/
  core/       領域型別、zod schema、enum
  db/         Drizzle schema、migrations、seed、repository
  http/       PoliteClient（robots.txt、節流、重試、編碼）
  normalize/  文字、日期、票價、場館／地區正規化
  tagger/     活動類型推論、別名字典比對
  dedup/      跨來源去重
  notify/     訂閱比對、提醒時機、固定繁中推播模板、LINE 簽章（純函式）
  scrapers/   每來源一個擷取器
data/dictionaries/   場館、地區、關鍵字、作品／聲優／代理商別名（YAML）
docker/              Docker 相關設定（Postgres 初始化 SQL）
```

---

## 本地開發環境

### 1. 前置需求

- **Node.js ≥ 22.12**（建議用 nvm / fnm：`nvm use` 會讀取 `.nvmrc`）
- **pnpm 12**（`corepack enable` 後會依 `packageManager` 欄位自動取得）
- **Docker Desktop**（或任何支援 `docker compose` v2 的環境）

### 2. 安裝相依套件

```bash
pnpm i
```

### 3. 設定環境變數

```bash
cp .env.example .env
```

| 變數                      | 說明                                                                                | 預設                                                         |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `POSTGRES_PORT`           | Docker Postgres 映射到 host 的埠（避開本機既有的 5432）                             | `5433`                                                       |
| `DATABASE_URL`            | 開發用 DB 連線字串                                                                  | `postgres://aeh:aeh@localhost:5433/anime_event_hub`          |
| `DATABASE_URL_TEST`       | 整合測試用 DB                                                                       | `postgres://aeh:aeh@localhost:5433/anime_event_hub_test`     |
| `CRAWL_USER_AGENT`        | 擷取器 UA，需標示專案名稱與聯絡方式                                                 | `AnimeEventHubTW-Bot/0.1 (+https://example.invalid/contact)` |
| `CRAWL_MIN_INTERVAL_MS`   | 同一 host 最小請求間隔（毫秒，須 ≥ 3000）                                           | `3000`                                                       |
| `SNAPSHOT_DIR`            | 原始快照目錄（相對路徑以 repo 根目錄為準）                                          | `./var/snapshots`                                            |
| `SLACK_WEBHOOK_URL`       | Slack 告警 webhook；留空則告警只寫 log                                              | （空）                                                       |
| `ALERT_MODE`              | `console`（只寫 log）或 `slack`；留空時依有無 webhook 決定                          | （空）                                                       |
| `ALERT_*`                 | 連續 0 筆門檻、同一告警節流分鐘數、缺漏率突增門檻                                   | `3` / `360` / `0.3`                                          |
| `KKTIX_KEYWORDS`          | KKTIX 搜尋關鍵字（逗號分隔）                                                        | 動漫,動畫,聲優,同人,cosplay                                  |
| `KKTIX_TAG_PASSES`        | KKTIX 規模門檻：場館不在字典時，命中作品/聲優/歌手標籤也算達門檻                    | `true`                                                       |
| `KKTIX_MIN_PRICE_MAX`     | KKTIX 規模門檻（場館不在字典時的票價上限下限）                                      | `1000`                                                       |
| `DEDUP_*`                 | 去重灰色區間下限（pg_trgm）、開始日期容許差距（天）                                 | `0.45` / `1`                                                 |
| `SNAPSHOT_RETENTION_DAYS` | 快照保留天數（≤ 30）                                                                | `30`                                                         |
| `CRON_*`                  | 排程（每日擷取、每週擷取、清理）                                                    | `0 4 * * *` / `0 5 * * 1` / `30 3 * * *`                     |
| `ADMIN_BASIC_AUTH`        | `/admin` 後台 Basic Auth（`user:password`）                                         | `admin:change-me`                                            |
| `NOTIFY_MODE`             | `console`（推播只寫 worker log，免金鑰）或 `live`（實際送出）                       | `console`                                                    |
| `PUBLIC_BASE_URL`         | 通知內連結的網站網址（LINE 訊息附完整網址）                                         | `http://localhost:3000`                                      |
| `WEB_PUSH_VAPID_*`        | Web Push 金鑰（`cli vapid` 產生）與 `WEB_PUSH_SUBJECT` 聯絡資訊                     | （空）                                                       |
| `LINE_CHANNEL_*`          | LINE Messaging API 的 secret／access token；`LINE_OFFICIAL_ACCOUNT_ID` 供加好友連結 | （空）                                                       |
| `NOTIFY_QUIET_HOURS`      | 勿擾時段（台灣時間），期間推播延後                                                  | `23-8`                                                       |
| `NOTIFY_*`                | 開賣前幾小時提醒、活動前一天幾點提醒、合併摘要門檻                                  | `24` / `18` / `3`                                            |
| `CRON_NOTIFY`             | notify 排程（新活動比對、提醒、投遞）                                               | `*/5 * * * *`                                                |
| `TZ`                      | 時區，固定為台灣                                                                    | `Asia/Taipei`                                                |
| `LOG_LEVEL`               | pino log 等級                                                                       | `info`                                                       |

> `.env` 已列入 `.gitignore`，Slack webhook 等機密只放在這裡。

### 4. 啟動 PostgreSQL 16（Docker）

```bash
pnpm db:up
```

這會以 `docker compose up -d --wait postgres` 啟動 `postgres:16-alpine`，並在**首次建立 volume 時**執行 `docker/postgres/init/01-init.sql`：

- 在 `anime_event_hub` 啟用 `pg_trgm`（去重的模糊比對使用）
- 建立整合測試用的 `anime_event_hub_test`，同樣啟用 `pg_trgm`

確認擴充已啟用：

```bash
docker compose exec postgres psql -U aeh -d anime_event_hub -c "select extname, extversion from pg_extension;"
```

其他 DB 指令：

```bash
pnpm db:psql      # 進入 psql
pnpm db:down      # 停止容器（資料保留在 volume）
pnpm db:reset     # 刪除 volume 並重建（會重新執行 init SQL）
```

選配的 Adminer（DB 網頁介面，http://localhost:8080）：

```bash
docker compose --profile tools up -d adminer
```

### 5. 套用 migration 與匯入字典

```bash
pnpm db:migrate
pnpm db:seed
```

- `db:migrate` 套用 `packages/db/migrations/` 下的 migration（可重複執行）
- `db:seed` 先驗證 `data/dictionaries/*.yaml`（縣市、場館、類型關鍵字、來源、標籤別名），**任一錯誤即中止且不寫入 DB**；通過後以 upsert 匯入，可重複執行，不會覆蓋後台新增的別名

修改字典後重新執行 `pnpm db:seed` 即可。

### 6. 開發

```bash
pnpm dev                                  # 同時啟動 web（http://localhost:3000）與 worker
pnpm --filter @aeh/web dev                # 只啟動審核後台（http://localhost:3000/admin）
pnpm crawl --source kktix --dry-run       # 手動擷取單一來源，只印結果不寫 DB
pnpm crawl --all                          # 擷取所有 enabled 來源
pnpm reparse --source kktix               # 以既存快照重跑解析，不打網路（idempotent）
pnpm --filter @aeh/worker cli dedup       # 重算去重鍵並合併同鍵活動
pnpm --filter @aeh/worker cli cleanup     # 刪除逾期快照與通知、標記已結束活動
pnpm --filter @aeh/worker notify          # 新活動比對、收藏提醒、送出推播（--dry-run 只列出）
pnpm --filter @aeh/worker cli vapid       # 產生 Web Push 用的 VAPID 金鑰
pnpm --filter @aeh/worker start           # 啟動排程（每日/每週擷取、每日清理、每 5 分鐘 notify）
```

### 7. 審核後台（/admin）

`pnpm --filter @aeh/web dev` 後開啟 http://localhost:3000/admin ，以 `ADMIN_BASIC_AUTH` 登入。

- **待審列表**：依狀態、審核原因、來源、標題關鍵字篩選
- **單筆編輯**：補齊日期/場館/類型/票價；**修改過的欄位寫入 `locked_fields`**，之後重新擷取不會覆寫（來源變動時標 `source_changed` 待審）
- **發布 / 隱藏 / 取消 / 退回待審**；必要欄位不齊或有審核原因時無法發布
- **疑似重複**：列出相似活動，一鍵合併（來源連結與標籤一併搬移）；被誤合併的來源可「拆分」成獨立活動
- **人工設定的狀態**（退回待審、隱藏等）會鎖定，之後的擷取不會自動改回或自動發布
- **字典快捷操作**：新增標籤/場館別名、新增場館、對待審資料重新標籤
- 每個操作都寫入 `audit_log`

### 8. 前台與訂閱推播（Phase 2–3）

- **探索**（`/`）：列表（依月份分段）／月曆、地區・類型・標籤・日期・開賣狀態篩選（條件全在 URL，可分享），「今天／本週末／30 天內／已開賣」快速篩選
- **活動詳情**（`/events/<id>`）：官方購票／原始公告按鈕置頂（強制導流），收藏、訂閱類型／標籤
- **收藏與訂閱**：不需註冊。第一次收藏時建立匿名訪客（httpOnly cookie，DB 只存 token 的 SHA-256）
- **我的追蹤**（`/me`）：通知匣、收藏、訂閱、通知管道（瀏覽器推播／LINE）、通知偏好、刪除我的資料
- **通知種類**（固定繁中模板，不使用 LLM）：訂閱標籤／類型的新活動上架（一次多筆合併為摘要）、收藏活動開賣前 24 小時、活動前一天 18:00；勿擾時段 23–8 點延後送出

**本機測試推播（不需任何金鑰）**：預設 `NOTIFY_MODE=console`

1. 在網站收藏活動或訂閱類型；到 `/me` 按「取得 LINE 綁定碼」→「本機模擬：直接完成綁定」，再按「傳送測試通知」
2. 執行 `pnpm --filter @aeh/worker notify`，推播內容會以 `［模擬推播］` 寫在 log，投遞狀態標為 `simulated`

**實際送出**（`NOTIFY_MODE=live`）：

- Web Push：`pnpm --filter @aeh/worker cli vapid` 產生金鑰貼到 `.env`；`http://localhost` 可直接測試（iOS 需「加入主畫面」後才支援）
- LINE：在 LINE Developers 建立 Messaging API channel，設定 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_OFFICIAL_ACCOUNT_ID`，webhook 設為 `https://<網域>/api/line/webhook`（需公開 HTTPS；本機可用 tunnel）

### 擷取來源狀態（2026-11-18）

| 來源                 | 端點             | 狀態                                       |
| -------------------- | ---------------- | ------------------------------------------ |
| KKTIX                | 搜尋 Atom feed   | ✅ 真實 fixture                            |
| CWT                  | `/Acts/tw`       | ✅ 真實 fixture                            |
| FF                   | 官網首頁活動區塊 | ✅ 真實 fixture                            |
| 曼迪 Mighty Media    | Wix blog RSS     | ✅ 真實 fixture（低結構，多數進待審）      |
| 木棉花 Muse          | —                | ⚠️ 官網無法連線，未驗證，pipeline 預設略過 |
| 台北國際動漫節／漫博 | —                | 尚未實作（待 PoC）                         |

---

## 驗證（CI-like）

提交前請在 repo 根目錄執行：

```bash
pnpm check
```

等同依序執行：

```bash
pnpm format:check   # Prettier
pnpm lint           # ESLint（含「純函式套件不得 import db/http」的相依方向檢查）
pnpm typecheck      # 各 workspace tsc --noEmit
pnpm test           # 各 workspace vitest run（@aeh/db 整合測試需要 Docker DB）
```

前台 HTTP 煙霧測試（需先啟動網站並有已發布活動）：

```bash
E2E_BASE_URL=http://localhost:3000 pnpm --filter @aeh/web test:e2e
```

解析／通知套件的測試覆蓋率（normalize / tagger / dedup / notify，門檻 80%）：

```bash
pnpm coverage
```

全新 clone 的最低驗證流程（tech-spec T0 DoD）：

```bash
pnpm i && cp .env.example .env && pnpm db:up && pnpm db:migrate && pnpm db:seed && pnpm typecheck && pnpm test
```

---

## 擷取合規

- 遵守各來源 `robots.txt`，同一 host 請求間隔 ≥ 3 秒，每日擷取 1 次（年度大展每週 1 次）
- 只保存詮釋性資料（名稱、時間、地點、票價區間），不轉載完整文案與主視覺
- 每筆活動皆附官方購票／原始公告連結
- 原始頁面快照僅供除錯，保留 30 天
