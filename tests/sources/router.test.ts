import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migrate } from "../../src/db/migrations.ts";
import { SubscriptionRepository } from "../../src/db/repositories.ts";
import type { SourcePoller } from "../../src/scheduler.ts";
import { SourceRouter } from "../../src/sources/router.ts";

const migrationsPath = resolve(import.meta.dir, "../../migrations");

describe("SourceRouter", () => {
  test("dispatches by persisted adapter and rejects unsupported adapters", async () => {
    const database = new Database(":memory:", { strict: true });
    migrate(database, migrationsPath);
    let id = 0;
    const subscriptions = new SubscriptionRepository(database, () => `subscription-${++id}`);
    const rss = subscriptions.create({
      adapter: "rss",
      sourceKey: "rss",
      sourceUrl: "https://a.test",
    });
    const x = subscriptions.create({
      adapter: "x",
      sourceKey: "Kay",
      sourceUrl: "https://x.com/Kay",
    });
    const legacyYoutube = subscriptions.create({
      adapter: "rss",
      sourceKey: "https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890abcdefghi",
      sourceUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890abcdefghi",
    });
    const calls: string[] = [];
    const poller = (kind: string): SourcePoller => ({
      poll: async (subscriptionId) => {
        calls.push(`${kind}:${subscriptionId}`);
        return { status: "fetched", insertedItems: 0, duplicateItems: 0 };
      },
    });
    const router = new SourceRouter(subscriptions, {
      rss: poller("rss"),
      x: poller("x"),
      youtube: poller("youtube"),
    });

    await router.poll(rss.id);
    await router.poll(x.id);
    await router.poll(legacyYoutube.id);
    expect(calls).toEqual([`rss:${rss.id}`, `x:${x.id}`, `youtube:${legacyYoutube.id}`]);
    await expect(router.poll("missing")).rejects.toThrow("Subscription not found");
    database.close();
  });
});
