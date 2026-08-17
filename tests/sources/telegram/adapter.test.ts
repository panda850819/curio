import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../../../src/app/create-app.ts";
import { migrate } from "../../../src/db/migrations.ts";
import type { TelegramChannelPost } from "../../../src/sources/telegram/types.ts";

const migrationsPath = resolve(import.meta.dir, "../../../migrations");

const candidate = {
  adapter: "telegram" as const,
  format: "telegram" as const,
  sourceUrl: "https://t.me/journey_of_someone",
  sourceKey: "telegram:username:journey_of_someone",
  title: "Telegram: @journey_of_someone",
  discoveredVia: "direct" as const,
};

function post(updateId: number, text: string, edited = false): TelegramChannelPost {
  return {
    updateId,
    messageId: 42,
    chat: {
      id: "-10042",
      type: "channel",
      title: "Journey",
      username: "journey_of_someone",
    },
    date: 1_000,
    editDate: edited ? 1_100 : null,
    text,
  };
}

describe("TelegramSourceAdapter", () => {
  test("inserts new channel posts, deduplicates them, and upserts edits", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON;");
    migrate(database, migrationsPath);
    const app = createApp({ database, migrationsPath, now: () => 2_000_000 });
    const destination = app.services.destinations.create({
      destinationKey: "telegram-reading",
      kind: "telegram",
      config: { chatId: "@pdzenglog" },
    });
    const subscription = app.services.subscriptions.follow({
      candidate,
      intervalMinutes: 60,
    }).subscription;
    app.services.routes.create({
      subscriptionId: subscription.id,
      destinationId: destination.id,
    });

    app.telegramSource.handleChannelPost(post(10, "first version"));
    let items = app.services.subscriptions.listItemsPage(20, subscription.id).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      externalId: "telegram:-10042:42",
      contentText: "first version",
      url: "https://t.me/journey_of_someone/42",
    });
    expect(app.deliveryRepository.list()).toHaveLength(1);

    app.telegramSource.handleChannelPost(post(11, "first version"));
    expect(app.services.subscriptions.listItemsPage(20, subscription.id).items).toHaveLength(1);
    expect(app.deliveryRepository.list()).toHaveLength(1);

    app.telegramSource.handleChannelPost(post(12, "edited version", true));
    items = app.services.subscriptions.listItemsPage(20, subscription.id).items;
    expect(items[0]?.contentText).toBe("edited version");
    expect(app.deliveryRepository.list()).toHaveLength(1);

    app.close();
    database.close();
  });

  test("ignores channel posts without a matching subscription", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON;");
    migrate(database, migrationsPath);
    const app = createApp({ database, migrationsPath });

    app.telegramSource.handleChannelPost(post(20, "untracked"));

    expect(app.services.subscriptions.listItemsPage(20).items).toHaveLength(0);
    expect(app.deliveryRepository.list()).toHaveLength(0);
    app.close();
    database.close();
  });
});
