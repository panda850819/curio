import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../../../src/app/create-app.ts";
import { migrate } from "../../../src/db/migrations.ts";
import type { HttpHeaders, HttpResponse, ProbeHttpClient } from "../../../src/probe/types.ts";
import { parseTelegramHtml } from "../../../src/sources/telegram/html-adapter.ts";

const migrationsPath = resolve(import.meta.dir, "../../../migrations");

class Headers implements HttpHeaders {
  constructor(private readonly values: Record<string, string>) {}
  get(name: string): string | null {
    return this.values[name.toLowerCase()] ?? null;
  }
}

function page(posts: Array<{ id: number; text: string }>): string {
  return `<html><body>${posts
    .map(
      (
        post,
      ) => `<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="journey_of_someone/${post.id}">
        <div class="tgme_widget_message_owner_name">投机之路</div>
        <div class="tgme_widget_message_text js-message_text">${post.text}<br>第二行</div>
        <div class="tgme_widget_message_footer"><a class="tgme_widget_message_date"><time datetime="2026-08-17T01:02:03Z">01:02</time></a></div>
      </div>`,
    )
    .join("")}</body></html>`;
}

class FakeClient implements ProbeHttpClient {
  constructor(private readonly bodies: string[]) {}
  private index = 0;
  async get(): Promise<HttpResponse> {
    const body = this.bodies[Math.min(this.index++, this.bodies.length - 1)] as string;
    return {
      url: "https://t.me/s/journey_of_someone",
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      body: new TextEncoder().encode(body),
    };
  }
}

const candidate = {
  adapter: "telegram_html" as const,
  format: "html" as const,
  sourceUrl: "https://t.me/s/journey_of_someone",
  sourceKey: "telegram-html:journey_of_someone",
  title: "Telegram HTML: @journey_of_someone",
  discoveredVia: "direct" as const,
};

describe("Telegram HTML source", () => {
  test("parses post IDs, text, title, and dates from the public page", () => {
    const posts = parseTelegramHtml(page([{ id: 229, text: "第一行 &amp; 內容" }]));
    expect(posts).toEqual([
      {
        messageId: 229,
        username: "journey_of_someone",
        title: "投机之路",
        contentText: "第一行 & 內容 第二行",
        url: "https://t.me/journey_of_someone/229",
        publishedAt: Date.parse("2026-08-17T01:02:03Z"),
      },
    ]);
  });

  test("backfills one newest post, delivers new posts, and updates edits", async () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON;");
    migrate(database, migrationsPath);
    const app = createApp({
      database,
      migrationsPath,
      probeClient: new FakeClient([
        page([
          { id: 229, text: "old" },
          { id: 230, text: "newest" },
        ]),
        page([
          { id: 229, text: "old" },
          { id: 230, text: "edited newest" },
          { id: 231, text: "later" },
        ]),
      ]),
      now: () => 2_000_000,
    });
    const destination = app.services.destinations.create({
      destinationKey: "telegram-reading",
      kind: "telegram",
      config: { chatId: "@pdzenglog" },
    });
    const subscription = app.services.subscriptions.follow({
      candidate,
      intervalMinutes: 60,
      metadata: { backfillLimit: 20, initialDeliveryLimit: 1 },
    }).subscription;
    app.services.routes.create({ subscriptionId: subscription.id, destinationId: destination.id });

    const first = await app.services.subscriptions.poll(subscription.id);
    expect(first).toMatchObject({ status: "backfilled", insertedItems: 2 });
    expect(app.deliveryRepository.list()).toHaveLength(1);

    const second = await app.services.subscriptions.poll(subscription.id);
    expect(second).toMatchObject({ status: "fetched", insertedItems: 1, duplicateItems: 2 });
    expect(app.services.subscriptions.listItemsPage(20, subscription.id).items).toHaveLength(3);
    expect(
      app.services.subscriptions
        .listItemsPage(20, subscription.id)
        .items.some((item) => item.contentText?.includes("edited newest")),
    ).toBe(true);
    expect(app.deliveryRepository.list()).toHaveLength(2);

    app.close();
    database.close();
  });
});
