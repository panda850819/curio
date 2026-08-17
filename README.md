# 拾跡 Curio

> 拾起偶然的興趣，留下好奇的軌跡。
>
> Pull what matters into your reading space.

Curio 是一個個人使用、以訂閱為核心的資訊收集與轉發服務。

有時候我們會偶然發現感興趣的網站，想持續追蹤，但看完後往往就忘了。Curio 希望讓使用者貼入一個 URL，探索它可以建立哪些訂閱，持續收集新內容，並透過 Telegram 等管道閱讀，同時留下個人的興趣時間軸。

## 品牌概念

`Curio` 同時代表：

- 因為好奇而收藏的古玩與奇物；
- 偶然遇見、值得留下的網站與內容；
- 長期累積後形成的個人興趣軌跡。

產品形象結合古玩櫃、標本盒、收藏標籤、地圖與探索路徑。視覺可使用黃銅、舊紙、深墨綠與木質棕，呈現收藏與追尋的感覺。

## 核心流程

```text
貼入 URL
  ↓
Probe：辨識來源並列出可建立的訂閱
  ↓
Subscription：選擇並建立訂閱
  ↓
Scheduler / Source Adapter：定期取得增量內容
  ↓
Normalize：轉換成統一的 Canonical Item
  ↓
SQLite：保存內容、游標、標記與投遞狀態
  ↓
Routing / Delivery
  ↓
Telegram，未來可增加 RSS、Web 或其他出口
```

RSS 是可選的輸入與輸出格式，不是內部必經格式。內部以資料庫中的 Canonical Item 作為共同語言。

## Web 管理介面

Curio 內建 same-origin、server-rendered 管理介面，入口是 `/`。可完成 subscription、destination、route 與 delivery failure 的日常操作；mutation 受 `HttpOnly; Secure; SameSite=Lax` session 與 CSRF token 保護。

## Telegram 控制面

設定 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET` 與 `TELEGRAM_ALLOWED_USER_IDS` 後，Curio 會提供 `POST /telegram/webhook`。可選的 `TELEGRAM_ALLOWED_CHAT_IDS` 會再限制 chat。

Webhook 只在獨立指令中設定，正常啟動不會重設：

```bash
TELEGRAM_WEBHOOK_URL=https://example.com/telegram/webhook bun run telegram:webhook
```

Webhook 會接收 `message`、`callback_query`、`channel_post` 與 `edited_channel_post`。Bot 支援貼 URL、`/subscriptions`、`/status` 與 `/cancel`。部署驗證可執行 `deploy/telegram-webhook-smoke.sh`。公開 channel 預設使用 HTML scraper，不需要 Bot 加入來源頻道。

## 產品方向

### 建立訂閱

貼入網站或內容 URL 後，Curio 應列出可能的訂閱方式。例如：

- 網站的 RSS 或 Atom feed；
- GitHub repository 的 releases、commits、issues；
- YouTube channel 的新影片；
- 未來透過 `xbird` 等 CLI 取得的平台內容。

### Telegram 閱讀器

使用者提供 Telegram Bot Token 與目標 Channel，Curio 將訂閱取得的新內容去重、轉譯並推播至頻道。不同頻道可以呈現不同主題或篩選條件。

Telegram public channel source 預設輪詢 `https://t.me/s/<username>` 的公開 HTML，解析 message ID、文字、時間與貼文連結，再建立 canonical item。初次 poll 可設定 backfill 與 initial delivery；後續依 message ID 去重，也會更新頁面中仍可見的編輯內容。HTML 結構變更可能需要調整 scraper。Bot webhook adapter 仍可供需要 forward-only 事件的來源使用。

### 個人時間軸

資料庫保存曾經收集與閱讀的內容，形成個人資訊時間軸，未來可支援：

- seen、saved、archived 等狀態；
- tags 與 collections；
- 來源、主題與時間統計；
- 興趣變化與注意力分布觀測；
- 在可行且尊重隱私的前提下，自動記錄部分瀏覽或收藏行為。

## 架構原則

Curio 採用 Database-first 模組化單體：

```text
Source Adapters
  ↓
Canonical Items
  ↓
SQLite
  ↓
Destination Adapters
```

第一版預計包裝為單一 Docker 服務：

```text
Curio Container
├── HTTP API
├── CLI
├── Scheduler
├── Job Worker
├── Source Adapters
├── Telegram Destination Adapter
└── SQLite client

Persistent Volume
├── curio.db
├── media/
└── backups/
```

程式與資料分離。Docker image 只包含程式；SQLite、媒體與備份存放在 persistent volume。

## 核心模組

### Source Adapter

來源 Adapter 負責兩件事：

1. `probe(input)`：判斷 URL 可以建立哪些訂閱；
2. `poll(subscription)`：根據 cursor 取得增量內容。

第一批可考慮：

- RSS / Atom；
- X profiles via pinned `xbird`；
- GitHub、YouTube 與 Telegram public channel。

### Destination Adapter

第一個輸出為 Telegram Bot API，負責：

- 驗證 Bot Token 與 Channel；
- 格式化訊息並處理長度限制；
- 發送文字、連結與媒體；
- 處理 rate limit 與失敗重試；
- 保存 Telegram `message_id`，供未來更新或刪除使用。

### Database

SQLite 保存：

- subscriptions 與 cursor；
- canonical items；
- tags 與時間軸狀態；
- destinations 與 routes；
- jobs 與 retry 狀態；
- deliveries 與 Telegram message ID。

單人、單台 Linux Server 的第一版不需要 PostgreSQL、Redis、Kafka 或多使用者權限系統。

## 預想 CLI

```bash
curio probe <url>
curio follow <url>
curio subscriptions list
curio destinations add telegram
curio timeline
curio stats
curio status
curio retry <job-id>
curio backup
```

CLI、HTTP API 與未來的 App 應共用同一套核心模組與資料庫，不各自實作抓取、去重或投遞邏輯。

## 第一版範圍

第一版優先完成：

1. Probe URL 並顯示訂閱候選；
2. 建立及管理 subscription；
3. 設定 Telegram destination；
4. 選擇首次 backfill 範圍；
5. 定期取得增量內容；
6. SQLite 去重與持久化 cursor；
7. Telegram 投遞、重試與狀態查詢；
8. Docker 部署與資料備份。

暫緩：

- 完整 Web Reader；
- 單篇稍後閱讀工作流；
- AI 摘要與翻譯；
- 多使用者與權限；
- private Telegram channel；
- 大規模媒體永久保存。

## 技術棧

```text
Runtime       Bun + TypeScript
HTTP          Bun.serve
Database      bun:sqlite
Migration     版本化原生 SQL
Testing       bun:test
Deployment    Docker Compose
```

Curio 使用薄的 repository functions 組織資料存取，不採用 ORM，也不自行建立通用 ORM。

## 本機開發

需求：

- Bun 1.3.5；
- Docker 與 Docker Compose（只有 container 測試需要）。

安裝依賴並執行完整檢查：

```bash
bun install --frozen-lockfile
bun run check
```

啟動開發服務：

```bash
cp .env.example .env
# 本機開發請把 DATABASE_PATH 改為 ./data/curio.db
bun run dev
```

檢查服務：

```bash
curl http://127.0.0.1:3000/health
```

預期回應：

```json
{"status":"ok","service":"curio","uptimeSeconds":0}
```

### URL Probe

探測網站或直接 feed URL：

```bash
bun run curio probe https://example.com
```

提供 automation 使用的固定 JSON：

```bash
bun run curio probe https://example.com --json
```

管理 subscriptions：

```bash
bun run curio follow https://example.com --candidate 1 --interval-minutes 60 --json
bun run curio list --json
bun run curio show <subscription-id-or-source-url> --json
bun run curio pause <subscription-id-or-source-url> --json
bun run curio resume <subscription-id-or-source-url> --json
bun run curio poll <subscription-id-or-source-url> --json
bun run curio remove <subscription-id-or-source-url> --json
```

Probe 只允許 public HTTP(S)，會阻擋 credentials、localhost、private/link-local/reserved IP，以及 redirect 至內網。它驗證 RSS、Atom 或 RDF 的 Content-Type 與 XML root；HTML page 會額外提供 `html` candidate，但不在此階段建立 subscription。

### HTML Source Adapter

`HtmlSourceAdapter` 追蹤沒有 feed 的公開 HTML page。它移除 `script`、`style`、`noscript` 與 volatile attributes，正規化 whitespace、selector 範圍與 URLs，再以 canonical content 的 SHA-256 作 cursor hash。第一次 poll 只建立 baseline，不建立 delivery；只有設定 metadata `notifyOnFirstPoll: true` 才會通知第一次內容。

可選 metadata：

```json
{"selector": "main article", "notifyOnFirstPoll": false}
```

Selector 沒有匹配或抽取內容超過 256 KiB 會記錄 durable poll failure。HTML adapter 不使用 headless browser，也不會把未清理 HTML 直接送到 Telegram。

### RSS Source Adapter

`RssSourceAdapter` 支援 RSS 2.0、Atom 與 RSS 1.0/RDF。它使用 Probe 的安全 transport，保存 ETag／Last-Modified、以 conditional request poll，並將 entries 正規化成 canonical items。

第一次 poll 預設將最新 20 篇保存到 DB，但只替最新 1 篇建立 destination delivery。可在 subscription metadata 分別設定歷史收集與初次通知數量：

```json
{"backfillLimit": 20, "initialDeliveryLimit": 1}
```

兩者合法範圍為 `0–500`，且 `initialDeliveryLimit` 不得大於 `backfillLimit`。後續 polls 會替每篇真正新增的 item 建立 delivery。失敗會記錄 `consecutive_failures`、`last_error`、`last_failed_at` 與 durable failure event；成功或 `304 Not Modified` 會清除 failure state。

Curio service（`bun run start`）會以最多 4 個 concurrent polls 收集到期 subscriptions，同一 subscription 不會在單一程序內重疊。正常 poll interval 預設 60 分鐘，可設為 `5–10080` 分鐘；失敗依 `5m → 15m → 1h → 6h` backoff 重試。

### X Source Adapter

X profile URL 會建立 `x` subscription。Adapter 透過固定 argv 執行 pin 至 commit `5098a67898acf81927422c4be760705c29a0e2d1` 的 `xbird user-tweets`，預設收錄原始 posts 與 quote posts，排除 replies 與 reposts。Tweet ID 是 immutable external ID；首次最多保存 20 則並通知最新 1 則。

`xbird` child process 強制 `XBIRD_DISABLE_LIVE_WRITES=1`，且只取得 allowlisted environment，不會繼承 Telegram token。`X_AUTH_TOKEN` 與 `X_CT0` 是具有完整帳號能力的 session cookies，應使用 dedicated read account，並只存於 runtime secret。

### YouTube Source Adapter

YouTube channel、handle、video URL 與 direct channel Atom feed 都會解析成 channel ID，subscription source key 使用 channel ID，因此 handle 改名不會建立 duplicate subscription。日常 poll 只讀官方 Atom feed；video ID 作為 immutable external ID，沿用 ETag／Last-Modified、backfill 與 initial delivery policy。

### Telegram delivery

同時設定 `TELEGRAM_BOT_TOKEN` 與 `TELEGRAM_CHAT_ID` 後，Curio 會把新 items 與每次 poll failure 送到單一 Telegram channel。既有 items 不補送；尚未通知的 failure events 會補入 delivery queue。

```bash
bun run curio deliveries list --status uncertain --json
bun run curio deliveries retry <delivery-id> --json
```

Telegram 429 依 `retry_after` 重試，network/5xx 最多嘗試 5 次。Timeout 或 malformed success 會標記 `uncertain`，必須人工 retry，避免盲目重送造成 duplicate。

## 環境變數

| 變數 | 預設值 | 用途 |
|---|---|---|
| `HOST` | `127.0.0.1` | HTTP bind address；container 使用 `0.0.0.0` |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/curio.db` | SQLite database path；container 使用 `/data/curio.db` |
| `TELEGRAM_BOT_TOKEN` | 未設定 | Telegram Bot token；必須與 chat ID 同時設定 |
| `TELEGRAM_CHAT_ID` | 未設定 | Telegram channel username 或 numeric chat ID |
| `X_AUTH_TOKEN` | 未設定 | X `auth_token` session cookie；必須與 `X_CT0` 同時設定 |
| `X_CT0` | 未設定 | X CSRF session cookie；必須與 `X_AUTH_TOKEN` 同時設定 |
| `CURIO_NETWORK` | `personal-infra_private` | Compose 使用的既有 external Docker network |
| `MIGRATIONS_PATH` | 專案的 `migrations/` | 只在自訂 migration 位置時設定 |

`.env.example` 只能放可公開的範例值。真實 token、credential 與 private hostname 不得提交。

## Database migration

Migration 使用 `migrations/<version>_<name>.sql` 命名，例如：

```text
migrations/001_initialize.sql
```

手動執行：

```bash
DATABASE_PATH=./data/curio.db bun run migrate
```

Runner 會：

- 初始化 `schema_migrations`；
- 以 transaction 套用尚未執行的 migration；
- 保存 SHA-256 checksum；
- 拒絕已套用後又被修改的 migration；
- migration 失敗時 rollback，且不記錄為成功。

已提交的 migration 不應修改；schema 變更應新增下一個版本。

## Production deployment

`personal-vps` 的 immutable deployment、Telegram smoke、backup、restore 與 rollback 流程見 [`docs/deployment-personal-vps.md`](docs/deployment-personal-vps.md)。Production Compose 位於 [`deploy/compose.production.yaml`](deploy/compose.production.yaml)，不發布 host port。

## Docker

建立 personal-vps 相容的 external network（本機第一次測試才需要）：

```bash
docker network create personal-infra_private
```

準備資料目錄：

```bash
mkdir -p data media backups
```

啟動：

```bash
docker compose up --build -d
```

Curio 不發布 host port，只透過 `personal-infra_private` 接受其他 container 的流量。從同一 network 測試：

```bash
docker run --rm --network personal-infra_private oven/bun:1.3.5-alpine \
  bun -e "console.log(await (await fetch('http://curio:3000/health')).text())"
```

完整的隔離式 container smoke test：

```bash
bun run smoke:docker
```

## personal-vps 部署設計

正式部署目標為 `personal-vps`，預計目錄：

```text
/opt/curio/
├── compose.yaml
├── .env
└── data/
    ├── curio.db
    ├── media/
    └── backups/
```

Curio 接入既有 `personal-infra_private` network，由現有的
`personal-infra-cloudflared-services-1` 轉發：

```text
Cloudflare Tunnel → http://curio:3000
```

不建立額外 Tunnel credential，也不啟動另一個 `cloudflared` container。正式 route、hostname 與 credential 由 `/opt/personal-infra` 管理，不存放在 Curio repository。

## Backup 與還原

備份執行中的 SQLite 前應使用 SQLite backup API 或 `VACUUM INTO`，不要只複製 `.db` 而忽略 WAL：

```bash
sqlite3 data/curio.db "VACUUM INTO 'backups/curio-backup.db'"
```

還原前先停止 Curio，保留目前 database，再將已驗證的 backup 放回 `data/curio.db`。正式 backup automation 不在目前 Infra Sprint 範圍。

## Troubleshooting

### `/data` 無法寫入

Container 以非 root 的 `bun` 使用者執行。若 bind mount 權限不符，先修正 host 目錄 owner；不要改成 privileged container。

### Compose 找不到 network

```text
network personal-infra_private declared as external, but could not be found
```

本機建立 network，或以 `CURIO_NETWORK` 指向已存在的 network。`personal-vps` 已存在 `personal-infra_private`。

### Migration checksum 錯誤

代表已執行的 SQL file 後來被修改。還原原 migration，並以新版本描述 schema 變更，不要直接改 database 中的 checksum。

### 沒有 Cloudflare token

Curio 本身不需要 Cloudflare token。Tunnel 由 `personal-infra` 的既有 `cloudflared-services` 管理。

## CI

GitHub Actions 在 push 與 pull request 執行：

- frozen dependency install；
- TypeScript typecheck；
- Biome lint / format check；
- unit tests；
- Docker image build。

更多開發規則請見 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。
