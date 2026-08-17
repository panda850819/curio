import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../../../src/app/create-app.ts";
import { migrate } from "../../../src/db/migrations.ts";
import type { ProbeHttpClient } from "../../../src/probe/types.ts";

const migrationsPath = resolve(import.meta.dir, "../../../migrations");
const pageUrl = "https://example.com/monitor";

function harness(
  initialBody: string,
  options: { selector?: string; notifyOnFirstPoll?: boolean } = {},
) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  let body = initialBody;
  let status = 200;
  let etag = '"v1"';
  const requests: Array<{ url: string; headers?: Readonly<Record<string, string>> }> = [];
  const client: ProbeHttpClient = {
    get: async (url, _maximumBytes, headers) => {
      requests.push({ url, headers });
      return {
        url,
        status,
        headers: {
          get: (name: string) => {
            if (name === "content-type") return "text/html; charset=utf-8";
            if (name === "etag") return etag;
            if (name === "last-modified") return "Wed, 01 Jan 2025 00:00:00 GMT";
            return null;
          },
        },
        body: new TextEncoder().encode(body),
      };
    },
  };
  const app = createApp({ database, migrationsPath, probeClient: client, now: () => 1_000 });
  const destination = app.services.destinations.create({
    destinationKey: "reading-room",
    kind: "telegram",
    config: { chatId: "@room" },
  });
  const subscription = app.services.subscriptions.follow({
    candidate: {
      adapter: "html",
      format: "html",
      sourceUrl: pageUrl,
      sourceKey: pageUrl,
      title: "Monitored page",
      discoveredVia: "direct",
    },
    intervalMinutes: 60,
    metadata: {
      ...(options.selector ? { selector: options.selector } : {}),
      ...(options.notifyOnFirstPoll ? { notifyOnFirstPoll: true } : {}),
    },
  }).subscription;
  app.services.routes.create({ subscriptionId: subscription.id, destinationId: destination.id });
  return {
    app,
    database,
    subscription,
    requests,
    setBody(next: string, nextEtag = etag) {
      body = next;
      etag = nextEtag;
      status = 200;
    },
    setNotModified() {
      status = 304;
    },
  };
}

const page = (value: string, noise = "100") =>
  `<html><head><title>Example monitor</title><script>window.time=${noise}</script></head><body><main id="main-${noise}" data-updated="${noise}"><article class="content updated-${noise}"><p>${value}</p></article></main><style>.content{}</style></body></html>`;

describe("HtmlSourceAdapter", () => {
  test("creates a quiet baseline, then exactly one item and delivery for a real change", async () => {
    const context = harness(page("same"), { selector: "main > article" });
    const baseline = await context.app.services.subscriptions.poll(context.subscription.id);
    expect(baseline.status).toBe("baseline");
    expect(
      context.app.services.subscriptions.listItemsPage(20, context.subscription.id).items,
    ).toHaveLength(1);
    expect(context.app.services.deliveries.list()).toHaveLength(0);

    context.setBody(page("same", "200"));
    const noiseOnly = await context.app.services.subscriptions.poll(context.subscription.id);
    expect(noiseOnly.status).toBe("not_modified");
    expect(
      context.app.services.subscriptions.listItemsPage(20, context.subscription.id).items,
    ).toHaveLength(1);

    context.setBody(page("changed", "300"), '"v2"');
    const changed = await context.app.services.subscriptions.poll(context.subscription.id);
    expect(changed.status).toBe("changed");
    expect(
      context.app.services.subscriptions.listItemsPage(20, context.subscription.id).items,
    ).toHaveLength(2);
    expect(context.app.services.deliveries.list()).toHaveLength(1);

    context.setBody(page("changed", "400"), '"v3"');
    await context.app.services.subscriptions.poll(context.subscription.id);
    expect(
      context.app.services.subscriptions.listItemsPage(20, context.subscription.id).items,
    ).toHaveLength(2);
    expect(context.app.services.deliveries.list()).toHaveLength(1);
    expect(context.requests[1]?.headers?.["If-None-Match"]).toBe('"v1"');

    context.app.close();
    context.database.close();
  });

  test("supports 304 and explicit notify-on-first-poll", async () => {
    const context = harness(page("baseline"), { notifyOnFirstPoll: true });
    const baseline = await context.app.services.subscriptions.poll(context.subscription.id);
    expect(baseline.status).toBe("baseline");
    expect(context.app.services.deliveries.list()).toHaveLength(1);
    context.setNotModified();
    const notModified = await context.app.services.subscriptions.poll(context.subscription.id);
    expect(notModified.status).toBe("not_modified");
    expect(context.app.services.deliveries.list()).toHaveLength(1);
    context.app.close();
    context.database.close();
  });

  test("records selector failures as durable subscription failures", async () => {
    const context = harness(page("value"), { selector: ".does-not-exist" });
    await expect(context.app.services.subscriptions.poll(context.subscription.id)).rejects.toThrow(
      "HTML selector did not match",
    );
    const subscription = context.app.services.subscriptions.get(context.subscription.id);
    expect(subscription.consecutiveFailures).toBe(1);
    expect(subscription.lastError).toContain("HTML selector did not match");
    expect(context.app.services.deliveries.list()).toHaveLength(1);
    context.app.close();
    context.database.close();
  });
});
