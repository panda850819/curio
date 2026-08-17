import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../../../src/app/create-app.ts";
import { migrate } from "../../../src/db/migrations.ts";
import type { ProbeHttpClient } from "../../../src/probe/types.ts";
import { normalizeYoutubeFeed } from "../../../src/sources/youtube/normalize.ts";

const migrationsPath = resolve(import.meta.dir, "../../../migrations");
const channelId = "UC1234567890abcdefghi";
const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

function feed(ids: string[]): string {
  return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Curio Channel</title><id>${feedUrl.replace("&", "&amp;")}</id><updated>2026-08-15T10:00:00Z</updated>${ids
    .map(
      (id, index) =>
        `<entry><title>Video ${id}</title><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/><published>2026-08-15T0${index + 1}:00:00Z</published><updated>2026-08-15T0${index + 1}:30:00Z</updated><author><name>Curio Channel</name></author><summary>Summary ${id}</summary></entry>`,
    )
    .join("")}</feed>`;
}

function harness(initial: string) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  let body = initial;
  let status = 200;
  const client: ProbeHttpClient = {
    get: async (url) => ({
      url,
      status,
      headers: {
        get: (name: string) => {
          if (name === "content-type") return "application/atom+xml";
          if (name === "etag") return '"youtube-v1"';
          return null;
        },
      },
      body: new TextEncoder().encode(body),
    }),
  };
  const app = createApp({ database, migrationsPath, probeClient: client, now: () => 1_000 });
  const destination = app.services.destinations.create({
    destinationKey: "reading-room",
    kind: "telegram",
    config: { chatId: "@room" },
  });
  const subscription = app.services.subscriptions.follow({
    candidate: {
      adapter: "youtube",
      format: "youtube",
      sourceUrl: feedUrl,
      sourceKey: channelId,
      title: "Curio Channel",
      discoveredVia: "direct",
    },
    intervalMinutes: 60,
    metadata: { backfillLimit: 2, initialDeliveryLimit: 1 },
  }).subscription;
  app.services.routes.create({ subscriptionId: subscription.id, destinationId: destination.id });
  return {
    app,
    database,
    subscription,
    setBody(next: string) {
      body = next;
      status = 200;
    },
    setNotModified() {
      status = 304;
    },
  };
}

describe("YouTube normalization and adapter", () => {
  test("uses video ID as immutable external ID and preserves video metadata", () => {
    const result = normalizeYoutubeFeed(feed(["video-1"]), feedUrl);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.item).toMatchObject({
      externalId: "video-1",
      url: "https://www.youtube.com/watch?v=video-1",
      title: "Video video-1",
      metadata: { source: "youtube", videoId: "video-1" },
    });
  });

  test("applies first-poll backfill, incremental IDs, conditional requests, and idempotency", async () => {
    const context = harness(feed(["video-1", "video-2"]));
    const first = await context.app.services.subscriptions.poll(context.subscription.id);
    expect(first.status).toBe("fetched");
    expect(
      context.app.services.subscriptions.listItemsPage(20, context.subscription.id).items,
    ).toHaveLength(2);
    expect(context.app.services.deliveries.list()).toHaveLength(1);

    context.setBody(feed(["video-3", "video-2", "video-1"]));
    await context.app.services.subscriptions.poll(context.subscription.id);
    expect(
      context.app.services.subscriptions.listItemsPage(20, context.subscription.id).items,
    ).toHaveLength(3);
    expect(context.app.services.deliveries.list()).toHaveLength(2);

    context.setNotModified();
    const notModified = await context.app.services.subscriptions.poll(context.subscription.id);
    expect(notModified.status).toBe("not_modified");
    expect(context.app.services.deliveries.list()).toHaveLength(2);

    context.app.close();
    context.database.close();
  });
});
