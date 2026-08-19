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
