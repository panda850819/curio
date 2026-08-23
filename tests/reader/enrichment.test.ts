import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migrate } from "../../src/db/migrations.ts";
import { ItemRepository, SubscriptionRepository } from "../../src/db/repositories.ts";
import type { CanonicalItem } from "../../src/domain/types.ts";
import { SafeHttpClient } from "../../src/probe/http-client.ts";
import type { HttpResponse, ProbeHttpClient } from "../../src/probe/types.ts";
import { ItemEnrichmentRepository } from "../../src/reader/repository.ts";
import { DefaultReaderService } from "../../src/reader/service.ts";

const migrationsPath = resolve(import.meta.dir, "../../migrations");

class FixtureClient implements ProbeHttpClient {
  readonly calls: string[] = [];

  constructor(readonly responses: HttpResponse[]) {}

  async get(
    url: string,
    maximumBytes: (contentType: string | null) => number,
  ): Promise<HttpResponse> {
    this.calls.push(url);
    const response = this.responses.shift();
    if (!response) throw new Error("Missing HTTP fixture");
    maximumBytes(response.headers.get("content-type"));
    return response;
  }
}

function response(body: string, options: { url?: string; status?: number; type?: string } = {}) {
  return {
    url: options.url ?? "https://example.com/final-article",
    status: options.status ?? 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? (options.type ?? "text/html; charset=utf-8") : null,
    },
    body: new TextEncoder().encode(body),
  } satisfies HttpResponse;
}

function harness(client: ProbeHttpClient, item: CanonicalItem) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  const subscriptions = new SubscriptionRepository(
    database,
    () => "subscription",
    () => 1_000,
  );
  const items = new ItemRepository(database, () => "item");
  const enrichments = new ItemEnrichmentRepository(database, () => 2_000);
  subscriptions.create({
    adapter: "rss",
    sourceKey: "https://example.com/feed.xml",
    sourceUrl: "https://example.com/feed.xml",
    pollIntervalMinutes: 60,
    nextPollAt: 1_000,
  });
  items.recordPoll({
    subscriptionId: "subscription",
    items: [item],
    cursor: { etag: "feed-etag" },
    polledAt: 1_000,
    nextPollAt: 61_000,
  });
  return {
    database,
    items,
    enrichments,
    service: new DefaultReaderService(items, enrichments, client),
  };
}

const summaryItem: CanonicalItem = {
  externalId: "summary",
  url: "https://example.com/article?utm_source=feed",
  title: "Summary item",
  summary: "Only a summary is available.",
};

const firstArticle = `<!doctype html><html><head><title>Example</title></head><body>
  <header>Site header</header><nav>Many navigation links</nav>
  <main><article><h1>完整文章</h1><p>這是一段足夠長的文章正文，用來證明 Curio 可以抽出主要內容，而不是保存導覽列與頁尾。</p>
  <blockquote>真正值得留下的引文。</blockquote><script>secret()</script>
  <p><a href="/related">安全延伸閱讀</a><a href="javascript:secret()">危險連結</a></p></article></main>
  <aside>Related cards</aside><footer>Site footer</footer></body></html>`;

const changedArticle = `<main><article><h1>更新後文章</h1><p>來源頁面更新後，明確重新擷取會保存新的靜態快照，同時維持原始 RSS item 不變。</p></article></main>`;

describe("Reader enrichment", () => {
  test("extracts, sanitizes, caches, audits, and explicitly refreshes an article", async () => {
    const client = new FixtureClient([
      response(firstArticle),
      response(changedArticle),
      response("not html", { type: "application/pdf" }),
    ]);
    const context = harness(client, summaryItem);

    const first = await context.service.enrich("item");
    expect(first.disposition).toBe("enriched");
    expect(first.enrichment).toMatchObject({
      itemId: "item",
      sourceUrl: "https://example.com/article?utm_source=feed",
      fetchedUrl: "https://example.com/final-article",
      fetchedAt: 2_000,
      lastAttemptedAt: 2_000,
      lastError: null,
    });
    expect(first.enrichment.contentHtml).toContain("<h1>完整文章</h1>");
    expect(first.enrichment.contentHtml).toContain("<blockquote>真正值得留下的引文。</blockquote>");
    expect(first.enrichment.contentHtml).toContain(
      'href="https://example.com/related" target="_blank" rel="noopener noreferrer"',
    );
    expect(first.enrichment.contentHtml).not.toContain("Site header");
    expect(first.enrichment.contentHtml).not.toContain("script");
    expect(first.enrichment.contentHtml).not.toContain("javascript:");
    expect(context.items.findById("item")).toMatchObject({
      summary: "Only a summary is available.",
      contentText: null,
      contentHtml: null,
    });

    const cached = await context.service.enrich("item");
    expect(cached.disposition).toBe("cached");
    expect(client.calls).toHaveLength(1);

    const refreshed = await context.service.enrich("item", { force: true });
    expect(refreshed.disposition).toBe("refreshed");
    expect(refreshed.enrichment.contentHtml).toContain("更新後文章");
    expect(refreshed.enrichment.contentHtml).not.toContain("完整文章");
    expect(client.calls).toHaveLength(2);

    await expect(context.service.enrich("item", { force: true })).rejects.toMatchObject({
      code: "enrichment_content_type_unsupported",
    });
    const retained = context.service.get("item");
    expect(retained.contentHtml).toContain("更新後文章");
    expect(retained.enrichment?.lastError).toBe("來源不是可擷取的 HTML 文章");
    expect(client.calls).toHaveLength(3);

    context.database.close();
  });

  test("records an item-local failure without changing feed content or cursor state", async () => {
    const client = new FixtureClient([
      response("not html", { type: "application/pdf", status: 200 }),
    ]);
    const context = harness(client, summaryItem);
    const before = context.items.findById("item");

    await expect(context.service.enrich("item")).rejects.toMatchObject({
      code: "enrichment_content_type_unsupported",
    });
    expect(context.items.findById("item")).toEqual(before);
    expect(context.enrichments.findByItemId("item")).toMatchObject({
      contentHtml: null,
      contentText: null,
      fetchedAt: null,
      lastError: "來源不是可擷取的 HTML 文章",
    });
    const subscription = context.database
      .query<{ cursor_json: string; next_poll_at: number }, []>(
        "SELECT cursor_json, next_poll_at FROM subscriptions",
      )
      .get();
    expect(subscription).toEqual({ cursor_json: '{"etag":"feed-etag"}', next_poll_at: 61_000 });
    expect(
      context.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM deliveries")
        .get(),
    ).toEqual({ count: 0 });

    context.database.close();
  });

  test("classifies remote status, empty extraction, and malformed static HTML", async () => {
    const statusContext = harness(
      new FixtureClient([response("unavailable", { status: 503, type: "text/plain" })]),
      { ...summaryItem, externalId: "status" },
    );
    await expect(statusContext.service.enrich("item")).rejects.toMatchObject({
      code: "enrichment_http_status",
    });
    expect(statusContext.enrichments.findByItemId("item")?.lastError).toContain("HTTP 503");
    statusContext.database.close();

    const emptyContext = harness(
      new FixtureClient([response("<html><body><nav>Only navigation</nav></body></html>")]),
      { ...summaryItem, externalId: "empty" },
    );
    await expect(emptyContext.service.enrich("item")).rejects.toMatchObject({
      code: "enrichment_content_empty",
    });
    emptyContext.database.close();

    const malformedContext = harness(
      new FixtureClient([
        response(
          "<main><article><h1>Malformed but readable<p>這篇靜態文章缺少多個 closing tags，但 HTML parser 仍應安全抽出足夠長的正文內容。",
        ),
      ]),
      { ...summaryItem, externalId: "malformed" },
    );
    const malformed = await malformedContext.service.enrich("item");
    expect(malformed.enrichment.contentHtml).toContain("Malformed but readable");
    expect(malformed.enrichment.contentHtml).toContain("HTML parser");
    malformedContext.database.close();
  });

  test("rejects existing full content before fetching", async () => {
    const client = new FixtureClient([response(firstArticle)]);
    const context = harness(client, {
      ...summaryItem,
      externalId: "full",
      contentText: "The feed already contains a full article body.",
    });

    await expect(context.service.enrich("item")).rejects.toMatchObject({
      code: "item_content_already_available",
    });
    expect(client.calls).toEqual([]);
    expect(context.enrichments.findByItemId("item")).toBeNull();

    context.database.close();
  });

  test("uses the shared SSRF policy and does not persist URL credentials", async () => {
    const privateClient = new SafeHttpClient({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const privateContext = harness(privateClient, {
      ...summaryItem,
      externalId: "private",
      url: "http://private.example/article",
    });
    await expect(privateContext.service.enrich("item")).rejects.toMatchObject({
      code: "blocked_address",
    });
    expect(privateContext.enrichments.findByItemId("item")?.lastError).toContain(
      "Address is not public unicast",
    );
    privateContext.database.close();

    const credentialClient = new SafeHttpClient({ resolve: async () => [] });
    const credentialContext = harness(credentialClient, {
      ...summaryItem,
      externalId: "credentials",
      url: "https://name:password@example.com/article",
    });
    await expect(credentialContext.service.enrich("item")).rejects.toMatchObject({
      code: "url_credentials",
    });
    const failure = credentialContext.enrichments.findByItemId("item");
    expect(failure?.sourceUrl).toBe("https://example.com/article");
    expect(JSON.stringify(failure)).not.toContain("password");
    credentialContext.database.close();
  });
});
