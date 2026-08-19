# Curio Management API

`/api/v1` 是 single-user 管理 API。服務預設只 bind `127.0.0.1`；production 只放在 private Docker network。第一版不提供登入，但 HTTP handler 支援注入 single-user `authGuard`。

除 `/health` 外，成功回應使用：

```json
{ "data": {} }
```

錯誤回應使用：

```json
{
  "error": {
    "code": "invalid_field",
    "message": "pollIntervalMinutes must be an integer"
  }
}
```

每個回應都包含 `X-Request-Id`。可提供符合 `[A-Za-z0-9._-]{1,128}` 的 request ID，否則由服務產生。request log 只保存 path，不保存 query、body、token 或 URL credentials。

## Telegram webhook

### `POST /telegram/webhook`

Bot 控制面使用 `X-Telegram-Bot-Api-Secret-Token` 驗證。只接受 `application/json`、`POST`，request body 上限為 `256 KiB`。未通過 secret 回 `401`；無效 JSON 回 `400`；成功接收回 `{ "ok": true }`。

Webhook 由 `bun run telegram:webhook` 獨立設定，正常 startup 不會呼叫 `setWebhook`。`TELEGRAM_ALLOWED_USER_IDS` 必填，`TELEGRAM_ALLOWED_CHAT_IDS` 可選。conversation state 與 processed update IDs 存在 SQLite。

## Shared Email Inbox

設定 `EMAIL_INBOUND_ADDRESS` 與 `EMAIL_INBOUND_WEBHOOK_SECRET` 後，Curio 會建立單一 `Email Inbox` subscription。管理介面會顯示這個地址，電子報可以直接寄到這裡，也可以由其他信箱轉寄。

### `GET /api/v1/email/inbox`

回傳共用收件地址與對應 subscription。Email inbox 未設定時回 `404`。

```json
{
  "data": {
    "address": "reader@inbox.example.com",
    "subscription": {}
  }
}
```

### `POST /email/inbound`

只接受 `application/json` 與 `X-Curio-Email-Secret`。request body 上限為 `1 MiB`。郵件服務需將原始信件轉成下列 normalized payload：

```json
{
  "to": "reader@inbox.example.com",
  "messageId": "<message-1@example.com>",
  "from": "Newsletter <news@example.com>",
  "subject": "Weekly note",
  "date": "2026-01-02T03:04:05Z",
  "text": "A short note",
  "html": "<p>A short note</p>",
  "url": "https://example.com/article",
  "headers": { "List-ID": "news.example.com" }
}
```

`to` 也可以寫成 `recipient`。`subject` 或 `text`／`html` 至少要提供一項。Curio 會將信件轉成 canonical item，保留純文字內容，不自動下載附件。相同訊息重送時回 `{ "ok": true, "status": "duplicate" }`，不會新增第二筆 item。

## 分頁

List endpoint 接受：

- `limit`：`1–100`，預設 `50`。
- `cursor`：前一頁回傳的 opaque cursor。

回應格式：

```json
{
  "data": {
    "items": [],
    "nextCursor": null
  }
}
```

Cursor 是服務內部的 keyset cursor。不要自行解碼或修改。資料排序固定，不接受任意 SQL sort/filter。

## Agent capability manifest

`GET /api/v1/agent/manifest` 回傳 agent 可讀的操作清單與安全契約。回應包含 `manifestVersion`、transport envelope、pagination、操作的 HTTP method／path／request fields／side effects，以及需要確認的 mutation 與 destructive operations。Manifest 不包含任何 runtime credentials，並沿用既有 auth guard 與 `X-Request-Id`。

Agent 應先讀取 manifest，再依照 `probe → candidate confirmation → subscription → route → poll → verify` 工作流操作。`cursor` 是 opaque value，不可自行解碼；`subscriptions.remove` 與 `routes.remove` 必須取得明確確認。

### MCP stdio toolkit

可用 `CURIO_AGENT_URL=http://127.0.0.1:3000 bun run agent:mcp` 啟動 stdio MCP transport。它只呼叫既有 HTTP API，不開新的 host port；應在 Curio container 或同一個 private network 執行。MCP client 會先呼叫 `curio_get_manifest`，再使用 source、route 與 delivery tools。需要確認的工具必須傳入 `confirm: true`。

## Probe

### `POST /api/v1/probes`

Request：

```json
{ "url": "https://example.com/feed.xml" }
```

Server 會套用既有 SSRF-safe probe policy。Candidate adapter 包含 `rss`、`html`、`x`、`youtube`、`telegram` 與 `telegram_html`；YouTube channel／handle／video URL 會先解析成 stable channel ID。`https://t.me/<public-username>` 會產生 `telegram_html` candidate，輪詢 `https://t.me/s/<public-username>`，不需要 Bot 加入來源頻道。

## Subscriptions

### `GET /api/v1/subscriptions`

列出 active subscriptions。

### `POST /api/v1/subscriptions`

Request：

```json
{
  "candidate": {
    "adapter": "rss",
    "format": "rss",
    "sourceUrl": "https://example.com/feed.xml",
    "sourceKey": "https://example.com/feed.xml",
    "title": "Example",
    "discoveredVia": "direct"
  },
  "pollIntervalMinutes": 60,
  "metadata": {
    "backfillLimit": 20,
    "initialDeliveryLimit": 1,
    "selector": "main article",
    "notifyOnFirstPoll": false
  }
}
```

Server 會重新 probe 並驗證 candidate identity，不能只相信 client 提供的 `sourceUrl`、`sourceKey` 或 adapter。`telegram_html` subscription 是 scheduler polling；`telegram` subscription 則是 webhook event-driven。建立成功回 `201`：

```json
{ "data": { "subscription": {}, "disposition": "created" } }
```

相同 subscription 會回 `disposition: "existing"`，不重複建立資料。RSS/Atom 第一次成功 poll 會在 cursor 保存 feed baseline；`backfillLimit` 之外的初始歷史只會被視為已見內容，不會在後續完整 feed response 中產生 delivery。沒有 baseline 的既有 RSS/Atom subscription 會先靜默建立 baseline。

### `GET /api/v1/subscriptions/:id`

取得 subscription health、cursor、poll timing 與 metadata。

### `PATCH /api/v1/subscriptions/:id`

只接受 `title`、`enabled`、`pollIntervalMinutes`、已定義的 `metadata` fields。HTML candidate 可使用 `selector` 與 `notifyOnFirstPoll`；feed candidate 會忽略這兩個欄位：

```json
{
  "title": "Updated title",
  "enabled": true,
  "pollIntervalMinutes": 120,
  "metadata": { "backfillLimit": 20, "initialDeliveryLimit": 1 }
}
```

### `DELETE /api/v1/subscriptions/:id`

執行 soft delete。

### `POST /api/v1/subscriptions/:id/poll`

立即執行一次與 scheduler 相同的 poll path。

### `GET /api/v1/subscriptions/:id/items`

取得指定 subscription 的 timeline。

## Items

### `GET /api/v1/items`

全域 timeline。可用 `subscriptionId` 篩選。排序固定為 `publishedAt ?? discoveredAt` descending。

## Destinations

### `GET /api/v1/destinations`

列出 destinations。回應 config 只包含非 secret 設定，例如 Telegram `chatId`。

### `POST /api/v1/destinations`

Request：

```json
{
  "destinationKey": "telegram-reading",
  "kind": "telegram",
  "config": { "chatId": "@example" }
}
```

Bot token 只能由 runtime secret 提供，不接受、不保存於 config。Telegram delivery 對同一 destination 依 item `publishedAt` 由舊到新序列化；前一筆尚未完成或需要 retry 時，後續 delivery 會等待。

### `PATCH /api/v1/destinations/:id`

只接受 `config` 與 `enabled`。

### `POST /api/v1/destinations/:id/verify`

Server 使用 runtime Bot token 呼叫 Telegram `getChat`，回傳 sanitized chat metadata，不回傳 token。

## Routes

### `GET /api/v1/routes`

列出 routes。可用 `subscriptionId` 篩選。

### `POST /api/v1/routes`

Request：

```json
{
  "subscriptionId": "subscription-id",
  "destinationId": "destination-id",
  "enabled": true,
  "config": {}
}
```

同一 `(subscriptionId, destinationId)` 只能有一筆 route。

### `GET /api/v1/routes/:id`

取得 route。此 read endpoint 與 CRUD 共用同一個 typed service。

### `PATCH /api/v1/routes/:id`

只接受 `enabled`、`config`。

### `DELETE /api/v1/routes/:id`

刪除 route。沒有 enabled route 或 destination disabled 時，不會建立新的 item/failure delivery。

## Deliveries

### `GET /api/v1/deliveries`

可用 `status` 篩選下列固定 enum：

`pending`、`processing`、`retry_scheduled`、`delivered`、`uncertain`、`permanent_failure`

### `POST /api/v1/deliveries/:id/retry`

只允許 `uncertain` 與 `permanent_failure`。其他狀態回 `409`；不存在回 `404`。
