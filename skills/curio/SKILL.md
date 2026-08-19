---
name: curio
description: 操作 Curio 的來源探索、訂閱、路由、輪詢與投遞驗證。先讀取 agent manifest，再依安全工作流執行；不讀取或輸出 runtime secrets。
---

# Curio agent skill

Curio 是單一使用者的來源追蹤與內容投遞服務。Agent 應把 Curio 當成有狀態的服務操作，不直接讀 SQLite，也不依賴管理 UI 的 HTML selector。

## 連線與安全

- 優先使用 `GET /api/v1/agent/manifest` 發現能力與安全契約。
- HTTP API 的成功回應是 `{ "data": ... }`；錯誤回應是 `{ "error": { "code", "message", "details?" } }`。
- 保留並回報 `X-Request-Id`，錯誤時使用 `error.code` 判斷下一步。
- `cursor` 是 opaque value，只能原樣傳回，不能解碼或修改。
- 不讀取、不要求、不輸出 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET`、`X_AUTH_TOKEN`、`X_CT0`、`X_TWID` 或 `X_SESSION`。
- 所有外部 URL 先交給 Curio probe；不要自行繞過 SSRF-safe validation。

API base URL 由執行環境提供，不要把 production URL、Access token 或 service token 寫入 skill。若使用 CLI，優先使用 `--json`。

## 資料模型

- **Source**：外部網站、feed、YouTube channel、X profile 或 Telegram channel。
- **Subscription**：Curio 對一個 source 的追蹤設定與 cursor。
- **Item**：來源內容正規化後的單一內容。
- **Destination**：投遞目的地，例如 Telegram chat。
- **Route**：把 subscription 連到 destination。
- **Delivery**：一個 item 的投遞狀態與重試紀錄。

作者缺失時保留原始來源，不補假作者。不同管道只有在使用者明確確認後才能連到同一人物；未確認或匿名來源維持獨立。

## 標準工作流

### 建立來源追蹤

1. `GET /api/v1/agent/manifest`
2. `POST /api/v1/probes`，body 使用 `{ "url": "..." }`。
3. 檢查 candidates 的 `adapter`、`format`、`title`、`sourceUrl` 與 `sourceKey`。
4. 向使用者說明即將追蹤的來源、輪詢間隔、回填數量與投遞目的地；建立訂閱前取得確認。
5. `POST /api/v1/subscriptions`，傳入 probe 回傳的完整 candidate。
6. `POST /api/v1/routes` 連接已確認的 destination。
7. `POST /api/v1/subscriptions/:id/poll`，確認最新內容、inserted items 與 delivery 狀態。

重複建立相同 subscription 時，接受服務回傳的 `disposition: "existing"`，不要自行建立第二筆。

### 查詢與驗證

- 來源清單：`GET /api/v1/subscriptions`
- 來源健康：`GET /api/v1/subscriptions/:id`
- 來源內容：`GET /api/v1/subscriptions/:id/items`
- 全域時間軸：`GET /api/v1/items`
- 路由：`GET /api/v1/routes?subscriptionId=:id`
- 投遞：`GET /api/v1/deliveries`
- 服務健康：`GET /health`

清單回應使用 `items` 與 `nextCursor`。有 `nextCursor` 時才繼續分頁，並原樣傳回 cursor。

### Mutation 與確認

- `subscriptions.create`、`subscriptions.update`、`destinations.create`、`destinations.update`、`routes.create`、`routes.update`、`deliveries.retry`：先說明變更並取得明確確認。
- `subscriptions.remove` 與 `routes.remove`：一定要明確確認。不要用模糊的「看起來可以」代替確認。
- `subscriptions.poll` 會產生外部請求，並可能建立 delivery；來源已確認後可以執行。
- 任何 mutation 失敗時先讀 `error.code`，不要盲目重試。只有服務明確表示可重試時才重試。

## 回報格式

完成操作後，用短摘要回報：

- `status`：created、existing、fetched、delivered 或錯誤狀態
- `resource id`：subscription、route 或 delivery ID
- `source`：名稱與 URL
- `latest topic`：服務實際取得的最近主題；沒有就標示未取得
- `schedule`：輪詢間隔與下次輪詢時間
- `delivery`：目的地與狀態
- `warnings`：完整保留服務回傳的可操作警告
- `next action`：只有確實需要下一步時才提出

不要把原始 credentials、完整 runtime environment、SQLite path 或未經使用者要求的大量 item 內容放進回報。

## Agent toolkit／MCP

Repository 提供 stdio MCP transport：

```bash
CURIO_AGENT_URL=http://127.0.0.1:3000 bun run agent:mcp
```

它只連到既有 Curio HTTP API，不開新的 host port。將 MCP process 放在 Curio container 或同一個 private network；不要把 `CURIO_AGENT_URL` 指向未受保護的公開服務。先呼叫 `curio_get_manifest`，再使用 `curio_probe_source`、`curio_create_subscription`、`curio_create_route` 與 `curio_poll_source` 等 tools。

`curio_remove_source`、`curio_remove_route` 與其他標記為需要確認的 tool 必須傳入 `confirm: true`；agent 只能在使用者明確確認後傳入。

## API 參考

完整 endpoint、輸入欄位與 tool 對應以 `GET /api/v1/agent/manifest` 和 `docs/api.md` 為準。若 skill 內容與 manifest 衝突，以服務回傳的 manifest 為準，並回報文件漂移。
