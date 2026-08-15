import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migrate } from "../src/db/migrations.ts";
import {
  DuplicateSubscriptionError,
  ItemRepository,
  SubscriptionRepository,
} from "../src/db/repositories.ts";

const migrationsPath = resolve(import.meta.dir, "../migrations");

function createDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  return database;
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

describe("SubscriptionRepository", () => {
  test("creates a typed subscription with UUIDv7", () => {
    const database = createDatabase();
    const repository = new SubscriptionRepository(database, undefined, () => 1_000);

    const subscription = repository.create({
      adapter: "rss",
      sourceKey: "https://example.com/feed.xml",
      sourceUrl: "https://example.com/feed.xml",
      title: "Example",
      metadata: { language: "zh-TW" },
      nextPollAt: 2_000,
    });

    expect(subscription.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(subscription.id[14]).toBe("7");
    expect(subscription.metadata).toEqual({ language: "zh-TW" });
    expect(subscription.createdAt).toBe(1_000);
    expect(subscription.pollIntervalMinutes).toBe(60);
    expect(repository.listDue(1_999)).toEqual([]);
    expect(repository.listDue(2_000).map((item) => item.id)).toEqual([subscription.id]);
    database.close();
  });

  test("rejects an active duplicate but restores a soft-deleted subscription", () => {
    const database = createDatabase();
    let now = 1_000;
    const repository = new SubscriptionRepository(database, sequence("subscription"), () => now);
    const input = {
      adapter: "rss",
      sourceKey: "example-feed",
      sourceUrl: "https://example.com/feed.xml",
      metadata: { preserved: true },
      nextPollAt: 5_000,
    };

    const original = repository.create(input);
    expect(() => repository.create(input)).toThrow(DuplicateSubscriptionError);

    now = 2_000;
    expect(repository.softDelete(original.id)).toBe(true);
    expect(repository.findById(original.id)).toBeNull();
    expect(repository.listDue(2_000)).toEqual([]);

    now = 3_000;
    const restored = repository.create({
      adapter: input.adapter,
      sourceKey: input.sourceKey,
      sourceUrl: input.sourceUrl,
      title: "Restored",
      nextPollAt: null,
    });
    expect(restored.id).toBe(original.id);
    expect(restored.enabled).toBe(true);
    expect(restored.deletedAt).toBeNull();
    expect(restored.title).toBe("Restored");
    expect(restored.metadata).toEqual({ preserved: true });
    expect(restored.nextPollAt).toBeNull();
    database.close();
  });

  test("lists and resolves active subscriptions by exact source URL", () => {
    const database = createDatabase();
    const repository = new SubscriptionRepository(database, sequence("subscription"), () => 1_000);
    const first = repository.create({
      adapter: "rss",
      sourceKey: "first",
      sourceUrl: "https://example.com/shared",
      pollIntervalMinutes: 120,
    });
    const second = repository.create({
      adapter: "rss-alt",
      sourceKey: "second",
      sourceUrl: "https://example.com/shared",
    });

    expect(repository.list().map((item) => item.id)).toEqual([first.id, second.id]);
    expect(repository.findBySourceUrl("https://example.com/shared")).toHaveLength(2);
    expect(first.pollIntervalMinutes).toBe(120);
    repository.softDelete(first.id);
    expect(repository.findBySourceUrl("https://example.com/shared").map((item) => item.id)).toEqual(
      [second.id],
    );
    database.close();
  });

  test("atomically schedules failures and creates one durable event per attempt", () => {
    const database = createDatabase();
    const repository = new SubscriptionRepository(database, sequence("subscription"), () => 1_000);
    const subscription = repository.create({
      adapter: "rss",
      sourceKey: "failure-feed",
      sourceUrl: "https://example.com/failure",
    });

    const expectedDelays = [300_000, 900_000, 3_600_000, 21_600_000, 21_600_000];
    for (const [index, delay] of expectedDelays.entries()) {
      const failedAt = 2_000 + index;
      expect(
        repository.recordFailure(subscription.id, `failure-${index + 1}`, failedAt),
      ).toMatchObject({
        consecutiveFailures: index + 1,
        nextPollAt: failedAt + delay,
      });
    }
    expect(repository.listFailureEvents().map((event) => event.attempt)).toEqual([1, 2, 3, 4, 5]);

    database.exec(`
      CREATE TRIGGER block_failure_event
      BEFORE INSERT ON poll_failure_events
      BEGIN SELECT RAISE(ABORT, 'event blocked'); END;
    `);
    expect(() => repository.recordFailure(subscription.id, "must-roll-back", 9_000)).toThrow(
      "event blocked",
    );
    expect(repository.findById(subscription.id)?.consecutiveFailures).toBe(5);
    expect(repository.listFailureEvents()).toHaveLength(5);
    database.close();
  });

  test("sanitizes failure events at the persistence boundary", () => {
    const database = createDatabase();
    const repository = new SubscriptionRepository(database, sequence("subscription"), () => 1_000);
    const subscription = repository.create({
      adapter: "rss",
      sourceKey: "secret-feed",
      sourceUrl: "https://example.com/secret",
    });

    repository.recordFailure(
      subscription.id,
      "failed https://user:password@example.com/feed?token=query-secret",
      2_000,
    );
    repository.recordFailure(subscription.id, "", 3_000);
    const events = repository.listFailureEvents();
    expect(events[0]?.error).not.toContain("password");
    expect(events[0]?.error).not.toContain("query-secret");
    expect(events[1]?.error).toBe("Unknown error");
    database.close();
  });

  test("database constraints reject duplicate sources and invalid JSON", () => {
    const database = createDatabase();
    const repository = new SubscriptionRepository(database, sequence("subscription"), () => 1_000);
    const subscription = repository.create({
      adapter: "rss",
      sourceKey: "example-feed",
      sourceUrl: "https://example.com/feed.xml",
    });

    expect(() =>
      database
        .query(
          `INSERT INTO subscriptions (
             id, adapter, source_key, source_url, metadata_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "duplicate",
          subscription.adapter,
          subscription.sourceKey,
          subscription.sourceUrl,
          "{}",
          1_000,
          1_000,
        ),
    ).toThrow();
    expect(() =>
      database
        .query("UPDATE subscriptions SET metadata_json = ? WHERE id = ?")
        .run("{", subscription.id),
    ).toThrow();
    expect(() =>
      database
        .query("UPDATE subscriptions SET updated_at = ? WHERE id = ?")
        .run("not-a-timestamp", subscription.id),
    ).toThrow();
    database.close();
  });
});

describe("ItemRepository", () => {
  test("atomically inserts items, ignores duplicates, and advances the cursor", () => {
    const database = createDatabase();
    const subscriptions = new SubscriptionRepository(
      database,
      sequence("subscription"),
      () => 1_000,
    );
    const items = new ItemRepository(database, sequence("item"));
    const subscription = subscriptions.create({
      adapter: "rss",
      sourceKey: "example-feed",
      sourceUrl: "https://example.com/feed.xml",
    });
    const canonicalItem = {
      externalId: "article-1",
      url: "https://example.com/article-1",
      title: "Article",
      contentText: "Text",
      contentHtml: "<p>Text</p>",
      publishedAt: 900,
      metadata: { category: "curio" },
    };

    expect(
      items.recordPoll({
        subscriptionId: subscription.id,
        items: [canonicalItem],
        cursor: { etag: "first" },
        polledAt: 2_000,
        nextPollAt: 3_000,
      }),
    ).toEqual({ insertedItems: 1, duplicateItems: 0 });

    expect(
      items.recordPoll({
        subscriptionId: subscription.id,
        items: [canonicalItem],
        cursor: { etag: "second" },
        polledAt: 2_500,
        nextPollAt: 3_500,
      }),
    ).toEqual({ insertedItems: 0, duplicateItems: 1 });

    expect(items.listBySubscription(subscription.id)).toMatchObject([
      {
        externalId: "article-1",
        contentText: "Text",
        contentHtml: "<p>Text</p>",
        metadata: { category: "curio" },
      },
    ]);
    expect(subscriptions.findById(subscription.id)).toMatchObject({
      cursor: { etag: "second" },
      lastPolledAt: 2_500,
      lastSuccessAt: 2_500,
      nextPollAt: 3_500,
    });
    database.close();
  });

  test("rejects missing external IDs before writing", () => {
    const database = createDatabase();
    const subscriptions = new SubscriptionRepository(
      database,
      sequence("subscription"),
      () => 1_000,
    );
    const items = new ItemRepository(database, sequence("item"));
    const subscription = subscriptions.create({
      adapter: "rss",
      sourceKey: "example-feed",
      sourceUrl: "https://example.com/feed.xml",
    });

    expect(() =>
      items.recordPoll({
        subscriptionId: subscription.id,
        items: [{ externalId: " " }],
        cursor: { page: 2 },
        polledAt: 2_000,
      }),
    ).toThrow("externalId must not be empty");
    expect(subscriptions.findById(subscription.id)?.cursor).toBeNull();
    expect(items.listBySubscription(subscription.id)).toEqual([]);
    database.close();
  });

  test("rejects stale poll writes after a subscription is disabled", () => {
    const database = createDatabase();
    const subscriptions = new SubscriptionRepository(
      database,
      sequence("subscription"),
      () => 1_000,
    );
    const items = new ItemRepository(database, sequence("item"));
    const subscription = subscriptions.create({
      adapter: "rss",
      sourceKey: "example-feed",
      sourceUrl: "https://example.com/feed.xml",
    });
    subscriptions.setEnabled(subscription.id, false);

    expect(() =>
      items.recordPoll({
        subscriptionId: subscription.id,
        items: [{ externalId: "article-1" }],
        cursor: { page: 2 },
        polledAt: 2_000,
      }),
    ).toThrow("missing or inactive");
    expect(items.listBySubscription(subscription.id)).toEqual([]);
    database.close();
  });

  test("rolls back inserted items when the cursor update fails", () => {
    const database = createDatabase();
    const subscriptions = new SubscriptionRepository(
      database,
      sequence("subscription"),
      () => 1_000,
    );
    const items = new ItemRepository(database, sequence("item"));
    const subscription = subscriptions.create({
      adapter: "rss",
      sourceKey: "example-feed",
      sourceUrl: "https://example.com/feed.xml",
    });
    database.exec(`
      CREATE TRIGGER block_cursor_update
      BEFORE UPDATE OF cursor_json ON subscriptions
      BEGIN
        SELECT RAISE(ABORT, 'cursor blocked');
      END;
    `);

    expect(() =>
      items.recordPoll({
        subscriptionId: subscription.id,
        items: [{ externalId: "article-1" }],
        cursor: { page: 2 },
        polledAt: 2_000,
      }),
    ).toThrow("cursor blocked");
    expect(items.listBySubscription(subscription.id)).toEqual([]);
    expect(subscriptions.findById(subscription.id)?.cursor).toBeNull();
    database.close();
  });

  test("soft deletion preserves collected items", () => {
    const database = createDatabase();
    const subscriptions = new SubscriptionRepository(
      database,
      sequence("subscription"),
      () => 1_000,
    );
    const items = new ItemRepository(database, sequence("item"));
    const subscription = subscriptions.create({
      adapter: "rss",
      sourceKey: "example-feed",
      sourceUrl: "https://example.com/feed.xml",
    });

    items.recordPoll({
      subscriptionId: subscription.id,
      items: [{ externalId: "article-1" }],
      cursor: null,
      polledAt: 2_000,
    });
    subscriptions.softDelete(subscription.id);

    expect(subscriptions.findById(subscription.id)).toBeNull();
    expect(items.listBySubscription(subscription.id).map((item) => item.externalId)).toEqual([
      "article-1",
    ]);
    database.close();
  });

  test("foreign keys reject items for missing subscriptions", () => {
    const database = createDatabase();

    expect(() =>
      database
        .query(
          `INSERT INTO items (
             id, subscription_id, external_id, discovered_at, created_at, updated_at, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("item-1", "missing", "article-1", 1_000, 1_000, 1_000, "{}"),
    ).toThrow();
    database.close();
  });
});
