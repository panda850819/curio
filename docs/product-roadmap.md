# Curio 產品與技術 Roadmap

## 決策摘要

Curio 下一階段先做 **Web 管理介面 + Telegram Bot**，暫不做原生 App。

- Web 管理介面負責新增、編輯、暫停、刪除與檢查訊號源。
- Telegram Bot 負責快速訂閱、查看狀態、接收通知與執行少量操作。
- CLI 保留給維運、自動化與除錯。
- 三個入口共用 HTTP application API、SQLite 與既有 adapter，不重複實作抓取或投遞。
- 第一階段維持 single-user / single-tenant。資料模型預留 `owner_id` 的 migration 路徑，但不先加入登入與權限系統。

## 產品邊界

### 核心物件

1. **Source**：可被辨識與抓取的外部來源，例如 feed、網頁、YouTube channel。
2. **Subscription**：使用者對 Source 的追蹤設定，包含 poll interval、狀態與 cursor。
3. **Item**：各來源正規化後的內容。
4. **Destination**：Telegram chat/channel 等投遞目的地。
5. **Route**：哪個 subscription 投遞到哪個 destination，以及其篩選條件。

目前 `subscriptions`、`items`、`destinations` 與 `deliveries` 已存在。下一階段應補上 `routes`，移除「所有內容只能送到單一環境變數指定 Telegram chat」的限制。

### 入口責任

| 入口 | 主要用途 | 不負責 |
|---|---|---|
| Web | 完整管理訊號源、目的地、投遞狀態 | 自行 poll 或自行去重 |
| Telegram Bot | 貼 URL 訂閱、快速暫停、查看錯誤 | 複雜設定與大量編輯 |
| CLI | 維運、script、自動化、人工 retry | 成為唯一產品介面 |
| HTTP API | 統一 use cases 與資料存取 | 暴露 adapter 內部細節 |

## 建議架構

```text
Web UI ───────────┐
Telegram Bot ─────┼─> Application API ─> Subscription / Route services
CLI ──────────────┘             │
                                ├─> Source adapters ─> Canonical Items
                                ├─> SQLite
                                └─> Delivery worker ─> Telegram Bot API
```

現有 `/health` 擴充成 application API。CLI 逐步改呼叫相同 service layer。Bot webhook 與 Web UI 可放在同一個 Bun service，避免第一版拆成多個 deployable services。

## Source Adapter 合約

每個來源都實作一致能力：

```ts
interface SourceAdapter {
  probe(input: string): Promise<ProbeCandidate[]>;
  poll(subscription: Subscription): Promise<PollResult>;
}
```

所有 adapter 輸出 `CanonicalItem`，並明確定義：

- stable `sourceKey`；
- immutable `externalId`；
- cursor 或 conditional request 策略；
- first poll / backfill 行為；
- rate limit、重試與失敗分類；
- authentication 與 credential 保存方式；
- adapter capability，例如支援全文、媒體、更新或刪除。

## 來源支援順序

### Tier 1：先完成

1. **RSS / Atom / RDF**：已有完整基礎，補 Web 與 Bot 管理流程。
2. **HTML page**：監看單一頁面的內容變更。以 normalized content hash 去重，先支援 CSS selector，避免第一版做通用爬蟲規則引擎。
3. **YouTube channel**：優先使用官方 channel feed。影片 metadata 不足時再用 `yt-dlp` enrich，避免每次 poll 都啟動昂貴程序。

### Tier 2：架構穩定後

4. **GitHub**：releases、commits、issues 各自成為明確 candidate。
5. **Telegram public channel**：先完成 read-only ingestion 的可行性與帳號/session 安全設計，再實作 adapter。
6. **Bilibili**：使用公開頁面或穩定 feed/API，需有 rate limit 與 fixture-based contract tests。

### Tier 3：研究後決定

7. **小紅書**：登入、反爬、API 穩定性與條款風險最高。先做 spike，確認可靠的 read-only 取得方式、credential 隔離與維護成本，再承諾產品支援。

## 分階段交付

### Milestone 1：Management API

目標：讓 CLI、Web 與 Bot 能共用 use cases。

範圍：

- subscription CRUD、pause/resume、manual poll；
- destination CRUD 與連線驗證；
- routes schema 與 CRUD；
- item timeline 與 delivery status 查詢；
- API input validation、錯誤格式與基本 request logging；
- API 預設只 listen private network，不直接公開到 Internet。

驗收：

- 可透過 API 完成 `probe → follow → route → poll → delivery`；
- API 與現有 CLI 對同一筆資料產生一致結果；
- route 能把不同 subscription 投遞到不同 Telegram chat/channel。

### Milestone 2：Telegram Bot control plane

目標：在 Telegram 內完成最常用操作。

最小操作：

- 貼入 URL，Bot 顯示 probe candidates；
- 用 inline keyboard 選擇 candidate 與目的地；
- `/subscriptions` 查看、暫停與恢復；
- `/status` 查看最近失敗；
- delivery 訊息附上來源與管理入口。

安全：

- allowlist Telegram user/chat ID；
- webhook secret 驗證；
- Bot token 只存在 runtime secret；
- callback data 使用短 ID，不放 credential 或完整設定。

驗收：從貼 URL 到收到第一則通知，不需使用 CLI。

### Milestone 3：Web 管理介面

目標：提供完整的訊號源管理位置。

頁面：

1. Dashboard：啟用數、失敗數、待投遞數、最近 items。
2. Add subscription：URL probe、candidate 選擇、backfill 與 interval。
3. Subscriptions：搜尋、filter、pause/resume、manual poll、delete。
4. Subscription detail：health、cursor 摘要、最近 items、poll history。
5. Destinations & Routes：Telegram 驗證與來源分流。
6. Deliveries：failed / uncertain 查詢與人工 retry。

第一版採 responsive Web App，可用手機瀏覽器加入主畫面。確認使用頻率與需求後，再評估 PWA push 或原生 App。

驗收：不使用 CLI 也能管理全部日常設定與失敗處理。

### Milestone 4：HTML + YouTube adapters

目標：證明 adapter framework 能處理 feed 以外來源。

HTML：

- probe 一般 webpage；
- 設定 CSS selector；
- canonicalize HTML 後計算 hash；
- 保存 diff metadata，但第一版通知可只呈現摘要與 URL。

YouTube：

- 辨識 channel、handle 與 video URL；
- 解析成 stable channel ID；
- 使用 channel feed 增量抓取；
- 將 video ID 作為 external ID。

驗收：fixtures、poll idempotency、首次 backfill、增量通知與錯誤 backoff 都通過 adapter contract tests。

### Milestone 5：擴充來源與可靠性

- GitHub adapter；
- Telegram public channel feasibility + adapter；
- Bilibili adapter；
- credential store abstraction；
- per-adapter metrics、rate limiting 與 health；
- backup automation 與 restore rehearsal。

小紅書另開研究 milestone，不與上述交付綁定。

## 建議的下一個 Sprint

只做 Milestone 1，避免同時開 Web、Bot 與新 adapter：

1. 定義 application service 與 JSON API contract。
2. 新增 `routes` migration 與 repository。
3. 實作 subscription、destination、route、timeline API。
4. 讓既有 Telegram worker 按 route 建立 deliveries。
5. 加入 end-to-end API test，覆蓋 `probe → follow → poll → delivery`。

完成後，Telegram Bot 與 Web 管理介面會變成薄 client，後續加入來源也不需要重做產品入口。

## 暫緩項目

- 原生 iOS / Android App；
- multi-user signup、billing、RBAC；
- AI 摘要、分類與推薦；
- 通用 headless-browser scraping 平台；
- 大量媒體永久保存；
- 小紅書 production adapter。
