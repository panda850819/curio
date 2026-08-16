import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migrate } from "../../../src/db/migrations.ts";
import { ItemRepository, SubscriptionRepository } from "../../../src/db/repositories.ts";
import { DeliveryRepository } from "../../../src/delivery/repository.ts";
import { XSourceAdapter } from "../../../src/sources/x/adapter.ts";
import type { XbirdTimelineClient, XTweet } from "../../../src/sources/x/types.ts";

const migrationsPath = resolve(import.meta.dir, "../../../migrations");

class FakeClient implements XbirdTimelineClient {
  readonly calls: Array<{ handle: string; count: number }> = [];
  constructor(private readonly responses: Array<XTweet[] | Error>) {}
  async userTweets(handle: string, count: number): Promise<XTweet[]> {
    this.calls.push({ handle, count });
    const response = this.responses.shift();
    if (!response) throw new Error("No response configured");
    if (response instanceof Error) throw response;
    return response;
  }
}

function tweet(id: string, options: Partial<XTweet> = {}): XTweet {
  return {
    id,
    text: `Post ${id}`,
    createdAt: new Date(Number(id) * 1_000).toUTCString(),
    conversationId: id,
    author: { username: "Kay2289123", name: "美研芒格君" },
    ...options,
  };
}

function setup(metadata: Record<string, number> = {}) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  let now = 100_000;
  const subscriptions = new SubscriptionRepository(
    database,
    () => "subscription-1",
    () => now,
  );
  const items = new ItemRepository(
    database,
    (() => {
      let id = 0;
      return () => `item-${++id}`;
    })(),
  );
  const subscription = subscriptions.create({
    adapter: "x",
    sourceKey: "Kay2289123",
    sourceUrl: "https://x.com/Kay2289123",
    title: "@Kay2289123",
    metadata,
  });
  new DeliveryRepository(
    database,
    () => "destination-1",
    () => now,
  ).syncTelegramDestination("@channel");
  return {
    database,
    subscriptions,
    items,
    subscription,
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("XSourceAdapter", () => {
  test("stores originals and quote posts, excludes replies and reposts, and delivers one initially", async () => {
    const context = setup();
    const posts = [
      tweet("5", { quotedTweet: tweet("1") }),
      tweet("4", { inReplyToStatusId: "3" }),
      tweet("3", { author: { username: "Other", name: "Other" } }),
      tweet("2"),
      tweet("1", { text: "RT @Other repost" }),
    ];
    const client = new FakeClient([posts]);
    const adapter = new XSourceAdapter(client, context.subscriptions, context.items, context.now);

    const result = await adapter.poll(context.subscription.id);
    expect(result).toEqual({ status: "fetched", insertedItems: 2, duplicateItems: 0 });
    expect(client.calls).toEqual([{ handle: "Kay2289123", count: 20 }]);
    expect(
      context.items.listBySubscription(context.subscription.id).map((item) => item.externalId),
    ).toEqual(["5", "2"]);
    const deliveryIds = context.database
      .query<{ external_id: string }, []>(
        "SELECT i.external_id FROM deliveries d JOIN items i ON i.id=d.item_id",
      )
      .all()
      .map((row) => row.external_id);
    expect(deliveryIds).toEqual(["5"]);
    context.database.close();
  });

  test("delivers every later new post without redelivering duplicates", async () => {
    const context = setup({ backfillLimit: 2, initialDeliveryLimit: 1 });
    const client = new FakeClient([
      [tweet("2"), tweet("1")],
      [tweet("3"), tweet("2")],
    ]);
    const adapter = new XSourceAdapter(client, context.subscriptions, context.items, context.now);

    await adapter.poll(context.subscription.id);
    context.setNow(200_000);
    const second = await adapter.poll(context.subscription.id);
    expect(second).toEqual({ status: "fetched", insertedItems: 1, duplicateItems: 1 });
    expect(
      context.database
        .query<{ external_id: string }, []>(
          "SELECT i.external_id FROM deliveries d JOIN items i ON i.id=d.item_id ORDER BY d.created_at,d.id",
        )
        .all()
        .map((row) => row.external_id),
    ).toEqual(["2", "3"]);
    context.database.close();
  });

  test("records bounded failures without advancing the cursor", async () => {
    const context = setup();
    const adapter = new XSourceAdapter(
      new FakeClient([new Error("authentication failed")]),
      context.subscriptions,
      context.items,
      context.now,
    );
    await expect(adapter.poll(context.subscription.id)).rejects.toThrow("authentication failed");
    const stored = context.subscriptions.findById(context.subscription.id);
    expect(stored).toMatchObject({ cursor: null, consecutiveFailures: 1 });
    context.database.close();
  });
});
