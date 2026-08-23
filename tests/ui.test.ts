import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../src/app/create-app.ts";
import { migrate } from "../src/db/migrations.ts";
import { createHttpHandler } from "../src/http.ts";
import type { ProbeHttpClient } from "../src/probe/types.ts";
import { createUiHandler } from "../src/ui/handler.ts";

const migrationsPath = resolve(import.meta.dir, "../migrations");
const feedUrl = "https://example.com/curio-feed.xml";

function harness(
  probeClient: ProbeHttpClient = {
    get: async (url) => ({
      url,
      status: 200,
      headers: { get: (name: string) => (name === "content-type" ? "application/rss+xml" : null) },
      body: new TextEncoder().encode(
        "<rss version='2.0'><channel><title>Curio test feed</title><item><guid>one</guid><title>First finding</title><link>https://example.com/items/one</link><description>Plain preview</description></item></channel></rss>",
      ),
    }),
  },
  withEmail = false,
) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  const app = createApp({
    database,
    migrationsPath,
    probeClient,
    now: () => 1_000,
    email: withEmail
      ? { address: "reader@inbox.example.com", webhookSecret: "email-secret" }
      : undefined,
  });
  const ui = createUiHandler(app, { now: () => 1_000 });
  const http = createHttpHandler({ services: app.services, ui, log: () => undefined });
  return { app, database, ui, http };
}

async function getSession(
  ui: ReturnType<typeof createUiHandler>,
): Promise<{ cookie: string; csrf: string }> {
  const response = await ui(new Request("http://curio.test/destinations"));
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";", 1)[0] ?? "";
  const html = await response.text();
  const csrf = /name="csrf" value="([^"]+)"/u.exec(html)?.[1] ?? "";
  expect(cookie).toContain("curio_session=");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Lax");
  expect(csrf).not.toBe("");
  return { cookie, csrf };
}

function formRequest(path: string, fields: Record<string, string>, cookie: string): Request {
  const body = new URLSearchParams(fields);
  return new Request(`http://curio.test${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("Curio Web UI", () => {
  test("renders dashboard, custom 404, and keeps secrets out of HTML", async () => {
    const context = harness();
    const dashboard = await context.http(new Request("http://curio.test/"));
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain("Curio");
    expect(dashboardHtml).toContain("把值得讀的東西拉進來");
    expect(dashboardHtml).toContain("PULL / READING COLLECTOR");
    expect(dashboardHtml).toContain('class="curio-mark"');
    expect(dashboardHtml).toContain("theme-color");
    expect(dashboardHtml).not.toContain("你的好奇心索引");
    expect(dashboardHtml).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(dashboardHtml).not.toContain("X_AUTH_TOKEN");

    const missing = await context.http(new Request("http://curio.test/does-not-exist"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("找不到這個頁面");

    context.app.close();
    context.database.close();
  });

  test("renders an empty Reader with a path to add the first source", async () => {
    const context = harness();
    const response = await context.http(new Request("http://curio.test/reader"));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('aria-current="page" class="active">閱讀</a>');
    expect(html).toContain("閱讀清單還是空的");
    expect(html).toContain('href="/subscriptions/new"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');

    context.app.close();
    context.database.close();
  });

  test("renders a safe date-grouped Reader timeline and structured article", async () => {
    const context = harness({
      get: async (url) => ({
        url,
        status: 200,
        headers: {
          get: (name: string) => (name === "content-type" ? "application/rss+xml" : null),
        },
        body: new TextEncoder().encode(`
          <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
            <channel><title>閱讀測試</title><item><guid>reader-one</guid>
              <title>一篇很長但值得在手機上安靜讀完的文章</title>
              <link>https://example.com/posts/reader-one</link>
              <description>兩行摘要會留在閱讀清單，正文則在文章頁呈現。</description>
              <content:encoded><![CDATA[
                <article onclick="steal()">
                  <h2>正文標題</h2>
                  <p>第一段有 <strong>重點</strong>、<a href="/related?q=one">安全連結</a> 和 <a href="javascript:steal()">危險連結</a>。</p>
                  <ul><li>清單第一點</li><li>清單第二點</li></ul>
                  <blockquote><p>值得保留的來源引文。</p></blockquote>
                  <pre><code>const curio = "reader";</code></pre>
                  <script>steal()</script><iframe src="https://tracker.example"></iframe>
                  <form><input name="secret"></form>
                </article>
              ]]></content:encoded>
            </item></channel>
          </rss>`),
      }),
    });
    const followed = context.app.services.subscriptions.follow({
      candidate: {
        adapter: "rss",
        format: "rss",
        sourceKey: feedUrl,
        sourceUrl: feedUrl,
        title: "閱讀測試",
        discoveredVia: "direct",
      },
      intervalMinutes: 60,
    });
    await context.app.services.subscriptions.poll(followed.subscription.id);
    const item = context.app.services.subscriptions.listItemsPage(10).items[0];
    expect(item).toBeDefined();

    const timeline = await context.ui(new Request("http://curio.test/reader"));
    expect(timeline.status).toBe(200);
    const timelineHtml = await timeline.text();
    expect(timelineHtml).toContain("今天");
    expect(timelineHtml).toContain("閱讀測試");
    expect(timelineHtml).toContain("一篇很長但值得在手機上安靜讀完的文章");
    expect(timelineHtml).toContain(`/reader/items/${item?.id}`);

    const article = await context.ui(
      new Request(`http://curio.test/reader/items/${item?.id ?? ""}`),
    );
    expect(article.status).toBe(200);
    const articleHtml = await article.text();
    const readerBody = /<div class="reader-body">([\s\S]*?)<\/div>/u.exec(articleHtml)?.[1] ?? "";
    expect(articleHtml).toContain('href="/reader">← 返回閱讀</a>');
    expect(articleHtml).toContain("正文標題");
    expect(readerBody).toContain("<h2>正文標題</h2>");
    expect(readerBody).toContain("<ul><li>清單第一點</li><li>清單第二點</li></ul>");
    expect(readerBody).toContain("<blockquote>值得保留的來源引文。</blockquote>");
    expect(readerBody).toContain("<pre><code>const curio = &quot;reader&quot;;</code></pre>");
    expect(readerBody).toContain(
      'href="https://example.com/related?q=one" target="_blank" rel="noopener noreferrer"',
    );
    expect(readerBody).not.toContain("onclick");
    expect(readerBody).not.toContain("javascript:");
    expect(readerBody).not.toContain("<script");
    expect(readerBody).not.toContain("<iframe");
    expect(readerBody).not.toContain("<form");
    expect(readerBody).not.toContain("<input");

    context.app.services.subscriptions.remove(followed.subscription.id);
    const retained = await context.ui(
      new Request(`http://curio.test/reader/items/${item?.id ?? ""}`),
    );
    expect(retained.status).toBe(200);
    expect(await retained.text()).toContain("已移除的來源");

    const missing = await context.ui(new Request("http://curio.test/reader/items/missing"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("返回閱讀");

    context.app.close();
    context.database.close();
  });

  test("keeps plain-text and summary-only feed items readable", async () => {
    const atomUrl = "https://example.com/feed.atom";
    const context = harness({
      get: async (url) => ({
        url,
        status: 200,
        headers: {
          get: (name: string) => (name === "content-type" ? "application/atom+xml" : null),
        },
        body: new TextEncoder().encode(`
          <feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Reader</title>
            <entry><id>summary</id><title>只有摘要</title><updated>1970-01-01T00:00:01Z</updated><link href="https://example.com/summary"/><summary>來源只提供這段摘要。</summary></entry>
            <entry><id>text</id><title>純文字正文</title><updated>1970-01-01T00:00:00Z</updated><link href="https://example.com/text"/><content type="text">第一段純文字。\n\n第二段純文字。</content></entry>
          </feed>`),
      }),
    });
    const followed = context.app.services.subscriptions.follow({
      candidate: {
        adapter: "rss",
        format: "atom",
        sourceKey: atomUrl,
        sourceUrl: atomUrl,
        title: "Atom Reader",
        discoveredVia: "direct",
      },
      intervalMinutes: 60,
    });
    await context.app.services.subscriptions.poll(followed.subscription.id);
    const items = context.app.services.subscriptions.listItemsPage(10).items;
    const summary = items.find((item) => item.title === "只有摘要");
    const plain = items.find((item) => item.title === "純文字正文");
    expect(summary).toBeDefined();
    expect(plain).toBeDefined();

    const summaryResponse = await context.ui(
      new Request(`http://curio.test/reader/items/${summary?.id ?? ""}`),
    );
    const summaryHtml = await summaryResponse.text();
    expect(summaryHtml).toContain("目前只有摘要");
    expect(summaryHtml).toContain("來源只提供這段摘要。");
    expect(summaryHtml).toContain("開啟原文");

    const plainResponse = await context.ui(
      new Request(`http://curio.test/reader/items/${plain?.id ?? ""}`),
    );
    const plainHtml = await plainResponse.text();
    expect(plainHtml).toContain("第一段純文字。");
    expect(plainHtml).toContain("第二段純文字。");
    expect(plainHtml).not.toContain("目前只有摘要");

    context.app.close();
    context.database.close();
  });

  test("enriches a summary-only Reader item with cached safe article content", async () => {
    const articleUrl = "https://example.com/summary-article";
    let articleRequests = 0;
    const context = harness({
      get: async (url, maximumBytes) => {
        if (url === feedUrl) {
          return {
            url,
            status: 200,
            headers: {
              get: (name: string) => (name === "content-type" ? "application/atom+xml" : null),
            },
            body: new TextEncoder().encode(`
              <feed xmlns="http://www.w3.org/2005/Atom"><title>Enrichment feed</title>
                <entry><id>enrich-me</id><title>需要全文</title><updated>1970-01-01T00:00:01Z</updated>
                <link href="${articleUrl}"/><summary>目前只有摘要。</summary></entry>
              </feed>`),
          };
        }
        articleRequests += 1;
        const body =
          articleRequests === 1
            ? `<html><body><nav>導覽</nav><main><article><h1>擷取後全文</h1><p>這是從原始文章頁安全擷取並保存的完整正文，長度足以通過文章內容門檻。</p><blockquote>保存真正的文章內容。</blockquote><script>secret()</script></article></main></body></html>`
            : `<main><article><h1>更新後全文</h1><p>明確重新擷取後，Curio 更新保存的全文快照，但不改寫原始 RSS item。</p></article></main>`;
        maximumBytes("text/html");
        return {
          url: articleUrl,
          status: 200,
          headers: { get: (name: string) => (name === "content-type" ? "text/html" : null) },
          body: new TextEncoder().encode(body),
        };
      },
    });
    const followed = context.app.services.subscriptions.follow({
      candidate: {
        adapter: "rss",
        format: "atom",
        sourceKey: feedUrl,
        sourceUrl: feedUrl,
        title: "Enrichment feed",
        discoveredVia: "direct",
      },
      intervalMinutes: 60,
    });
    await context.app.services.subscriptions.poll(followed.subscription.id);
    const item = context.app.services.subscriptions.listItemsPage(10).items[0];
    const session = await getSession(context.ui);

    const before = await context.ui(
      new Request(`http://curio.test/reader/items/${item?.id}`, {
        headers: { cookie: session.cookie },
      }),
    );
    const beforeHtml = await before.text();
    expect(beforeHtml).toContain("目前只有摘要");
    expect(beforeHtml).toContain("取得全文");

    const enriched = await context.ui(
      formRequest(`/reader/items/${item?.id}/enrich`, { csrf: session.csrf }, session.cookie),
    );
    expect(enriched.status).toBe(303);
    expect(enriched.headers.get("location")).toContain("notice=item_enriched");

    const after = await context.ui(
      new Request(`http://curio.test/reader/items/${item?.id}`, {
        headers: { cookie: session.cookie },
      }),
    );
    const afterHtml = await after.text();
    const readerBody = /<div class="reader-body">([\s\S]*?)<\/div>/u.exec(afterHtml)?.[1] ?? "";
    expect(afterHtml).toContain("已保存全文快照");
    expect(afterHtml).toContain("重新擷取全文");
    expect(readerBody).toContain("擷取後全文");
    expect(readerBody).toContain("<blockquote>保存真正的文章內容。</blockquote>");
    expect(readerBody).not.toContain("script");
    expect(articleRequests).toBe(1);

    const reopened = await context.ui(
      new Request(`http://curio.test/reader/items/${item?.id}`, {
        headers: { cookie: session.cookie },
      }),
    );
    expect(reopened.status).toBe(200);
    expect(articleRequests).toBe(1);

    const refreshed = await context.ui(
      formRequest(
        `/reader/items/${item?.id}/enrich`,
        { csrf: session.csrf, force: "true" },
        session.cookie,
      ),
    );
    expect(refreshed.status).toBe(303);
    expect(refreshed.headers.get("location")).toContain("notice=item_refreshed");
    expect(articleRequests).toBe(2);
    expect(context.app.services.reader.get(item?.id ?? "").contentHtml).toContain("更新後全文");
    expect(context.app.services.subscriptions.getItem(item?.id ?? "")).toMatchObject({
      summary: "目前只有摘要。",
      contentHtml: null,
      contentText: null,
    });

    context.app.close();
    context.database.close();
  });

  test("keeps the summary visible when Reader enrichment fails", async () => {
    const articleUrl = "https://example.com/not-html";
    const context = harness({
      get: async (url, maximumBytes) => {
        if (url === feedUrl) {
          return {
            url,
            status: 200,
            headers: {
              get: (name: string) => (name === "content-type" ? "application/atom+xml" : null),
            },
            body: new TextEncoder().encode(`
              <feed xmlns="http://www.w3.org/2005/Atom"><title>Failure feed</title>
                <entry><id>fail</id><title>保留摘要</title><updated>1970-01-01T00:00:01Z</updated>
                <link href="${articleUrl}"/><summary>擷取失敗時仍可閱讀的摘要。</summary></entry>
              </feed>`),
          };
        }
        maximumBytes("application/pdf");
        return {
          url: articleUrl,
          status: 200,
          headers: {
            get: (name: string) => (name === "content-type" ? "application/pdf" : null),
          },
          body: new TextEncoder().encode("not html"),
        };
      },
    });
    const followed = context.app.services.subscriptions.follow({
      candidate: {
        adapter: "rss",
        format: "atom",
        sourceKey: feedUrl,
        sourceUrl: feedUrl,
        title: "Failure feed",
        discoveredVia: "direct",
      },
      intervalMinutes: 60,
    });
    await context.app.services.subscriptions.poll(followed.subscription.id);
    const item = context.app.services.subscriptions.listItemsPage(10).items[0];
    const session = await getSession(context.ui);
    const failure = await context.ui(
      formRequest(`/reader/items/${item?.id}/enrich`, { csrf: session.csrf }, session.cookie),
    );
    expect(failure.status).toBe(400);
    const html = await failure.text();
    expect(html).toContain("全文擷取沒有完成");
    expect(html).toContain("來源不是可擷取的 HTML 文章");
    expect(html).toContain("擷取失敗時仍可閱讀的摘要。");
    expect(html).toContain("重試全文擷取");

    context.app.close();
    context.database.close();
  });

  test("shows the shared email inbox on the add subscription screen", async () => {
    const context = harness(undefined, true);
    const response = await context.ui(new Request("http://curio.test/subscriptions/new"));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("共用電子報收件匣");
    expect(html).toContain("reader@inbox.example.com");
    expect(html).toContain("管理 Email Inbox");

    context.app.close();
    context.database.close();
  });

  test("requires CSRF and completes destination plus subscription mutations", async () => {
    const context = harness();
    const session = await getSession(context.ui);
    const rejected = await context.ui(
      formRequest(
        "/destinations/create",
        { destinationKey: "no-csrf", chatId: "@room" },
        session.cookie,
      ),
    );
    expect(rejected.status).toBe(403);
    expect(context.app.services.destinations.listPage(20).items).toHaveLength(0);

    const destinationResponse = await context.ui(
      formRequest(
        "/destinations/create",
        { csrf: session.csrf, destinationKey: "reading-room", chatId: "@room" },
        session.cookie,
      ),
    );
    expect(destinationResponse.status).toBe(303);
    const destination = context.app.services.destinations.listPage(20).items[0];
    expect(destination?.destinationKey).toBe("reading-room");

    const probeResponse = await context.ui(
      formRequest("/subscriptions/probe", { csrf: session.csrf, url: feedUrl }, session.cookie),
    );
    expect(probeResponse.status).toBe(200);
    const probeHtml = await probeResponse.text();
    expect(probeHtml).toContain("選擇來源候選");
    expect(probeHtml).not.toContain("<script src=");

    const probe = await context.app.services.probe.probe(feedUrl);
    const candidate = probe.candidates[0];
    expect(candidate).toBeDefined();
    const createResponse = await context.ui(
      formRequest(
        "/subscriptions/create",
        {
          csrf: session.csrf,
          candidate: JSON.stringify(candidate),
          destinationId: destination?.id ?? "",
          intervalMinutes: "60",
          backfillLimit: "20",
        },
        session.cookie,
      ),
    );
    expect(createResponse.status).toBe(303);
    const subscriptions = context.app.services.subscriptions.list();
    expect(subscriptions).toHaveLength(1);
    expect(context.app.services.routes.listPage(20, subscriptions[0]?.id).items).toHaveLength(1);

    const pause = await context.ui(
      formRequest(
        `/subscriptions/${subscriptions[0]?.id}/pause`,
        { csrf: session.csrf },
        session.cookie,
      ),
    );
    expect(pause.status).toBe(303);
    expect(context.app.services.subscriptions.list()[0]?.enabled).toBe(false);
    const resume = await context.ui(
      formRequest(
        `/subscriptions/${subscriptions[0]?.id}/resume`,
        { csrf: session.csrf },
        session.cookie,
      ),
    );
    expect(resume.status).toBe(303);
    expect(context.app.services.subscriptions.list()[0]?.enabled).toBe(true);

    context.app.close();
    context.database.close();
  });

  test("preselects redirected HTML candidates and accepts modern adapters", async () => {
    const context = harness({
      get: async () => ({
        url: "https://example.com/final",
        status: 200,
        headers: { get: (name: string) => (name === "content-type" ? "text/html" : null) },
        body: new TextEncoder().encode(
          "<html><head><title>Example page</title></head><body><main>Current finding</main></body></html>",
        ),
      }),
    });
    const session = await getSession(context.ui);
    const destinationResponse = await context.ui(
      formRequest(
        "/destinations/create",
        { csrf: session.csrf, destinationKey: "reading-room", chatId: "@room" },
        session.cookie,
      ),
    );
    expect(destinationResponse.status).toBe(303);
    const destination = context.app.services.destinations.listPage(20).items[0];

    const probeResponse = await context.ui(
      formRequest(
        "/subscriptions/probe",
        { csrf: session.csrf, url: "https://example.com/start" },
        session.cookie,
      ),
    );
    expect(probeResponse.status).toBe(200);
    const probeHtml = await probeResponse.text();
    expect((probeHtml.match(/name="candidate"[^>]* checked/gu) ?? []).length).toBe(1);

    const probe = await context.app.services.probe.probe("https://example.com/start");
    const candidate = probe.candidates[0];
    expect(candidate?.adapter).toBe("html");
    const createResponse = await context.ui(
      formRequest(
        "/subscriptions/create",
        {
          csrf: session.csrf,
          candidate: JSON.stringify(candidate),
          destinationId: destination?.id ?? "",
          intervalMinutes: "60",
          backfillLimit: "20",
        },
        session.cookie,
      ),
    );
    expect(createResponse.status).toBe(303);
    expect(context.app.services.subscriptions.list()[0]?.adapter).toBe("html");

    context.app.close();
    context.database.close();
  });

  test("serves the detail, destination, and delivery management screens", async () => {
    const context = harness();
    const session = await getSession(context.ui);
    const destination = context.app.services.destinations.create({
      destinationKey: "reading-room",
      kind: "telegram",
      config: { chatId: "@room" },
    });
    const probe = await context.app.services.probe.probe(feedUrl);
    const result = context.app.services.subscriptions.follow({
      candidate: {
        ...(probe.candidates[0] as NonNullable<(typeof probe.candidates)[0]>),
        title: "<script>alert('x')</script>",
      },
      intervalMinutes: 60,
    });
    context.app.services.routes.create({
      subscriptionId: result.subscription.id,
      destinationId: destination.id,
    });
    await context.app.services.subscriptions.poll(result.subscription.id);

    const detail = await context.ui(
      new Request(`http://curio.test/subscriptions/${result.subscription.id}`, {
        headers: { cookie: session.cookie },
      }),
    );
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain("來源健康度");
    expect(detailHtml).toContain("來源分類");
    expect(detailHtml).toContain("Feed 格式");
    expect(detailHtml).toContain("路由");
    expect(detailHtml).toContain("First finding");
    expect(detailHtml).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(detailHtml).not.toContain("<script>alert('x')</script>");

    const subscriptions = await context.ui(
      new Request("http://curio.test/subscriptions", { headers: { cookie: session.cookie } }),
    );
    const subscriptionsHtml = await subscriptions.text();
    expect(subscriptionsHtml).toContain("網站");
    expect(subscriptionsHtml).toContain("最近主題");
    expect(subscriptionsHtml).toContain("First finding");

    const destinations = await context.ui(
      new Request("http://curio.test/destinations", { headers: { cookie: session.cookie } }),
    );
    expect(await destinations.text()).toContain("reading-room");
    const deliveries = await context.ui(
      new Request("http://curio.test/deliveries", { headers: { cookie: session.cookie } }),
    );
    expect(await deliveries.text()).toContain("投遞");

    context.app.close();
    context.database.close();
  });

  test("groups YouTube feeds separately and combines website feed formats", async () => {
    const context = harness();
    context.app.services.subscriptions.follow({
      candidate: {
        adapter: "rss",
        format: "atom",
        sourceKey: "UCcurio123",
        sourceUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCcurio123",
        title: "商談・不廢話 | Real Biz Chat",
        discoveredVia: "direct",
      },
      intervalMinutes: 60,
    });
    context.app.services.subscriptions.follow({
      candidate: {
        adapter: "rss",
        format: "rss",
        sourceKey: "https://example.com/feed.xml",
        sourceUrl: "https://example.com/feed.xml",
        title: "Example RSS",
        discoveredVia: "direct",
      },
      intervalMinutes: 60,
    });
    context.app.services.subscriptions.follow({
      candidate: {
        adapter: "rss",
        format: "atom",
        sourceKey: "https://example.org/atom.xml",
        sourceUrl: "https://example.org/atom.xml",
        title: "Example Atom",
        discoveredVia: "direct",
      },
      intervalMinutes: 60,
    });

    const response = await context.ui(new Request("http://curio.test/subscriptions"));
    const html = await response.text();
    expect(html).toContain('<span class="source-family">YouTube</span>');
    expect(html).toContain('<span class="source-format">YouTube</span>');
    expect(html).toContain('<span class="source-family">網站</span>');
    expect(html).not.toContain("網站 Feed");
    expect(html).not.toContain("網站 Atom");
    expect(html).toContain('<span class="source-format">RSS</span>');
    expect(html).toContain('<span class="source-format">Atom</span>');

    context.app.close();
    context.database.close();
  });
});
