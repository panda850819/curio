import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../src/app/create-app.ts";
import { migrate } from "../src/db/migrations.ts";
import type { TelegramTransport } from "../src/delivery/telegram.ts";
import { createHttpHandler, handleRequest } from "../src/http.ts";
import type { ProbeHttpClient } from "../src/probe/types.ts";
import { createEmailWebhookHandler } from "../src/sources/email/webhook.ts";

const migrationsPath = resolve(import.meta.dir, "../migrations");
const feedBody = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Example</title><item><guid>item-1</guid><title>Example item</title><link>https://example.com/item-1?token=secret</link><description>New item</description><content:encoded><![CDATA[<p>New item</p><script>unsafe()</script>]]></content:encoded></item></channel></rss>`;

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function apiHarness(withEmail = false) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  const probeClient: ProbeHttpClient = {
    get: async (url) => ({
      url,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/rss+xml" : null,
      },
      body: new TextEncoder().encode(feedBody),
    }),
  };
  const telegramTransport: TelegramTransport = {
    send: async () => ({
      status: 200,
      body: JSON.stringify({ ok: true, result: { message_id: 1 } }),
    }),
    getChat: async (_token, body) => ({
      status: 200,
      body: JSON.stringify({
        ok: true,
        result: {
          id: body.chat_id === "@example" ? -1001 : -1002,
          type: "channel",
          title: "Example",
        },
      }),
    }),
  };
  const app = createApp({
    database,
    migrationsPath,
    probeClient,
    telegram: { botToken: "secret-bot-token", chatId: "@default" },
    telegramTransport,
    email: withEmail
      ? { address: "reader@inbox.example.com", webhookSecret: "email-secret" }
      : undefined,
  });
  const events: unknown[] = [];
  const handler = createHttpHandler({
    services: app.services,
    emailWebhook:
      withEmail && app.emailSource
        ? createEmailWebhookHandler("email-secret", app.emailSource)
        : undefined,
    log: (event) => events.push(event),
  });
  return {
    database,
    app,
    events,
    request: (request: Request) => handler(request),
  };
}

describe("HTTP handler", () => {
  test("returns a minimal health response", async () => {
    const response = handleRequest(new Request("http://curio.test/health"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", service: "curio" });
    expect(body).not.toHaveProperty("databasePath");
  });

  test("exposes an agent manifest without runtime secrets", async () => {
    const context = apiHarness();
    const response = await context.request(new Request("http://curio.test/api/v1/agent/manifest"));
    const body = (await response.json()) as {
      data: {
        manifestVersion: string;
        service: string;
        operations: Array<{ id: string; path: string }>;
        safety: { secretsNeverReturned: string[]; confirmationRequiredFor: string[] };
      };
    };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ manifestVersion: "1", service: "curio" });
    expect(body.data.operations.map((operation) => operation.id)).toContain("probes.create");
    expect(body.data.operations.map((operation) => operation.id)).toContain("subscriptions.ensure");
    expect(body.data.operations.map((operation) => operation.id)).toContain("routes.remove");
    expect(body.data.operations.map((operation) => operation.id)).toContain("items.get");
    expect(body.data.operations.map((operation) => operation.id)).toContain("items.enrich");
    expect(body.data.operations.map((operation) => operation.id)).toContain("quotes.create");
    expect(body.data.operations.map((operation) => operation.id)).toContain("quotes.remove");
    expect(body.data.operations.find((operation) => operation.id === "probes.create")?.path).toBe(
      "/api/v1/probes",
    );
    expect(body.data.safety.confirmationRequiredFor).toContain("subscriptions.remove");
    expect(body.data.safety.confirmationRequiredFor).toContain("items.enrich");
    expect(body.data.safety.confirmationRequiredFor).toContain("items.mark_read");
    expect(body.data.safety.confirmationRequiredFor).toContain("quotes.create");
    expect(body.data.safety.confirmationRequiredFor).toContain("quotes.remove");
    expect(body.data.safety.secretsNeverReturned).toContain("TELEGRAM_BOT_TOKEN");
    expect(body.data.safety.secretsNeverReturned).toContain("GITHUB_TOKEN");
    expect(JSON.stringify(body)).not.toContain("secret-bot-token");

    const method = await context.request(
      new Request("http://curio.test/api/v1/agent/manifest", { method: "POST" }),
    );
    expect(method.status).toBe(405);

    context.app.close();
    context.database.close();
  });

  test("returns JSON 404 for unknown paths", async () => {
    const response = handleRequest(new Request("http://curio.test/missing"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
  });

  test("uses a safe request ID and emits a structured request log", async () => {
    const events: unknown[] = [];
    const handler = createHttpHandler({
      createRequestId: () => "generated-request",
      now: (() => {
        let value = 1_000;
        return () => {
          value += 5;
          return value;
        };
      })(),
      log: (event) => events.push(event),
    });

    const response = handler(
      new Request("http://curio.test/health?token=secret", {
        headers: { "x-request-id": "client-request_1" },
      }),
    );
    expect(response).toBeInstanceOf(Response);
    const resolved = await response;

    expect(resolved.headers.get("x-request-id")).toBe("client-request_1");
    expect(events).toEqual([
      {
        level: "info",
        message: "http_request_completed",
        requestId: "client-request_1",
        method: "GET",
        path: "/health",
        status: 200,
        durationMs: 10,
      },
    ]);
  });

  test("serves the management API through application services", async () => {
    const context = apiHarness();
    const probeResponse = await context.request(
      jsonRequest("http://curio.test/api/v1/probes", "POST", { url: "https://example.com/feed" }),
    );
    expect(probeResponse.status).toBe(200);
    const probeBody = (await probeResponse.json()) as {
      data: { candidates: [Record<string, unknown>] };
    };
    const candidate = probeBody.data.candidates[0];
    const followResponse = await context.request(
      jsonRequest("http://curio.test/api/v1/subscriptions", "POST", {
        candidate,
        pollIntervalMinutes: 60,
        metadata: { backfillLimit: 20, initialDeliveryLimit: 1 },
      }),
    );
    expect(followResponse.status).toBe(201);
    const subscriptionBody = (await followResponse.json()) as {
      data: { subscription: { id: string }; disposition: string };
    };
    const subscriptionId = subscriptionBody.data.subscription.id;
    expect(subscriptionBody.data.disposition).toBe("created");

    const destinationResponse = await context.request(
      jsonRequest("http://curio.test/api/v1/destinations", "POST", {
        destinationKey: "telegram-example",
        kind: "telegram",
        config: { chatId: "@example" },
      }),
    );
    expect(destinationResponse.status).toBe(201);
    const destinationBody = (await destinationResponse.json()) as {
      data: { id: string; config: Record<string, unknown> };
    };
    const destinationId = destinationBody.data.id;

    const routeResponse = await context.request(
      jsonRequest("http://curio.test/api/v1/routes", "POST", {
        subscriptionId,
        destinationId,
      }),
    );
    expect(routeResponse.status).toBe(201);
    const routeBody = (await routeResponse.json()) as { data: { id: string } };
    expect(routeBody.data.id).toBeString();

    const subscriptionGet = await context.request(
      new Request(`http://curio.test/api/v1/subscriptions/${subscriptionId}`),
    );
    expect(subscriptionGet.status).toBe(200);
    expect(await subscriptionGet.json()).toMatchObject({
      data: { id: subscriptionId, metadata: { backfillLimit: 20, initialDeliveryLimit: 1 } },
    });

    const verifyResponse = await context.request(
      new Request(`http://curio.test/api/v1/destinations/${destinationId}/verify`, {
        method: "POST",
      }),
    );
    expect(verifyResponse.status).toBe(200);
    const verifyText = await verifyResponse.text();
    expect(verifyText).toContain("Example");
    expect(verifyText).not.toContain("secret-bot-token");

    const pollResponse = await context.request(
      new Request(`http://curio.test/api/v1/subscriptions/${subscriptionId}/poll`, {
        method: "POST",
      }),
    );
    expect(pollResponse.status).toBe(200);
    expect(await pollResponse.json()).toMatchObject({
      data: { status: "fetched", insertedItems: 1 },
    });
    expect(context.app.deliveryRepository.list()).toHaveLength(1);
    expect(context.app.deliveryRepository.list()[0]?.destinationId).toBe(destinationId);

    const itemId = context.app.services.subscriptions.listItemsPage(10).items[0]?.id ?? "";
    const subscriptionTimeline = await context.request(
      new Request(`http://curio.test/api/v1/subscriptions/${subscriptionId}/items`),
    );
    const subscriptionTimelineText = await subscriptionTimeline.text();
    expect(subscriptionTimelineText).not.toContain("contentHtml");
    expect(subscriptionTimelineText).not.toContain("unsafe()");
    expect(subscriptionTimelineText).not.toContain("token=secret");

    const safeTimeline = await context.request(new Request("http://curio.test/api/v1/items"));
    const safeTimelineText = await safeTimeline.text();
    expect(safeTimelineText).toContain("credentials-redacted");
    expect(safeTimelineText).not.toContain("token=secret");
    expect(safeTimelineText).not.toContain("contentHtml");
    expect(safeTimelineText).not.toContain("unsafe()");
    const safeItem = await context.request(new Request(`http://curio.test/api/v1/items/${itemId}`));
    expect(safeItem.status).toBe(200);
    const safeItemBody = (await safeItem.json()) as {
      data: {
        id: string;
        readableText: string;
        readableTextTruncated: boolean;
        readableTextRedacted: boolean;
        readerUrl: string;
        state: { isRead: boolean; isFavorite: boolean };
      };
    };
    expect(safeItemBody.data).toMatchObject({
      id: itemId,
      readableText: "New item",
      readableTextTruncated: false,
      readableTextRedacted: false,
      readerUrl: `/reader/items/${itemId}`,
      state: { isRead: false, isFavorite: false },
    });
    expect(JSON.stringify(safeItemBody)).not.toContain("contentHtml");
    expect(JSON.stringify(safeItemBody)).not.toContain("unsafe()");

    const enrichment = await context.request(
      jsonRequest(`http://curio.test/api/v1/items/${itemId}/enrich`, "POST", {}),
    );
    expect(enrichment.status).toBe(409);
    expect(await enrichment.json()).toMatchObject({
      error: { code: "item_content_already_available" },
    });
    const invalidEnrichment = await context.request(
      jsonRequest(`http://curio.test/api/v1/items/${itemId}/enrich`, "POST", {
        unexpected: true,
      }),
    );
    expect(invalidEnrichment.status).toBe(400);
    expect(await invalidEnrichment.json()).toMatchObject({ error: { code: "unknown_field" } });

    const initialState = await context.request(
      new Request(`http://curio.test/api/v1/items/${itemId}/reader-state`),
    );
    expect(await initialState.json()).toMatchObject({
      data: { isRead: false, isFavorite: false },
    });
    const updatedState = await context.request(
      jsonRequest(`http://curio.test/api/v1/items/${itemId}/reader-state`, "PATCH", {
        isRead: true,
        isFavorite: true,
      }),
    );
    expect(updatedState.status).toBe(200);
    expect(await updatedState.json()).toMatchObject({
      data: { isRead: true, isFavorite: true },
    });

    const quoteResponse = await context.request(
      jsonRequest(`http://curio.test/api/v1/items/${itemId}/quotes`, "POST", {
        text: "New item",
        note: "API note",
      }),
    );
    expect(quoteResponse.status).toBe(201);
    const quoteBody = (await quoteResponse.json()) as {
      data: { quote: { id: string; exactText: string }; disposition: string };
    };
    expect(quoteBody.data).toMatchObject({
      disposition: "created",
      quote: { exactText: "New item" },
    });
    const duplicateQuote = await context.request(
      jsonRequest(`http://curio.test/api/v1/items/${itemId}/quotes`, "POST", {
        text: "New item",
      }),
    );
    expect(duplicateQuote.status).toBe(200);
    expect(await duplicateQuote.json()).toMatchObject({ data: { disposition: "existing" } });
    const fabricatedQuote = await context.request(
      jsonRequest(`http://curio.test/api/v1/items/${itemId}/quotes`, "POST", {
        text: "Fabricated quote",
      }),
    );
    expect(fabricatedQuote.status).toBe(400);
    expect(await fabricatedQuote.json()).toMatchObject({
      error: { code: "quote_text_not_found" },
    });
    const quotes = await context.request(
      new Request(`http://curio.test/api/v1/quotes?itemId=${encodeURIComponent(itemId)}`),
    );
    const quotesText = await quotes.text();
    expect(JSON.parse(quotesText)).toMatchObject({
      data: [
        {
          id: quoteBody.data.quote.id,
          detached: false,
          sourceUrl: "https://example.com/item-1?credentials-redacted",
          readerUrl: `/reader/items/${itemId}`,
        },
      ],
    });
    expect(quotesText).not.toContain("token=secret");
    const removedQuote = await context.request(
      new Request(`http://curio.test/api/v1/quotes/${quoteBody.data.quote.id}`, {
        method: "DELETE",
      }),
    );
    expect(removedQuote.status).toBe(200);
    expect(await removedQuote.json()).toEqual({ data: { id: quoteBody.data.quote.id } });

    context.database
      .query<never, [string, string]>("UPDATE items SET content_html = ? WHERE id = ?")
      .run("<p>Read https://name:password@example.com/private?token=secret safely.</p>", itemId);
    const credentialTextItem = await context.request(
      new Request(`http://curio.test/api/v1/items/${itemId}`),
    );
    const credentialText = await credentialTextItem.text();
    expect(JSON.parse(credentialText)).toMatchObject({
      data: { readableTextRedacted: true },
    });
    expect(credentialText).toContain("credentials-redacted");
    expect(credentialText).not.toContain("name:password");
    expect(credentialText).not.toContain("token=secret");

    context.database
      .query<never, [string, string]>("UPDATE items SET content_html = ? WHERE id = ?")
      .run(`<p>${"x".repeat(50_100)}</p>`, itemId);
    const boundedItem = await context.request(
      new Request(`http://curio.test/api/v1/items/${itemId}`),
    );
    const boundedBody = (await boundedItem.json()) as {
      data: { readableText: string; readableTextTruncated: boolean };
    };
    expect(boundedBody.data.readableText).toHaveLength(50_000);
    expect(boundedBody.data.readableTextTruncated).toBe(true);
    expect(JSON.stringify(boundedBody)).not.toContain("contentHtml");

    context.app.close();
    context.database.close();
  });

  test("creates or resolves a subscription directly from a URL", async () => {
    const context = apiHarness();
    const first = await context.request(
      jsonRequest("http://curio.test/api/v1/subscriptions/ensure", "POST", {
        url: "https://example.com/feed",
        pollIntervalMinutes: 30,
        metadata: { backfillLimit: 10 },
      }),
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      data: {
        subscription: {
          id: string;
          pollIntervalMinutes: number;
          metadata: Record<string, unknown>;
        };
        disposition: string;
        candidate: { adapter: string; sourceUrl: string };
        warnings: unknown[];
      };
    };
    expect(firstBody.data).toMatchObject({
      disposition: "created",
      candidate: { adapter: "rss", sourceUrl: "https://example.com/feed" },
      warnings: [],
      subscription: { pollIntervalMinutes: 30, metadata: { backfillLimit: 10 } },
    });

    const second = await context.request(
      jsonRequest("http://curio.test/api/v1/subscriptions/ensure", "POST", {
        url: "https://example.com/feed",
      }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      data: {
        disposition: "existing",
        subscription: { id: firstBody.data.subscription.id },
      },
    });

    context.app.close();
    context.database.close();
  });

  test("exposes the shared email inbox and accepts inbound mail", async () => {
    const context = apiHarness(true);
    const inbox = await context.request(new Request("http://curio.test/api/v1/email/inbox"));
    expect(inbox.status).toBe(200);
    expect(await inbox.json()).toMatchObject({
      data: {
        address: "reader@inbox.example.com",
        subscription: { adapter: "email", sourceKey: "shared-inbox" },
      },
    });

    const inbound = await context.request(
      new Request("http://curio.test/email/inbound", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-curio-email-secret": "email-secret",
        },
        body: JSON.stringify({
          to: "reader@inbox.example.com",
          from: "news@example.com",
          subject: "Inbox item",
          messageId: "<inbox-item@example.com>",
          text: "Hello from email",
        }),
      }),
    );
    expect(inbound.status).toBe(200);
    expect(await inbound.json()).toEqual({ ok: true, status: "inserted" });
    expect(context.app.services.subscriptions.listItemsPage(20).items).toHaveLength(1);

    context.app.close();
    context.database.close();
  });

  test("validates API bodies, maps conflicts, and paginates lists", async () => {
    const context = apiHarness();
    const malformed = await context.request(
      new Request("http://curio.test/api/v1/probes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "malformed_json" } });

    const oversized = await context.request(
      jsonRequest("http://curio.test/api/v1/probes", "POST", { url: "x".repeat(70_000) }),
    );
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: { code: "body_too_large" } });

    const unknownField = await context.request(
      jsonRequest("http://curio.test/api/v1/destinations", "POST", {
        destinationKey: "one",
        kind: "telegram",
        config: { chatId: "@one" },
        token: "must-not-be-accepted",
      }),
    );
    expect(unknownField.status).toBe(400);
    expect(await unknownField.text()).not.toContain("must-not-be-accepted");

    const invalidConfig = await context.request(
      jsonRequest("http://curio.test/api/v1/destinations", "POST", {
        destinationKey: "invalid",
        kind: "telegram",
        config: { botToken: "must-not-be-stored" },
      }),
    );
    expect(invalidConfig.status).toBe(400);
    expect(await invalidConfig.text()).not.toContain("must-not-be-stored");

    const first = await context.request(
      jsonRequest("http://curio.test/api/v1/destinations", "POST", {
        destinationKey: "one",
        kind: "telegram",
        config: { chatId: "@one" },
      }),
    );
    const second = await context.request(
      jsonRequest("http://curio.test/api/v1/destinations", "POST", {
        destinationKey: "two",
        kind: "telegram",
        config: { chatId: "@two" },
      }),
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const firstPage = await context.request(
      new Request("http://curio.test/api/v1/destinations?limit=1"),
    );
    const firstPageBody = (await firstPage.json()) as {
      data: { items: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(firstPageBody.data.items).toHaveLength(1);
    expect(firstPageBody.data.nextCursor).toBeString();
    const nextPage = await context.request(
      new Request(
        `http://curio.test/api/v1/destinations?limit=1&cursor=${encodeURIComponent(firstPageBody.data.nextCursor as string)}`,
      ),
    );
    const nextPageBody = (await nextPage.json()) as { data: { items: Array<{ id: string }> } };
    expect(nextPageBody.data.items).toHaveLength(1);
    expect(nextPageBody.data.items[0]?.id).not.toBe(firstPageBody.data.items[0]?.id);

    const duplicate = await context.request(
      jsonRequest("http://curio.test/api/v1/destinations", "POST", {
        destinationKey: "one",
        kind: "telegram",
        config: { chatId: "@one" },
      }),
    );
    expect(duplicate.status).toBe(409);
    const missing = await context.request(
      new Request("http://curio.test/api/v1/subscriptions/missing"),
    );
    expect(missing.status).toBe(404);
    const method = await context.request(
      new Request("http://curio.test/api/v1/deliveries", { method: "POST" }),
    );
    expect(method.status).toBe(405);
    expect(
      context.events.every((event) => !JSON.stringify(event).includes("secret-bot-token")),
    ).toBe(true);

    context.app.close();
    context.database.close();
  });
});
