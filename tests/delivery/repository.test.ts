import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migrate } from "../../src/db/migrations.ts";
import { ItemRepository, SubscriptionRepository } from "../../src/db/repositories.ts";
import { DeliveryRepository } from "../../src/delivery/repository.ts";

const migrationsPath = resolve(import.meta.dir, "../../migrations");
function sequence(prefix: string) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
function setup() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  const subscriptions = new SubscriptionRepository(database, sequence("subscription"), () => 1_000);
  const items = new ItemRepository(database, sequence("item"));
  const deliveries = new DeliveryRepository(database, sequence("generated"), () => 5_000);
  const subscription = subscriptions.create({
    adapter: "rss",
    sourceKey: "feed",
    sourceUrl: "https://example.com/feed",
  });
  return { database, subscriptions, items, deliveries, subscription };
}

describe("DeliveryRepository", () => {
  test("does not backfill items but enqueues new items and existing failures exactly once", () => {
    const context = setup();
    context.items.recordPoll({
      subscriptionId: context.subscription.id,
      items: [{ externalId: "old" }],
      cursor: {},
      polledAt: 2_000,
    });
    context.subscriptions.recordFailure(context.subscription.id, "old failure", 3_000);

    const destination = context.deliveries.syncTelegramDestination("@channel");
    expect(context.deliveries.list()).toMatchObject([
      { destinationId: destination.id, itemId: null, failureEventId: expect.any(String) },
    ]);
    context.deliveries.syncTelegramDestination("@changed");
    expect(context.deliveries.list()).toHaveLength(1);
    const pending = context.deliveries.list()[0];
    if (!pending) throw new Error("Expected pending failure delivery");
    expect(context.deliveries.loadPayload(pending.id).chatId).toBe("@changed");

    context.items.recordPoll({
      subscriptionId: context.subscription.id,
      items: [{ externalId: "new" }],
      cursor: {},
      polledAt: 6_000,
    });
    const records = context.deliveries.list();
    expect(records).toHaveLength(2);
    expect(records.filter((delivery) => delivery.itemId !== null)).toHaveLength(1);
    context.database.close();
  });

  test("stops enqueueing items while the Telegram destination is disabled", () => {
    const context = setup();
    context.deliveries.syncTelegramDestination("@channel");
    expect(context.deliveries.disableTelegramDestination()).toBe(true);

    context.items.recordPoll({
      subscriptionId: context.subscription.id,
      items: [{ externalId: "while-disabled" }],
      cursor: {},
      polledAt: 2_000,
    });
    expect(context.deliveries.list()).toEqual([]);
    context.database.close();
  });

  test("rolls back a new item and cursor when its outbox insert fails", () => {
    const context = setup();
    context.deliveries.syncTelegramDestination("@channel");
    context.database.exec(`CREATE TRIGGER block_item_delivery BEFORE INSERT ON deliveries
      WHEN NEW.item_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'item delivery blocked'); END;`);

    expect(() =>
      context.items.recordPoll({
        subscriptionId: context.subscription.id,
        items: [{ externalId: "must-roll-back" }],
        cursor: { etag: "must-roll-back" },
        polledAt: 2_000,
      }),
    ).toThrow("item delivery blocked");
    expect(context.items.listBySubscription(context.subscription.id)).toEqual([]);
    expect(context.subscriptions.findById(context.subscription.id)?.cursor).toBeNull();
    context.database.close();
  });

  test("atomically creates a future failure event and delivery", () => {
    const context = setup();
    context.deliveries.syncTelegramDestination("@channel");
    context.subscriptions.recordFailure(context.subscription.id, "first", 2_000);
    expect(context.deliveries.list()).toHaveLength(1);

    context.database.exec(`CREATE TRIGGER block_failure_delivery BEFORE INSERT ON deliveries
      WHEN NEW.failure_event_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'delivery blocked'); END;`);
    expect(() =>
      context.subscriptions.recordFailure(context.subscription.id, "second", 3_000),
    ).toThrow("delivery blocked");
    expect(context.subscriptions.findById(context.subscription.id)?.consecutiveFailures).toBe(1);
    expect(context.subscriptions.listFailureEvents()).toHaveLength(1);
    context.database.close();
  });

  test("recovers processing deliveries as uncertain with attempt history", () => {
    const context = setup();
    context.deliveries.syncTelegramDestination("@channel");
    context.subscriptions.recordFailure(context.subscription.id, "failure", 2_000);
    const claimed = context.deliveries.claimDue()[0];
    if (!claimed) throw new Error("Expected claimed delivery");

    expect(context.deliveries.recoverProcessing()).toBe(1);
    expect(context.deliveries.list()[0]?.status).toBe("uncertain");
    expect(context.deliveries.listAttempts(claimed.id)).toMatchObject([
      { attempt: 1, outcome: "uncertain" },
    ]);
    context.database.close();
  });

  test("claims, completes, preserves attempts, and manually retries", () => {
    const context = setup();
    context.deliveries.syncTelegramDestination("@channel");
    context.subscriptions.recordFailure(context.subscription.id, "failure", 2_000);
    const claimed = context.deliveries.claimDue(4)[0];
    expect(claimed).toMatchObject({ status: "processing", attemptCount: 1 });
    if (!claimed) throw new Error("Expected claimed delivery");
    const payload = context.deliveries.loadPayload(claimed.id);
    expect(payload.chatId).toBe("@channel");
    expect(payload.failureEvent?.error).toBe("failure");

    context.deliveries.complete({
      deliveryId: claimed.id,
      outcome: "uncertain",
      startedAt: 5_000,
      finishedAt: 6_000,
      error: "ambiguous",
    });
    expect(context.deliveries.retry(claimed.id).status).toBe("pending");
    expect(context.deliveries.listAttempts(claimed.id)).toMatchObject([
      { attempt: 1, outcome: "uncertain" },
    ]);
    context.database.close();
  });
});
