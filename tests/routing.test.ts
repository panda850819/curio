import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "../src/db/migrations.ts";
import {
  DestinationRepository,
  DuplicateRouteError,
  ItemRepository,
  RouteRepository,
  SubscriptionRepository,
} from "../src/db/repositories.ts";
import { DeliveryRepository } from "../src/delivery/repository.ts";

const migrationsPath = resolve(import.meta.dir, "../migrations");

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function createDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  return database;
}

function createSubscription(subscriptions: SubscriptionRepository, sourceKey: string) {
  return subscriptions.create({
    adapter: "rss",
    sourceKey,
    sourceUrl: `https://example.com/${sourceKey}`,
  });
}

describe("routing repositories", () => {
  test("supports destination and route CRUD with a unique subscription pair", () => {
    const database = createDatabase();
    const subscriptions = new SubscriptionRepository(
      database,
      sequence("subscription"),
      () => 1_000,
    );
    const destinations = new DestinationRepository(database, sequence("destination"), () => 2_000);
    const routes = new RouteRepository(database, sequence("route"), () => 3_000);
    const subscription = createSubscription(subscriptions, "source");
    const destination = destinations.create({
      destinationKey: "telegram-a",
      kind: "telegram",
      config: { chatId: "@a" },
    });

    const route = routes.create({
      subscriptionId: subscription.id,
      destinationId: destination.id,
      config: { tag: "news" },
    });
    expect(route).toMatchObject({
      id: "route-1",
      subscriptionId: subscription.id,
      destinationId: destination.id,
      enabled: true,
      config: { tag: "news" },
      createdAt: 3_000,
    });
    expect(() =>
      routes.create({ subscriptionId: subscription.id, destinationId: destination.id }),
    ).toThrow(DuplicateRouteError);
    expect(routes.listEnabledForSubscription(subscription.id)).toHaveLength(1);

    expect(routes.setEnabled(route.id, false)?.enabled).toBe(false);
    expect(routes.listEnabledForSubscription(subscription.id)).toEqual([]);
    expect(routes.update(route.id, { enabled: true, config: { tag: "updated" } })).toMatchObject({
      enabled: true,
      config: { tag: "updated" },
    });
    expect(routes.delete(route.id)).toBe(true);
    expect(routes.findById(route.id)).toBeNull();

    expect(destinations.update(destination.id, { config: { chatId: "@changed" } })).toMatchObject({
      config: { chatId: "@changed" },
    });
    expect(destinations.setEnabled(destination.id, false)?.enabled).toBe(false);
    expect(destinations.list()).toHaveLength(1);
    database.close();
  });

  test("migration compatibility step backfills an existing primary destination", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON;");
    const partialMigrations = mkdtempSync(join(tmpdir(), "curio-routes-migrations-"));
    try {
      for (const name of [
        "001_initialize.sql",
        "002_core_ingestion.sql",
        "003_subscription_health.sql",
        "004_subscription_scheduling.sql",
        "005_telegram_delivery.sql",
      ]) {
        copyFileSync(resolve(migrationsPath, name), join(partialMigrations, name));
      }
      expect(migrate(database, partialMigrations)).toBe(5);
      const subscriptions = new SubscriptionRepository(
        database,
        sequence("subscription"),
        () => 1_000,
      );
      const destinations = new DestinationRepository(
        database,
        sequence("destination"),
        () => 2_000,
      );
      const subscription = createSubscription(subscriptions, "existing");
      destinations.create({
        destinationKey: "telegram-primary",
        kind: "telegram",
        config: { chatId: "@primary" },
      });

      expect(migrate(database, migrationsPath)).toBe(2);
      const routes = new RouteRepository(database, sequence("route"), () => 3_000);
      expect(routes.list()).toMatchObject([
        { subscriptionId: subscription.id, enabled: true, config: {} },
      ]);
      expect(migrate(database, migrationsPath)).toBe(0);
    } finally {
      database.close();
      rmSync(partialMigrations, { recursive: true, force: true });
    }
  });

  test("compatibility backfill is idempotent and skips deleted subscriptions", () => {
    const database = createDatabase();
    const subscriptions = new SubscriptionRepository(
      database,
      sequence("subscription"),
      () => 1_000,
    );
    const destinations = new DestinationRepository(database, sequence("destination"), () => 2_000);
    const routes = new RouteRepository(database, sequence("route"), () => 3_000);
    const active = createSubscription(subscriptions, "active");
    const deleted = createSubscription(subscriptions, "deleted");
    subscriptions.softDelete(deleted.id);
    const destination = destinations.create({
      destinationKey: "telegram-primary",
      kind: "telegram",
      config: { chatId: "@primary" },
    });

    expect(routes.ensureCompatibility(destination.id, 4_000)).toBe(1);
    expect(routes.ensureCompatibility(destination.id, 5_000)).toBe(0);
    expect(routes.list().map((route) => route.subscriptionId)).toEqual([active.id]);

    const later = createSubscription(subscriptions, "later");
    expect(routes.ensureCompatibility(destination.id, 6_000)).toBe(0);
    expect(routes.listBySubscription(later.id)).toEqual([]);
    database.close();
  });

  test("restoring a subscription deleted before compatibility keeps primary routing", () => {
    const database = createDatabase();
    const subscriptions = new SubscriptionRepository(
      database,
      sequence("subscription"),
      () => 1_000,
    );
    const destinations = new DestinationRepository(database, sequence("destination"), () => 2_000);
    const routes = new RouteRepository(database, sequence("route"), () => 3_000);
    const subscription = createSubscription(subscriptions, "restored");
    subscriptions.softDelete(subscription.id);
    const destination = destinations.create({
      destinationKey: "telegram-primary",
      kind: "telegram",
      config: { chatId: "@primary" },
    });
    routes.ensureCompatibility(destination.id, 4_000);

    const restored = subscriptions.create({
      adapter: "rss",
      sourceKey: "restored",
      sourceUrl: "https://example.com/restored",
    });
    expect(restored.id).toBe(subscription.id);
    expect(routes.listBySubscription(restored.id)).toHaveLength(1);
    database.close();
  });
});

describe("route-aware deliveries", () => {
  test("only enabled routes to enabled destinations receive items and failures", () => {
    const database = createDatabase();
    const subscriptions = new SubscriptionRepository(
      database,
      sequence("subscription"),
      () => 1_000,
    );
    const items = new ItemRepository(database, sequence("item"));
    const destinations = new DestinationRepository(database, sequence("destination"), () => 2_000);
    const routes = new RouteRepository(database, sequence("route"), () => 3_000);
    const deliveries = new DeliveryRepository(
      database,
      sequence("delivery"),
      () => 4_000,
      destinations,
      routes,
    );
    const first = createSubscription(subscriptions, "first");
    const second = createSubscription(subscriptions, "second");
    const firstDestination = destinations.create({
      destinationKey: "telegram-first",
      kind: "telegram",
      config: { chatId: "@first" },
    });
    const secondDestination = destinations.create({
      destinationKey: "telegram-second",
      kind: "telegram",
      config: { chatId: "@second" },
    });
    routes.create({ subscriptionId: first.id, destinationId: firstDestination.id });
    routes.create({ subscriptionId: second.id, destinationId: secondDestination.id });

    items.recordPoll({
      subscriptionId: first.id,
      items: [{ externalId: "first-item" }],
      cursor: {},
      polledAt: 5_000,
    });
    items.recordPoll({
      subscriptionId: second.id,
      items: [{ externalId: "second-item" }],
      cursor: {},
      polledAt: 6_000,
    });
    subscriptions.recordFailure(first.id, "first failure", 7_000);
    subscriptions.recordFailure(second.id, "second failure", 8_000);

    expect(deliveries.list()).toMatchObject([
      { itemId: expect.any(String), destinationId: firstDestination.id },
      { itemId: expect.any(String), destinationId: secondDestination.id },
      { failureEventId: expect.any(String), destinationId: firstDestination.id },
      { failureEventId: expect.any(String), destinationId: secondDestination.id },
    ]);
    expect(
      deliveries.list().filter((delivery) => delivery.destinationId === firstDestination.id),
    ).toHaveLength(2);
    expect(
      deliveries.list().filter((delivery) => delivery.destinationId === secondDestination.id),
    ).toHaveLength(2);
    database.close();
  });

  test("missing or disabled routes do not create new deliveries", () => {
    const database = createDatabase();
    const subscriptions = new SubscriptionRepository(
      database,
      sequence("subscription"),
      () => 1_000,
    );
    const items = new ItemRepository(database, sequence("item"));
    const destinations = new DestinationRepository(database, sequence("destination"), () => 2_000);
    const routes = new RouteRepository(database, sequence("route"), () => 3_000);
    const deliveries = new DeliveryRepository(
      database,
      sequence("delivery"),
      () => 4_000,
      destinations,
      routes,
    );
    const subscription = createSubscription(subscriptions, "source");
    const destination = destinations.create({
      destinationKey: "telegram-source",
      kind: "telegram",
      config: { chatId: "@source" },
    });

    items.recordPoll({
      subscriptionId: subscription.id,
      items: [{ externalId: "without-route" }],
      cursor: {},
      polledAt: 5_000,
    });
    expect(deliveries.list()).toEqual([]);

    const route = routes.create({
      subscriptionId: subscription.id,
      destinationId: destination.id,
      enabled: false,
    });
    items.recordPoll({
      subscriptionId: subscription.id,
      items: [{ externalId: "disabled-route" }],
      cursor: {},
      polledAt: 6_000,
    });
    expect(deliveries.list()).toEqual([]);

    routes.setEnabled(route.id, true);
    destinations.setEnabled(destination.id, false);
    items.recordPoll({
      subscriptionId: subscription.id,
      items: [{ externalId: "disabled-destination" }],
      cursor: {},
      polledAt: 7_000,
    });
    expect(deliveries.list()).toEqual([]);
    database.close();
  });
});
