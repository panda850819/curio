# Source feasibility research

研究範圍：GitHub、Public Telegram channel、Bilibili、小紅書。研究只使用公開 endpoint、官方文件與 synthetic fixtures；沒有提交 cookies、tokens、personal identifiers 或 private channel data。研究不修改 production ingestion path。

## Decision matrix

| Source | Decision | Maintenance | Risk | Bounded next step |
| --- | --- | ---: | ---: | --- |
| GitHub REST API | **GO，首選** | Low | Low–medium | Public releases adapter；commits/issues 另做 endpoint spike |
| GitHub Atom | **Conditional GO** | Medium | Medium | 只支援 capability probe 成功的 releases 與指定 branch commits |
| Telegram public HTML | **GO，bounded scraper** | Medium | Medium | 輪詢 `t.me/s/<username>`，解析可見貼文 |
| Telegram Bot API | **GO，forward-only** | Medium | Medium | Bot 加入 channel 後接收 `channel_post` / `edited_channel_post` |
| Bilibili public space | **NO-GO** | High | High | 等官方、授權且穩定的 public read contract |
| 小紅書 public explore | **NO-GO** | Very high | Very high | 只在 documented authorized API 或 approved export 出現後重評估 |

## Evidence

### GitHub

官方 rate-limit 文件：

- <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- <https://docs.github.com/rest/releases/releases#list-releases>

文件指出，public data 可用 unauthenticated REST requests，primary limit 為 60 requests/hour；authenticated requests 通常為 5,000 requests/hour。超過限制可能收到 `403` 或 `429`，應依 `x-ratelimit-reset`、`retry-after` 與 response headers 退避。

公開 command evidence：

```text
GET https://api.github.com/repos/cli/cli/releases?per_page=1
HTTP 200 application/json
ETag: W/"..."
Link: <...page=2>; rel="next", <...page=200>; rel="last"
x-ratelimit-limit: 60
x-ratelimit-remaining: 59
```

Atom capability checks 使用 public `cli/cli`：

```text
GET https://github.com/cli/cli/releases.atom
HTTP 200 application/atom+xml; ETag present
GET https://github.com/cli/cli/commits/trunk.atom
HTTP 200 application/atom+xml; ETag present
GET https://github.com/cli/cli/issues.atom
HTTP 406 text/html
```

較早對 `bun-sh/bun` 的 feed path 得到 `404`，只能代表該 repository/path 當時不可用，不能推論 GitHub Atom 全面失效。

**Recommendation**

REST 是正式首選。REST releases 使用 repository `owner/repo` 作 source key、release numeric `id` 作 immutable item ID，保存 `node_id`、`tag_name`、`html_url`、published/updated timestamps。使用 `ETag`、`Link` pagination 與 reset-aware backoff。Token 為 optional secret，不能進 log、DB payload 或 child process environment。

REST commits/issues 先各自驗證 endpoint、ordering、pagination、conditional request、issue/PR filtering 與 rate-limit recovery。不要把 commits、issues、releases 混成一個 cursor。

Atom 只做窄範圍 optional adapter：

- `releases.atom`；
- `commits/<branch>.atom`；
- 必須先檢查 status 與 `application/atom+xml`；`404`、`406` 或其他 Content-Type 標記 unsupported；
- 不支援 `issues.atom`，也不做 HTML fallback。

### Public Telegram channel

官方 Bot API：<https://core.telegram.org/bots/api>

官方文件確認：

- `Update` 有 `channel_post` 與 `edited_channel_post`；
- webhook 收到非 `2xx` 會重試；
- `getUpdates` 與 outgoing webhook 互斥；
- `setWebhook.secret_token` 可讓服務驗證 `X-Telegram-Bot-Api-Secret-Token`；
- Bot API 沒有任意 public channel history/backfill endpoint；
- channel permissions 包含 `can_post_messages`、`can_edit_messages`、`can_delete_messages`，實際需求要在 setup 時最小化驗證。

Synthetic contract fixture：[`docs/fixtures/source-feasibility/telegram-channel-update.json`](fixtures/source-feasibility/telegram-channel-update.json)。

**Recommendation：GO，bounded scraper**

Curio 已實作 public HTML scraper。它輪詢 `https://t.me/s/<username>`，使用 `data-post` 的 message ID 作 immutable item key，解析可見文字、時間與貼文 URL。初次 poll 受 backfill／initial delivery 限制，後續依 message ID 增量並更新仍可見的編輯內容。HTML 結構、可見窗口、刪除事件與歷史完整性不承諾。Bot token 不需要放入此 source path。

Bot API 仍保留作 forward-only event collector：Bot 必須先被加入 target channel，並透過 `telegram:webhook` 設定 webhook；`edited_channel_post` 會 upsert 原 item，不重複建立 delivery。

### Bilibili

公開 command evidence，未使用登入資料：

```text
GET https://api.bilibili.com/x/space/acc/info?mid=2
{"code":-799,"message":"請求過於頻繁..."}

GET https://api.bilibili.com/x/space/wbi/arc/search?mid=2&pn=1&ps=1
{"code":-352,"message":"風控校驗失敗", ...}
```

Synthetic response fixture：[`docs/fixtures/source-feasibility/bilibili-space-response.json`](fixtures/source-feasibility/bilibili-space-response.json)。它只描述未來若有穩定 contract 時的欄位形狀，不是實際取得的 private data。

**Recommendation：NO-GO**

目前無法承諾可預測的 availability、quota、stable cursor 或低維運成本。不得用 cookies、browser fingerprint、CAPTCHA bypass、proxy rotation 或 account session 把風險藏進 adapter。只有官方、授權、穩定的 public read API，並提供 IDs、pagination、quota 與 terms，才重新評估。

### 小紅書

公開 `GET https://www.xiaohongshu.com/explore` 回傳約 1 MB app shell，檢查結果包含 login/risk markers；未找到 stable public read API。未使用登入資料或簽名 workaround。

**Recommendation：NO-GO**

不支援 undocumented endpoints、browser cookies、device fingerprint 或風控繞過。重新評估條件是 documented authorized API 或明確核准的 export/import workflow，且能提供 stable IDs、cursor、rate limits、terms 與 maintenance boundary。

## Bounded follow-up issue drafts

以下是研究後可建立的窄範圍 issues：

1. [#31 Add GitHub REST releases source adapter](https://github.com/panda850819/curio/issues/31)：public repositories、release ID、ETag、Link pagination、`403/429` reset-aware backoff、optional isolated token；不含 private repos、寫入操作、HTML fallback。
2. [#32 Add bounded GitHub Atom releases and branch commits adapter](https://github.com/panda850819/curio/issues/32)：只接受 capability probe 成功的 Atom paths；不含 issues、generic discovery 或 REST fallback。
3. Telegram channel source adapter 已完成：`channel_post`、`edited_channel_post`、webhook、durable `update_id` dedup，明確無 history/backfill。
4. **Research GitHub commits/issues REST contracts**：只做 endpoint-specific evidence；通過 stable IDs、pagination、incremental semantics 與 rate-limit tests 後再拆 implementation issues。

目前不建立 Bilibili 或小紅書 production adapter issue。
