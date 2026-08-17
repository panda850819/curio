import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migrate } from "../../../src/db/migrations.ts";
import { ItemRepository, SubscriptionRepository } from "../../../src/db/repositories.ts";
import { DeliveryRepository } from "../../../src/delivery/repository.ts";
import type { HttpHeaders, HttpResponse, ProbeHttpClient } from "../../../src/probe/types.ts";
import { RssSourceAdapter } from "../../../src/sources/rss/adapter.ts";

const migrationsPath = resolve(import.meta.dir, "../../../migrations");

class Headers implements HttpHeaders {
  constructor(private readonly values: Record<string, string>) {}
  get(name: string): string | null {
    return this.values[name.toLowerCase()] ?? null;
  }
}

interface RecordedRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
}

class FakeClient implements ProbeHttpClient {
  readonly requests: RecordedRequest[] = [];

  constructor(private readonly responses: Array<HttpResponse | Error>) {}

  async get(
    url: string,
    _maximumBytes: (contentType: string | null) => number,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<HttpResponse> {
    this.requests.push({ url, headers });
    const response = this.responses.shift();
    if (!response) throw new Error("No fake response configured");
    if (response instanceof Error) throw response;
    return response;
  }
}

function response(
  body: string,
  options: { status?: number; etag?: string; lastModified?: string } = {},
): HttpResponse {
  const values: Record<string, string> = { "content-type": "application/rss+xml" };
  if (options.etag) values.etag = options.etag;
  if (options.lastModified) values["last-modified"] = options.lastModified;
  return {
    url: "https://example.com/feed.xml",
    status: options.status ?? 200,
    headers: new Headers(values),
    body: new TextEncoder().encode(body),
  };
}

function rss(entries: Array<{ id: string; title: string; date?: string }>): string {
  return `<rss version="2.0"><channel><title>Feed</title><link>https://example.com</link><description>Feed</description>${entries
    .map(
      (entry) =>
        `<item><guid>${entry.id}</guid><title>${entry.title}</title>${
          entry.date ? `<pubDate>${entry.date}</pubDate>` : ""
        }</item>`,
    )
    .join("")}</channel></rss>`;
}

function setup(metadata: Record<string, number> = {}) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  let subscriptionId = 0;
  let itemId = 0;
  let now = 1_000;
  const subscriptions = new SubscriptionRepository(
    database,
    () => `subscription-${++subscriptionId}`,
    () => now,
  );
  const items = new ItemRepository(database, () => `item-${++itemId}`);
  const subscription = subscriptions.create({
    adapter: "rss",
    sourceKey: "example-feed",
    sourceUrl: "https://example.com/feed.xml",
    metadata,
  });
  return {
    database,
    subscriptions,
    items,
    subscription,
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
  };
}

describe("RssSourceAdapter", () => {
  test("applies latest-first initial backfill and sends conditional headers", async () => {
    const context = setup();
    new DeliveryRepository(
      context.database,
      () => "destination-1",
      () => 500,
    ).syncTelegramDestination("@channel");
    const entries = Array.from({ length: 25 }, (_, index) => ({
      id: `entry-${index}`,
      title: `Entry ${index}`,
      date: new Date(Date.UTC(2026, 0, index + 1)).toUTCString(),
    }));
    const client = new FakeClient([
      response(rss(entries), {
        etag: '"version-1"',
        lastModified: "Fri, 15 Aug 2026 10:00:00 GMT",
      }),
      response("<this-body-must-not-be-parsed", { status: 304 }),
    ]);
    const adapter = new RssSourceAdapter(client, context.subscriptions, context.items, context.now);

    const first = await adapter.poll(context.subscription.id);
    expect(first).toMatchObject({ status: "fetched", insertedItems: 20, duplicateItems: 0 });
    expect(context.subscriptions.findById(context.subscription.id)?.title).toBe("Feed");
    const storedIds = context.items
      .listBySubscription(context.subscription.id, 100)
      .map((item) => item.externalId);
    expect(storedIds).toHaveLength(20);
    expect(storedIds).toContain("entry-24");
    expect(storedIds).not.toContain("entry-0");
    expect(
      context.database
        .query<{ external_id: string }, []>(
          `SELECT i.external_id FROM deliveries d
           JOIN items i ON i.id = d.item_id ORDER BY d.created_at`,
        )
        .all()
        .map((row) => row.external_id),
    ).toEqual(["entry-24"]);

    context.subscriptions.recordFailure(context.subscription.id, "temporary", 1_500);
    context.setNow(2_000);
    const second = await adapter.poll(context.subscription.id);

    expect(second.status).toBe("not_modified");
    expect(client.requests[1]?.headers).toEqual({
      "If-None-Match": '"version-1"',
      "If-Modified-Since": "Fri, 15 Aug 2026 10:00:00 GMT",
    });
    expect(context.subscriptions.findById(context.subscription.id)).toMatchObject({
      consecutiveFailures: 0,
      lastError: null,
      lastFailedAt: null,
      lastSuccessAt: 2_000,
      nextPollAt: 3_602_000,
    });
    context.database.close();
  });

  test("supports zero backfill and preserves undated source order after dated entries", async () => {
    const zero = setup({ backfillLimit: 0 });
    const zeroClient = new FakeClient([
      response(rss([{ id: "ignored", title: "Ignored", date: "Fri, 15 Aug 2026 10:00:00 GMT" }])),
    ]);
    await new RssSourceAdapter(zeroClient, zero.subscriptions, zero.items, zero.now).poll(
      zero.subscription.id,
    );
    expect(zero.items.listBySubscription(zero.subscription.id)).toEqual([]);
    zero.database.close();

    const ordered = setup({ backfillLimit: 4 });
    const orderedClient = new FakeClient([
      response(
        rss([
          { id: "undated-a", title: "Undated A" },
          { id: "older", title: "Older", date: "Thu, 14 Aug 2026 10:00:00 GMT" },
          { id: "undated-b", title: "Undated B" },
          { id: "newer", title: "Newer", date: "Fri, 15 Aug 2026 10:00:00 GMT" },
        ]),
      ),
    ]);
    await new RssSourceAdapter(
      orderedClient,
      ordered.subscriptions,
      ordered.items,
      ordered.now,
    ).poll(ordered.subscription.id);
    const insertedOrder = ordered.database
      .query<{ external_id: string }, []>("SELECT external_id FROM items ORDER BY rowid")
      .all()
      .map((row) => row.external_id);
    expect(insertedOrder).toEqual(["newer", "older", "undated-a", "undated-b"]);
    ordered.database.close();
  });

  test("keeps first-seen item content while advancing a changed cursor", async () => {
    const context = setup({ backfillLimit: 20 });
    const client = new FakeClient([
      response(rss([{ id: "same", title: "Original" }]), { etag: '"one"' }),
      response(rss([{ id: "same", title: "Changed" }])),
      response("", { status: 304 }),
    ]);
    const adapter = new RssSourceAdapter(client, context.subscriptions, context.items, context.now);

    await adapter.poll(context.subscription.id);
    context.setNow(2_000);
    const result = await adapter.poll(context.subscription.id);

    expect(result).toMatchObject({
      status: "fetched",
      insertedItems: 0,
      duplicateItems: 0,
      cursor: { baselineExternalIds: ["same"] },
    });
    context.setNow(3_000);
    await adapter.poll(context.subscription.id);
    expect(client.requests[1]?.headers).toEqual({ "If-None-Match": '"one"' });
    expect(client.requests[2]?.headers).toEqual({});
    expect(context.items.listBySubscription(context.subscription.id)[0]?.title).toBe("Original");
    context.database.close();
  });

  test("records parse failure without advancing cursor or keeping partial items", async () => {
    const context = setup();
    const client = new FakeClient([response("<rss><channel><title>broken")]);
    const adapter = new RssSourceAdapter(client, context.subscriptions, context.items, context.now);

    await expect(adapter.poll(context.subscription.id)).rejects.toThrow();
    expect(context.items.listBySubscription(context.subscription.id)).toEqual([]);
    expect(context.subscriptions.findById(context.subscription.id)).toMatchObject({
      cursor: null,
      consecutiveFailures: 1,
      lastFailedAt: 1_000,
    });
    context.database.close();
  });

  test("rolls back item writes on database failure and then records source failure", async () => {
    const context = setup();
    context.database.exec(`
      CREATE TRIGGER block_rss_cursor
      BEFORE UPDATE OF cursor_json ON subscriptions
      BEGIN SELECT RAISE(ABORT, 'cursor blocked'); END;
    `);
    const client = new FakeClient([
      response(rss([{ id: "entry-1", title: "Entry" }]), { etag: '"one"' }),
    ]);
    const adapter = new RssSourceAdapter(client, context.subscriptions, context.items, context.now);

    await expect(adapter.poll(context.subscription.id)).rejects.toThrow("cursor blocked");
    expect(context.items.listBySubscription(context.subscription.id)).toEqual([]);
    expect(context.subscriptions.findById(context.subscription.id)).toMatchObject({
      cursor: null,
      consecutiveFailures: 1,
    });
    context.database.close();
  });

  test("bounds and redacts stored failure messages", async () => {
    const context = setup();
    const message = `request https://user:password@example.com/${"x".repeat(3_000)}?token=query-secret`;
    const adapter = new RssSourceAdapter(
      new FakeClient([new Error(message)]),
      context.subscriptions,
      context.items,
      context.now,
    );

    await expect(adapter.poll(context.subscription.id)).rejects.toThrow();
    const stored = context.subscriptions.findById(context.subscription.id)?.lastError;
    expect(stored?.length).toBeLessThanOrEqual(2_048);
    expect(stored).not.toContain("password");
    expect(stored).not.toContain("query-secret");
    expect(stored).toContain("credentials-redacted");
    expect(() =>
      context.database
        .query("UPDATE subscriptions SET last_error = ? WHERE id = ?")
        .run("x".repeat(2_049), context.subscription.id),
    ).toThrow();
    context.database.close();
  });

  test("does not record source failure after a subscription is disabled", () => {
    const context = setup();
    context.subscriptions.setEnabled(context.subscription.id, false);

    expect(
      context.subscriptions.recordFailure(context.subscription.id, "stale failure", 2_000),
    ).toBeNull();
    expect(context.subscriptions.findById(context.subscription.id)?.consecutiveFailures).toBe(0);
    context.database.close();
  });

  test("supports storing initial history without creating deliveries", async () => {
    const context = setup({ backfillLimit: 2, initialDeliveryLimit: 0 });
    new DeliveryRepository(
      context.database,
      () => "destination-1",
      () => 500,
    ).syncTelegramDestination("@channel");
    const adapter = new RssSourceAdapter(
      new FakeClient([
        response(
          rss([
            { id: "latest", title: "Latest" },
            { id: "older", title: "Older" },
          ]),
        ),
      ]),
      context.subscriptions,
      context.items,
      context.now,
    );

    await adapter.poll(context.subscription.id);
    expect(context.items.listBySubscription(context.subscription.id)).toHaveLength(2);
    expect(context.database.query("SELECT id FROM deliveries").all()).toEqual([]);
    context.database.close();
  });

  test("delivers new items without replaying the initial feed history", async () => {
    const context = setup({ backfillLimit: 2, initialDeliveryLimit: 1 });
    new DeliveryRepository(
      context.database,
      () => "destination-1",
      () => 500,
    ).syncTelegramDestination("@channel");
    const client = new FakeClient([
      response(
        rss([
          { id: "latest", title: "Latest" },
          { id: "old", title: "Old" },
          { id: "archive", title: "Archive" },
        ]),
      ),
      response(
        rss([
          { id: "new-2", title: "New 2" },
          { id: "new-1", title: "New 1" },
          { id: "latest", title: "Latest" },
          { id: "old", title: "Old" },
          { id: "archive", title: "Archive" },
        ]),
      ),
    ]);
    const adapter = new RssSourceAdapter(client, context.subscriptions, context.items, context.now);

    await adapter.poll(context.subscription.id);
    context.setNow(2_000);
    const second = await adapter.poll(context.subscription.id);
    const storedExternalIds = context.items
      .listBySubscription(context.subscription.id, 100)
      .map((item) => item.externalId);
    const deliveredExternalIds = context.database
      .query<{ external_id: string }, []>(
        `SELECT i.external_id FROM deliveries d JOIN items i ON i.id = d.item_id ORDER BY d.created_at, d.id`,
      )
      .all()
      .map((row) => row.external_id);

    expect(second).toMatchObject({ insertedItems: 2, duplicateItems: 0 });
    expect(storedExternalIds).toHaveLength(4);
    expect(storedExternalIds).toEqual(expect.arrayContaining(["latest", "old", "new-2", "new-1"]));
    expect(deliveredExternalIds).toEqual(["latest", "new-2", "new-1"]);
    context.database.close();
  });

  test("adopts a legacy cursor without replaying unseen history", async () => {
    const context = setup({ backfillLimit: 2, initialDeliveryLimit: 1 });
    new DeliveryRepository(
      context.database,
      () => "destination-1",
      () => 500,
    ).syncTelegramDestination("@channel");
    const client = new FakeClient([
      response(
        rss([
          { id: "latest", title: "Latest" },
          { id: "old", title: "Old" },
          { id: "archive", title: "Archive" },
        ]),
      ),
      response(
        rss([
          { id: "latest", title: "Latest" },
          { id: "old", title: "Old" },
          { id: "archive", title: "Archive" },
          { id: "fresh", title: "Fresh", date: "Thu, 01 Jan 1970 00:00:02 GMT" },
        ]),
      ),
    ]);
    const adapter = new RssSourceAdapter(client, context.subscriptions, context.items, context.now);

    await adapter.poll(context.subscription.id);
    context.database
      .query("UPDATE subscriptions SET cursor_json = ? WHERE id = ?")
      .run(JSON.stringify({ etag: '"legacy"' }), context.subscription.id);
    context.setNow(2_000);
    const second = await adapter.poll(context.subscription.id);

    expect(second).toMatchObject({ insertedItems: 2, duplicateItems: 2 });
    expect(context.database.query("SELECT id FROM deliveries ORDER BY id").all()).toEqual([
      { id: "item-1:destination-1" },
      { id: "item-6:destination-1" },
    ]);
    expect(context.subscriptions.findById(context.subscription.id)?.cursor).toMatchObject({
      baselineExternalIds: ["latest", "old", "archive", "fresh"],
    });
    context.database.close();
  });

  test("rejects invalid initial delivery configuration before requesting", async () => {
    const context = setup({ backfillLimit: 1, initialDeliveryLimit: 2 });
    const client = new FakeClient([response(rss([{ id: "entry", title: "Entry" }]))]);
    const adapter = new RssSourceAdapter(client, context.subscriptions, context.items, context.now);

    await expect(adapter.poll(context.subscription.id)).rejects.toThrow("initialDeliveryLimit");
    expect(client.requests).toEqual([]);
    expect(context.items.listBySubscription(context.subscription.id)).toEqual([]);
    context.database.close();
  });

  test("rejects invalid backfill configuration and records failure", async () => {
    const context = setup({ backfillLimit: 501 });
    const client = new FakeClient([response(rss([{ id: "entry", title: "Entry" }]))]);
    const adapter = new RssSourceAdapter(client, context.subscriptions, context.items, context.now);

    await expect(adapter.poll(context.subscription.id)).rejects.toThrow("backfillLimit");
    expect(client.requests).toEqual([]);
    expect(context.subscriptions.findById(context.subscription.id)?.consecutiveFailures).toBe(1);
    context.database.close();
  });
});
