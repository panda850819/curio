# Curio Email Worker

這個 Worker 將 Cloudflare Email Routing 收到的 `reader@pdzeng.com` 信件解析成 normalized JSON，再送到 Curio 的 `POST /email/inbound`。

## 部署前設定

1. 確認 `pdzeng.com` 已加入同一個 Cloudflare account，且 Email Routing 已啟用。
2. 將 `wrangler.jsonc` 的 `CURIO_INBOUND_URL` 改成 Curio 對外的 HTTPS webhook URL，例如：

   ```jsonc
   "CURIO_INBOUND_URL": "https://curio.pdzeng.com/email/inbound"
   ```

3. 在 Curio runtime secret 設定相同的值：

   ```env
   EMAIL_INBOUND_ADDRESS=reader@pdzeng.com
   EMAIL_INBOUND_WEBHOOK_SECRET=<same-secret>
   ```

4. 目前 `curio.pdzeng.com` 受 Cloudflare Access 保護。建立一個只允許這個 webhook 的 Access Service Token，並將兩個值設成 Worker secrets：

   ```bash
   npx wrangler secret put CURIO_ACCESS_CLIENT_ID
   npx wrangler secret put CURIO_ACCESS_CLIENT_SECRET
   ```

   Access policy 必須使用 `Service Auth`，不能要求互動式登入。若你選擇讓 `/email/inbound` 成為 public path，可以省略這兩個 secrets，但仍保留 `X-Curio-Email-Secret`。

5. 安裝並檢查 Worker：

   ```bash
   npm install
   npm run typecheck
   ```

6. 登入 Cloudflare 並部署：

   ```bash
   npx wrangler login
   npm run deploy
   npx wrangler secret put CURIO_INBOUND_SECRET
   ```

`wrangler.jsonc` 的 `addresses` 會讓 Wrangler 建立 `reader@pdzeng.com` 對應這個 Worker 的 Email Routing rule。部署前確認目前沒有其他規則佔用同一個地址。Cloudflare Worker 會只將必要的郵件欄位送往 Curio，不會記錄信件內容。

## 行為與限制

- Worker 只轉送寄件者、收件者、主旨、日期、`Message-ID`、`List-ID` 與純文字內容。
- 有純文字內容時不傳 HTML；沒有純文字時才傳截斷後的 HTML，Curio 會再轉成純文字。
- 超過 2 MiB 的原始信件會被拒收，避免附件或惡意郵件耗盡 Worker 記憶體。
- Curio 回傳 `5xx` 或網路錯誤時，Worker 會拋出錯誤，讓 Cloudflare 保留重試機會。
- Curio 回傳 `400` 或 `413` 時，Worker 會永久拒收該信件。
- Worker 不會把信件內容寫入 log。

本機 dry run：

```bash
npx wrangler deploy --dry-run --config wrangler.jsonc
```
