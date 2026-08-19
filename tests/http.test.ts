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
const feedBody = `<rss version="2.0"><channel><title>Example</title><item><guid>item-1</guid><title>Example item</title><link>https://example.com/item-1</link><description>New item</description></item></channel></rss>`;

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
    expect(body.data.operations.map((operation) => operation.id)).toContain("routes.remove");
    expect(body.data.operations.find((operation) => operation.id === "probes.create")?.path).toBe(
      "/api/v1/probes",
    );
    expect(body.data.safety.confirmationRequiredFor).toContain("subscriptions.remove");
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
