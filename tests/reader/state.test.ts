import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migrate } from "../../src/db/migrations.ts";
import { ItemRepository, SubscriptionRepository } from "../../src/db/repositories.ts";
import type { ProbeHttpClient } from "../../src/probe/types.ts";
import { ItemEnrichmentRepository } from "../../src/reader/repository.ts";
import { DefaultReaderService } from "../../src/reader/service.ts";
import { ReaderStateRepository } from "../../src/reader/state-repository.ts";

const migrationsPath = resolve(import.meta.dir, "../../migrations");
const client: ProbeHttpClient = {
  get: async () => {
    throw new Error("Network is not used by Reader state tests");
  },
};

function harness() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  const subscriptions = new SubscriptionRepository(
    database,
    () => "subscription",
    () => 1_000,
  );
  let itemSequence = 0;
  const items = new ItemRepository(database, () =>
    ++itemSequence === 1 ? "item" : `item-${itemSequence}`,
  );
  const enrichments = new ItemEnrichmentRepository(database, () => 2_000);
  let quoteSequence = 0;
  const states = new ReaderStateRepository(
    database,
    () => `quote-${++quoteSequence}`,
    (() => {
      let now = 3_000;
      return () => ++now;
    })(),
  );
  subscriptions.create({
    adapter: "rss",
    sourceKey: "https://example.com/feed.xml",
    sourceUrl: "https://example.com/feed.xml",
    pollIntervalMinutes: 60,
    nextPollAt: 1_000,
  });
  items.recordEvent({
    subscriptionId: "subscription",
    item: {
      externalId: "article",
      url: "https://example.com/article",
      title: "Reader state article",
      contentText: "Opening context. Exact quoted passage. Closing context.",
    },
    cursor: {},
    eventAt: 1_000,
    notifyOnInsert: false,
  });
  const service = new DefaultReaderService(items, enrichments, client, states);
  return { database, subscriptions, items, states, service };
}

describe("Reader state and saved quotes", () => {
  test("persists read and favorite state across service instances", () => {
    const context = harness();
    expect(context.service.getState("item")).toMatchObject({
      isRead: false,
      isFavorite: false,
      readAt: null,
    });

    const read = context.service.markRead("item", true);
    expect(read.isRead).toBe(true);
    expect(read.readAt).toBeNumber();
    expect(context.service.setFavorite("item", true)).toMatchObject({
      isRead: true,
      isFavorite: true,
    });

    const restarted = new DefaultReaderService(
      context.items,
      new ItemEnrichmentRepository(context.database, () => 4_000),
      client,
      new ReaderStateRepository(context.database, undefined, () => 4_000),
    );
    expect(restarted.getState("item")).toMatchObject({ isRead: true, isFavorite: true });
    expect(restarted.markRead("item", false)).toMatchObject({ isRead: false, readAt: null });
    expect(restarted.setFavorite("item", false).isFavorite).toBe(false);

    context.database.close();
  });

  test("saves only exact source text and treats duplicate saves idempotently", () => {
    const context = harness();
    const created = context.service.saveQuote("item", {
      text: "Exact quoted passage.",
      note: "<script>note remains text</script>",
    });
    expect(created).toMatchObject({
      disposition: "created",
      quote: {
        id: "quote-1",
        exactText: "Exact quoted passage.",
        note: "<script>note remains text</script>",
        detached: false,
      },
    });
    expect(created.quote.prefixContext).toBe("Opening context. ");
    expect(created.quote.suffixContext).toBe(" Closing context.");

    const duplicate = context.service.saveQuote("item", {
      text: "Exact quoted passage.",
      note: "a replacement note must not create another row",
    });
    expect(duplicate).toMatchObject({ disposition: "existing", quote: { id: "quote-1" } });
    expect(context.service.listQuotes("item")).toHaveLength(1);

    expect(() =>
      context.service.saveQuote("item", { text: "Invented passage that is not in the article" }),
    ).toThrow("摘錄文字不存在於目前的文章正文");
    expect(() => context.service.saveQuote("item", { text: "   " })).toThrow(
      "摘錄文字必須介於 1 到 5000 個字元",
    );
    expect(() => context.service.saveQuote("item", { text: "Exact  quoted passage." })).toThrow(
      "摘錄文字不存在於目前的文章正文",
    );
    expect(() => context.service.saveQuote("item", { text: "x".repeat(5_001) })).toThrow(
      "摘錄文字必須介於 1 到 5000 個字元",
    );

    context.items.recordEvent({
      subscriptionId: "subscription",
      item: {
        externalId: "second-article",
        url: "https://example.com/second",
        title: "Second article",
        contentText: "This other item has unrelated text.",
      },
      cursor: {},
      eventAt: 2_000,
      notifyOnInsert: false,
    });
    expect(() => context.service.saveQuote("item-2", { text: "Exact quoted passage." })).toThrow(
      "摘錄文字不存在於目前的文章正文",
    );

    context.database.close();
  });

  test("keeps anchors through benign updates and labels missing text detached", () => {
    const context = harness();
    const saved = context.service.saveQuote("item", { text: "Exact quoted passage." });

    context.items.recordEvent({
      subscriptionId: "subscription",
      item: {
        externalId: "article",
        url: "https://example.com/article",
        title: "Reader state article",
        contentText: "A new introduction. Exact quoted passage. A changed ending.",
      },
      cursor: {},
      eventAt: 2_000,
      notifyOnInsert: false,
    });
    expect(context.service.listQuotes("item")[0]?.detached).toBe(false);

    context.items.recordEvent({
      subscriptionId: "subscription",
      item: {
        externalId: "article",
        url: "https://example.com/article",
        title: "Reader state article",
        contentText: "The source removed the saved passage.",
      },
      cursor: {},
      eventAt: 3_000,
      notifyOnInsert: false,
    });
    expect(context.service.listQuotes("item")[0]).toMatchObject({
      id: saved.quote.id,
      detached: true,
      exactText: "Exact quoted passage.",
    });

    context.database.close();
  });

  test("keeps browser-visible HTML line breaks in exact quote text", () => {
    const context = harness();
    context.items.recordEvent({
      subscriptionId: "subscription",
      item: {
        externalId: "line-break-article",
        url: "https://example.com/line-breaks",
        title: "分行文章",
        contentHtml: "<p>第一行<br>第二行</p>",
      },
      cursor: {},
      eventAt: 2_000,
      notifyOnInsert: false,
    });

    expect(context.service.getReadableText("item-2")).toBe("第一行\n第二行");
    expect(context.service.saveQuote("item-2", { text: "第一行\n第二行" })).toMatchObject({
      disposition: "created",
      quote: { detached: false },
    });
    expect(context.service.listQuotes("item-2")[0]?.detached).toBe(false);

    context.database.close();
  });

  test("matches browser selection across adjacent list items", () => {
    const context = harness();
    context.items.recordEvent({
      subscriptionId: "subscription",
      item: {
        externalId: "list-article",
        url: "https://example.com/list",
        title: "清單文章",
        contentHtml: "<ul><li>第一點</li><li>第二點</li></ul>",
      },
      cursor: {},
      eventAt: 2_000,
      notifyOnInsert: false,
    });

    expect(context.service.getReadableText("item-2")).toBe("第一點\n第二點");
    expect(context.service.saveQuote("item-2", { text: "第一點\r\n第二點" })).toMatchObject({
      disposition: "created",
      quote: { detached: false },
    });

    context.database.close();
  });

  test("retains item state and quotes after the subscription is removed", () => {
    const context = harness();
    context.service.markRead("item", true);
    context.service.setFavorite("item", true);
    const saved = context.service.saveQuote("item", { text: "Exact quoted passage." });
    context.subscriptions.softDelete("subscription");

    expect(context.service.get("item")).toMatchObject({
      item: { id: "item" },
      state: { isRead: true, isFavorite: true },
      quotes: [{ id: saved.quote.id, detached: false }],
    });
    expect(context.service.removeQuote(saved.quote.id)).toEqual({ id: saved.quote.id });
    expect(context.service.listQuotes()).toEqual([]);

    context.database.close();
  });
});
