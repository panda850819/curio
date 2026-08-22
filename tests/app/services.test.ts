import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../../src/app/create-app.ts";
import { DefaultSubscriptionService } from "../../src/app/subscription-service.ts";
import { migrate } from "../../src/db/migrations.ts";
import { SubscriptionRepository } from "../../src/db/repositories.ts";
import type { ProbeHttpClient, ProbeResult, SubscriptionCandidate } from "../../src/probe/types.ts";
import type { SourcePoller } from "../../src/scheduler.ts";

const migrationsPath = resolve(import.meta.dir, "../../migrations");

function createDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  return database;
}

const emptyProbeClient: ProbeHttpClient = {
  get: async () => ({
    url: "https://example.com",
    status: 200,
    headers: { get: () => "text/html" },
    body: new TextEncoder().encode("<html></html>"),
  }),
};

const candidate = {
  adapter: "rss" as const,
  format: "rss" as const,
  sourceUrl: "https://example.com/feed.xml",
  sourceKey: "https://example.com/feed.xml",
  title: "Example feed",
  discoveredVia: "direct" as const,
};

describe("application services", () => {
  test("subscribes from one URL with one probe and preserves idempotency", async () => {
    const database = createDatabase();
    const probeResults: ProbeResult[] = [];
    const probeCalls: string[] = [];
    const probeService = {
      probe: async (inputUrl: string) => {
        probeCalls.push(inputUrl);
        const result = probeResults.shift();
        if (!result) throw new Error("missing probe fixture");
        return { ...result, inputUrl };
      },
    };
    const poller: SourcePoller = {
      poll: async () => ({ status: "fetched", insertedItems: 0, duplicateItems: 0 }),
    };
    const subscriptions = new SubscriptionRepository(database, undefined, () => 1_000);
    const service = new DefaultSubscriptionService(
      subscriptions,
      poller,
      () => 1_000,
      probeService,
    );
    const url = "https://example.com/feed.xml";
    const probedCandidate: SubscriptionCandidate = {
      ...candidate,
      title: "Probed example",
    };
    probeResults.push({
      inputUrl: url,
      finalUrl: url,
      candidates: [probedCandidate],
      warnings: [{ code: "candidate_limit", message: "fixture warning" }],
    });

    const created = await service.followFromUrl({
      url,
      intervalMinutes: 60,
      metadata: { backfillLimit: 10 },
    });

    expect(created).toMatchObject({
      disposition: "created",
      candidate: probedCandidate,
      warnings: [{ code: "candidate_limit" }],
      subscription: { sourceKey: candidate.sourceKey, metadata: { backfillLimit: 10 } },
    });
    expect(probeCalls).toEqual([url]);

    probeResults.push({
      inputUrl: url,
      finalUrl: url,
      candidates: [probedCandidate],
      warnings: [],
    });
    const existing = await service.followFromUrl({ url, intervalMinutes: 60 });
    expect(existing).toMatchObject({
      disposition: "existing",
      subscription: { id: created.subscription.id },
    });
    expect(probeCalls).toEqual([url, url]);

    database.close();
  });

  test("rejects URLs with no candidate or multiple candidates", async () => {
    const database = createDatabase();
    let probeResult: ProbeResult = {
      inputUrl: "https://example.com",
      finalUrl: "https://example.com",
      candidates: [],
      warnings: [],
    };
    const probeService = { probe: async () => probeResult };
    const poller: SourcePoller = {
      poll: async () => ({ status: "fetched", insertedItems: 0, duplicateItems: 0 }),
    };
    const service = new DefaultSubscriptionService(
      new SubscriptionRepository(database, undefined, () => 1_000),
      poller,
      () => 1_000,
      probeService,
    );

    await expect(
      service.followFromUrl({ url: "https://example.com", intervalMinutes: 60 }),
    ).rejects.toMatchObject({ code: "subscription_candidate_not_found" });

    probeResult = {
      ...probeResult,
      candidates: [candidate, { ...candidate, sourceKey: "https://example.com/other.xml" }],
    };
    await expect(
      service.followFromUrl({ url: "https://example.com", intervalMinutes: 60 }),
    ).rejects.toMatchObject({
      code: "subscription_candidates_ambiguous",
      details: { candidates: probeResult.candidates },
    });

    database.close();
  });

  test("share composition-root repositories and preserve follow lifecycle behavior", async () => {
    const database = createDatabase();
    const polls: string[] = [];
    const poller: SourcePoller = {
      poll: async (subscriptionId) => {
        polls.push(subscriptionId);
        return { status: "fetched", insertedItems: 0, duplicateItems: 0 };
      },
    };
    const app = createApp({
      database,
      migrationsPath,
      probeClient: emptyProbeClient,
      sourcePollers: { rss: poller },
      now: () => 1_000,
    });

    const created = app.services.subscriptions.follow({ candidate, intervalMinutes: 60 });
    const existing = app.services.subscriptions.follow({ candidate, intervalMinutes: 60 });

    expect(created.disposition).toBe("created");
    expect(existing).toMatchObject({
      disposition: "existing",
      subscription: { id: created.subscription.id },
    });
    expect(app.services.subscriptions.resolve(candidate.sourceUrl).id).toBe(
      created.subscription.id,
    );
    expect(await app.services.subscriptions.poll(created.subscription.id)).toEqual({
      status: "fetched",
      insertedItems: 0,
      duplicateItems: 0,
    });
    expect(polls).toEqual([created.subscription.id]);

    expect(app.services.subscriptions.pause(created.subscription.id).enabled).toBe(false);
    expect(app.services.subscriptions.resume(created.subscription.id).enabled).toBe(true);
    expect(app.services.subscriptions.remove(created.subscription.id)).toEqual({
      id: created.subscription.id,
    });
    expect(() => app.services.subscriptions.get(created.subscription.id)).toThrow(
      "Subscription not found",
    );

    app.close();
    database.close();
  });

  test("maps missing and invalid application inputs to typed errors", () => {
    const database = createDatabase();
    const app = createApp({ database, migrationsPath, probeClient: emptyProbeClient });

    expect(() => app.services.subscriptions.get("missing")).toThrow("Subscription not found");
    expect(() => app.services.subscriptions.follow({ candidate, intervalMinutes: 4 })).toThrow(
      "poll interval must be an integer between 5 and 10080 minutes",
    );
    expect(() => app.services.deliveries.retry("missing")).toThrow("Delivery not found");

    app.close();
    database.close();
  });
});
