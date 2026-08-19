import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../../../src/app/create-app.ts";
import { migrate } from "../../../src/db/migrations.ts";

const migrationsPath = resolve(import.meta.dir, "../../../migrations");

function harness() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  const app = createApp({
    database,
    migrationsPath,
    email: {
      address: "reader@inbox.example.com",
      webhookSecret: "email-secret",
    },
    now: () => 1_700_000_000_000,
  });
  return { app, database };
}

const message = {
  recipient: "READER@INBOX.EXAMPLE.COM",
  messageId: "<newsletter-1@example.com>",
  from: "Curio Letter <hello@example.com>",
  subject: "A useful finding",
  date: "2026-01-02T03:04:05Z",
  text: "Read this first: https://example.com/article-1",
  html: "<p>Read this first</p><script>ignore me</script>",
  url: "https://example.com/article-1",
  headers: { "List-ID": "curio.example.com" },
};

describe("EmailSourceAdapter", () => {
  test("creates one shared inbox subscription and records idempotent items", () => {
    const context = harness();
    const inbox = context.app.emailSource?.getInbox();
    expect(inbox).toMatchObject({
      address: "reader@inbox.example.com",
      subscription: { adapter: "email", title: "Email Inbox", sourceKey: "shared-inbox" },
    });

    const destination = context.app.services.destinations.create({
      destinationKey: "reading-room",
      kind: "telegram",
      config: { chatId: "@room" },
    });
    const subscription = inbox?.subscription;
    expect(subscription).toBeDefined();
    context.app.services.routes.create({
      subscriptionId: subscription?.id ?? "",
      destinationId: destination.id,
    });

    const first = context.app.emailSource?.receive(message);
    expect(first).toMatchObject({ insertedItems: 1, updatedItems: 0 });
    const second = context.app.emailSource?.receive(message);
    expect(second).toMatchObject({ insertedItems: 0, updatedItems: 1 });

    const items = context.app.services.subscriptions.listItemsPage(20, subscription?.id).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "A useful finding",
      author: "Curio Letter <hello@example.com>",
      url: "https://example.com/article-1",
      contentText: "Read this first: https://example.com/article-1",
      metadata: { email: { listId: "curio.example.com" } },
    });
    expect(context.app.deliveryRepository.list()).toHaveLength(1);

    context.app.close();
    context.database.close();
  });

  test("turns HTML-only mail into plain text and keeps it event-driven", async () => {
    const context = harness();
    const inbox = context.app.emailSource?.getInbox();
    const result = context.app.emailSource?.receive({
      recipient: "reader@inbox.example.com",
      messageId: null,
      from: "hello@example.com",
      subject: "HTML letter",
      date: null,
      text: null,
      html: "<p>Hello&nbsp;there</p><script>secret()</script><p>Next</p>",
      url: null,
      headers: {},
    });

    expect(result?.insertedItems).toBe(1);
    const item = context.app.services.subscriptions.listItemsPage(20, inbox?.subscription.id)
      .items[0];
    expect(item?.contentText).toContain("Hello there");
    expect(item?.contentText).toContain("Next");
    expect(item?.contentText).not.toContain("secret");
    expect(await context.app.scheduler.tick()).toBe(0);

    context.app.close();
    context.database.close();
  });
});
