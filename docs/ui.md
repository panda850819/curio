# Curio Web UI

Curio 使用 Bun-native server-rendered HTML，沒有新增 frontend framework、bundle 或公開 port。UI 與管理 API 共用同一個 origin，頁面只保留一段用於 form loading feedback 的 minimal JavaScript。

## Visual direction

`Field journal / brass-and-ink`：舊紙色背景、深墨綠文字、黃銅提示與鐵鏽色錯誤。頁面採 cardless sections、清楚的資料列與可收合的 delivery attempts，桌面與手機共用同一組資訊階層。

## Security

- UI session cookie 使用 `HttpOnly; Secure; SameSite=Lax`。
- 所有 mutation 使用 server-side session CSRF token。
- Bot token、webhook secret、X credentials 不會傳入 view model。
- 外部標題、URL、summary、error 都經 HTML escaping；不 render `contentHtml`。
- Remove、route remove、subscription remove 在瀏覽器端要求 confirmation，server 仍會重新驗證 resource。

## Routes

- `/`：dashboard health、recent items、delivery health。
- `/subscriptions`、`/subscriptions/new`、`/subscriptions/:id`：probe、follow、pause/resume、manual poll、remove、items、routes。
- `/destinations`：Telegram destination create、verify、enable/disable。
- `/deliveries`：status filter、attempt detail、uncertain/permanent retry。

`/subscriptions` 依來源家族分組，顯示 feed 名稱、來源角色、RSS／Atom／X 格式與最近主題；RSS／Atom 的 channel title 會在成功輪詢後補入 subscription 名稱。Telegram HTML subscription 顯示為定期輪詢；Bot API subscription 才是事件驅動。Production 只需讓既有 reverse proxy 將 same-origin traffic 轉到 Curio；UI 不另開 port。瀏覽器 smoke 可使用 `deploy/ui-smoke.sh`。

人物整合目前採保守策略：來源可在未來手動連到同一個人物，匿名或無法確認作者的來源維持獨立，不用同名或 handle 自動合併。
