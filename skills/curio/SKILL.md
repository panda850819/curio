---
name: curio
description: 操作 Curio 的來源探索、訂閱、Reader、saved quotes、路由、輪詢與投遞驗證。先讀取 agent manifest，再依安全工作流執行；不讀取或輸出 runtime secrets。
---

# Curio agent skill

Curio 是單一使用者的來源追蹤與內容投遞服務。Agent 應把 Curio 當成有狀態的服務操作，不直接讀 SQLite，也不依賴管理 UI 的 HTML selector。

## 連線與安全

- 優先使用 `GET /api/v1/agent/manifest` 發現能力與安全契約。
- HTTP API 的成功回應是 `{ "data": ... }`；錯誤回應是 `{ "error": { "code", "message", "details?" } }`。
- 保留並回報 `X-Request-Id`，錯誤時使用 `error.code` 判斷下一步。
- `cursor` 是 opaque value，只能原樣傳回，不能解碼或修改。
- 不讀取、不要求、不輸出 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET`、`GITHUB_TOKEN`、`X_AUTH_TOKEN`、`X_CT0`、`X_TWID` 或 `X_SESSION`。
- 所有外部 URL 先交給 Curio probe；不要自行繞過 SSRF-safe validation。

API base URL 由執行環境提供，不要把 production URL、Access token 或 service token 寫入 skill。若使用 CLI，優先使用 `--json`。

### JSON CLI

CLI 也使用同一套資源與安全邊界；不把 credentials 放在 command arguments：

```bash
bun run curio probe https://example.com/feed.xml --json
bun run curio follow https://example.com/feed.xml --candidate 1 --json
bun run curio list --json
bun run curio show <subscription-id> --json
bun run curio poll <subscription-id> --json
bun run curio deliveries list --json
bun run curio deliveries retry <delivery-id> --json
```

CLI 的 mutation 若由 agent 代為執行，也要先取得使用者確認；`--json` 輸出解析 `ok`、`data` 與錯誤的 `code`，不要依賴人類格式文字。

## 資料模型

- **Source**：外部網站、feed、YouTube channel、X profile 或 Telegram channel。
- **Subscription**：Curio 對一個 source 的追蹤設定與 cursor。
- **Item**：來源內容正規化後的單一內容。
- **Reader state**：item 的 read/unread 與 favorite 狀態。
- **Saved quote**：經 server 驗證確實存在於 canonical readable text 的 exact excerpt，可附筆記與 detached 狀態。
- **Destination**：投遞目的地，例如 Telegram chat。
- **Route**：把 subscription 連到 destination。
- **Delivery**：一個 item 的投遞狀態與重試紀錄。

作者缺失時保留原始來源，不補假作者。URL、來源名稱與最近主題只引用 Curio 實際回傳的資料；人物連結只有在來源明確提供且使用者確認後才合併，不把相似名稱推測成同一人物。

## 標準工作流

### 建立來源追蹤

1. `GET /api/v1/agent/manifest`
2. 對使用者已明確指定「訂閱這個 URL」的單一來源，先說明即將追蹤的來源、輪詢間隔、回填數量與投遞目的地並取得確認。
3. `POST /api/v1/subscriptions/ensure`，body 使用 `{ "url": "..." }`，可選 `pollIntervalMinutes`、`intervalMinutes` 與 `metadata`。服務會只 probe 一次；單一 candidate 直接建立或回傳 `disposition: "existing"`。
4. 若回傳零 candidate 或多個 candidate，讀取 `error.code` 與 `error.details.candidates`；多 candidate 必須先讓使用者選擇，再使用 `POST /api/v1/subscriptions` 傳入完整 candidate。
5. `POST /api/v1/routes` 只在使用者明確要求投遞且 destination 已確認時呼叫。
6. `POST /api/v1/subscriptions/:id/poll` 只在使用者要求立即抓取或已確認需要驗證時呼叫；它可能建立 items 與 deliveries。
7. 若需要驗證投遞目的地，先取得確認後呼叫 `POST /api/v1/destinations/:id/verify`，只使用 server 回傳的 sanitized metadata。

低階候選探索仍使用 `POST /api/v1/probes`，回傳後檢查 candidates 的 `adapter`、`format`、`title`、`sourceUrl` 與 `sourceKey`。

重複建立相同 subscription 時，接受服務回傳的 `disposition: "existing"`，不要自行建立第二筆。

### Reader 與 saved quote

1. 用 `GET /api/v1/items` 或 `curio_list_items` 找到 item；清單只回傳安全摘要、Reader state 與 opaque cursor。
2. 用 `GET /api/v1/items/:id` 或 `curio_get_item` 讀取 bounded canonical text、來源 metadata、Reader URL、state 與 quotes。回應不包含 raw `contentHtml`。
3. Summary-only item 只有在使用者明確確認後，才能呼叫 `curio_enrich_item(..., confirm: true)`；這會發出 bounded SSRF-safe external request 並保存 snapshot。
4. Agent 可以從實際回傳的 `readableText` 建議 passage，但建議本身不可寫入 quote。只有使用者明確選取或逐字指定真實段落並確認後，才能呼叫 `curio_save_quote(itemId, text, note?, confirm: true)`。
5. Quote text 必須逐字存在於目前 canonical readable text。`quote_text_not_found` 表示文字被改寫、正規化後不相同、屬於別篇 item，或由 agent 生成；不可繞過或改成近似文字重試。`readableTextRedacted: true` 時，不建議保存含 `credentials-redacted` marker 的片段，因為 agent-safe response 已刻意不同於原文。
6. `curio_mark_item_read`、`curio_mark_item_unread`、`curio_favorite_item`、`curio_unfavorite_item`、`curio_remove_quote` 都是確認後 mutation。
7. 用 `curio_list_quotes` 讀取 quote、筆記、來源與 detached 狀態；detached quote 仍保留，不自行刪除或改寫。

### 查詢與驗證

- 來源清單：`GET /api/v1/subscriptions`
- 來源健康：`GET /api/v1/subscriptions/:id`
- 來源內容：`GET /api/v1/subscriptions/:id/items`
- 全域時間軸：`GET /api/v1/items`
- 單篇 Reader：`GET /api/v1/items/:id`
- Saved quotes：`GET /api/v1/quotes?itemId=:id`
- 路由：`GET /api/v1/routes?subscriptionId=:id`
- 投遞：`GET /api/v1/deliveries`
- 服務 liveness：`GET /healthz`；readiness：`GET /readyz`；artifact identity：`GET /version`；既有 clients 仍可使用 `GET /health`
- 投遞目的地驗證：`POST /api/v1/destinations/:id/verify`

清單回應使用 `items` 與 `nextCursor`。有 `nextCursor` 時才繼續分頁，並原樣傳回 cursor。

### Mutation 與確認

- `subscriptions.ensure`、`subscriptions.create`、`subscriptions.update`、`destinations.create`、`destinations.update`、`destinations.verify`、`routes.create`、`routes.update`、`deliveries.retry`：先說明變更並取得明確確認。
- `subscriptions.remove`、`routes.remove`、Reader state/favorite、item enrichment、quote create/remove：一定要明確確認。不要用模糊的「看起來可以」代替確認。
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

它只連到既有 Curio HTTP API，不開新的 host port。將 MCP process 放在 Curio container 或同一個 private network；不要把 `CURIO_AGENT_URL` 指向未受保護的公開服務。先呼叫 `curio_get_manifest`；對明確的 URL 訂閱請優先使用 `curio_subscribe_source`，需要檢查候選或處理多候選時再使用 `curio_probe_source` 與 `curio_create_subscription`。Reader 流程使用 `curio_list_items`、`curio_get_item`、`curio_list_quotes`，確認後才使用 enrich/state/favorite/quote mutation tools；其他流程使用 `curio_create_route`、`curio_poll_source` 與 `curio_verify_destination`。

`curio_remove_source`、`curio_remove_route`、`curio_enrich_item`、所有 Reader state/favorite mutation、`curio_save_quote`、`curio_remove_quote` 與其他標記為需要確認的 tool 必須傳入 `confirm: true`；agent 只能在使用者明確確認後傳入。

## API 參考

完整 endpoint、輸入欄位與 tool 對應以 `GET /api/v1/agent/manifest` 和 `docs/api.md` 為準。若 skill 內容與 manifest 衝突，以服務回傳的 manifest 為準，並回報文件漂移。
