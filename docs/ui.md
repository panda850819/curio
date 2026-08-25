# Curio Web UI

Curio 使用 Bun-native server-rendered HTML，沒有新增 frontend framework、bundle 或公開 port。UI 與管理 API 共用同一個 origin，頁面只保留一段用於 form loading feedback 的 minimal JavaScript。

## Visual direction

`PULL / graphite-and-signal`：舊紙色背景、石墨文字、signal orange 與暖黃焦點。品牌 mark 使用開放的 capture aperture 與被拉入的 signal fragment；管理頁維持 cardless sections、清楚的資料列與可收合的 delivery attempts。Reader 延伸成更安靜的 paper-and-ink 閱讀面：依日期分組、細分隔線、約 65ch 正文欄，桌面與手機共用同一組內容階層。文章頁固定以標題為第一層，作者、來源、發布或收集時間為分離的 metadata；正文依 feed、HTML、GitHub Markdown、social、YouTube 與 email profile 正規化到同一個安全 block model。HTML monitor 的 readable snapshot 優先選擇頁面中最完整的 `<main>`／article region，避免把 header、nav 與 footer chrome 混進正文；圖片沿用 paper-and-ink 方向，不加卡片框，維持原始比例並限制在 65ch 閱讀欄內。

## Security

- UI session cookie 使用 `HttpOnly; Secure; SameSite=Lax`。
- 所有 mutation 使用 server-side session CSRF token。
- Bot token、webhook secret、X credentials 不會傳入 view model。
- 外部標題、URL、summary、error 都經 HTML escaping。Reader 不直接 render stored `contentHtml`，而是先用 source-aware presentation layer 轉成 heading、paragraph、list item、blockquote、code、image 與 safe HTTP(S) link 等 typed blocks；GitHub 與有多個結構訊號的 Markdown 走 bounded parser，單一 incidental bullet 不會觸發格式猜測，unsupported syntax 保持 escaped text。Script、style、iframe、form、embed、event handlers、unsafe URL schemes 與未知 wrapper 都不會進入輸出。圖片只接受無帳密的 HTTPS URL，拒絕 localhost／local suffix 與 private literal IP，不採用 stored `srcset` 或 event attributes，明示的 1–2px tracking image 會被移除；輸出固定使用 lazy loading、async decoding 與 no-referrer，CSP 只額外允許 HTTPS image。圖片仍由瀏覽器直接向來源主機請求，來源會看到 Reader client IP；若要隱藏 IP，後續需獨立設計有 SSRF、大小、MIME 與 cache 邊界的 image proxy。
- Summary-only item 的「取得全文」使用既有 SSRF-safe client，逐次驗證 redirect、限制大小且只接受靜態 HTML。Enrichment 存在獨立 snapshot，不改寫原始 feed item、cursor 或 delivery。
- Saved quote form 的原文欄位由目前文章 selection 填入且 readonly；server 仍會對 canonical readable text 做 exact 驗證。Quote、note 與 detached 狀態都經 escaping 後才呈現。
- Remove、route remove、subscription remove 在瀏覽器端要求 confirmation，server 仍會重新驗證 resource。

## Routes

- `/`：dashboard health、recent items、delivery health。
- `/reader`、`/reader/items/:id`：依今天／昨天／更早瀏覽已收集內容，並在 Curio 內閱讀安全的文章 block；只有摘要時保留原文出口與明確的全文擷取操作。成功 snapshot 會顯示 provenance，重新開啟不 refetch；使用者可明確要求更新快照。時間軸與文章頁都能切換 read/favorite；文章頁 selection 可保存 exact quote。
- `/reader/quotes`：列出全部 saved quotes、筆記、來源文章與 detached 狀態。
- `/subscriptions`、`/subscriptions/new`、`/subscriptions/:id`：probe、follow、pause/resume、manual poll、remove、items、routes。
- `/destinations`：Telegram destination create、verify、enable/disable。
- `/deliveries`：status filter、attempt detail、uncertain/permanent retry。

`/subscriptions` 依來源家族分組，將 YouTube 獨立呈現，RSS 與 Atom 統一歸入網站來源，並顯示 feed 名稱、來源角色、格式與最近主題；RSS／Atom 的 channel title 會在成功輪詢後補入 subscription 名稱。共用 Email Inbox 會在 `/subscriptions/new` 顯示收件地址與管理入口。Telegram HTML subscription 顯示為定期輪詢；Bot API 與 Email subscription 則是事件驅動。Production 只需讓既有 reverse proxy 將 same-origin traffic 轉到 Curio；UI 不另開 port。瀏覽器 smoke 可使用 `deploy/ui-smoke.sh`。

人物整合目前採保守策略：來源可在未來手動連到同一個人物，匿名或無法確認作者的來源維持獨立，不用同名或 handle 自動合併。
