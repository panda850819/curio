import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migrate } from "../../../src/db/migrations.ts";
import { ItemRepository, SubscriptionRepository } from "../../../src/db/repositories.ts";
import { DeliveryRepository } from "../../../src/delivery/repository.ts";
import type { HttpHeaders, HttpResponse, ProbeHttpClient } from "../../../src/probe/types.ts";
import { GithubAtomSourceAdapter } from "../../../src/sources/github/atom-adapter.ts";

const migrationsPath = resolve(import.meta.dir, "../../../migrations");

class Headers implements HttpHeaders {
  constructor(private readonly values: Record<string, string>) {}

  get(name: string): string | null {
    return this.values[name.toLowerCase()] ?? null;
  }
}

class FakeClient implements ProbeHttpClient {
  readonly requests: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];

  constructor(private readonly responses: Array<HttpResponse | Error>) {}

  async get(
    url: string,
    _maximumBytes: (contentType: string | null) => number,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<HttpResponse> {
    this.requests.push({ url, headers });
    const response = this.responses.shift();
    if (!response) throw new Error("No fake response configured");
    if (response instanceof Error) throw response;
    return response;
  }
}

function releaseEntry(id: string, title: string, published: string, updated = published): string {
  return `<entry><title>${title}</title><id>${id}</id><link rel="alternate" href="https://github.com/cli/cli/releases/tag/${title}"/><published>${published}</published><updated>${updated}</updated><summary>Summary ${title}</summary></entry>`;
}

function commitEntry(sha: string, title: string, updated: string): string {
  return `<entry><title>${title}</title><id>tag:github.com,2008:Commit/${sha}</id><link rel="alternate" href="https://github.com/cli/cli/commit/${sha}"/><updated>${updated}</updated><summary>Summary ${title}</summary></entry>`;
}

function feed(entries: string): string {
  return `<feed xmlns="http://www.w3.org/2005/Atom"><title>GitHub</title><id>https://github.com/cli/cli</id><updated>2026-08-19T00:00:00Z</updated>${entries}</feed>`;
}

function response(
  body: string,
  options: { status?: number; etag?: string; lastModified?: string; contentType?: string } = {},
): HttpResponse {
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/atom+xml",
  };
  if (options.etag) headers.etag = options.etag;
  if (options.lastModified) headers["last-modified"] = options.lastModified;
  return {
    url: "https://github.com/cli/cli/releases.atom",
    status: options.status ?? 200,
    headers: new Headers(headers),
    body: new TextEncoder().encode(body),
  };
}

function setup(kind: "releases" | "commits" = "releases", metadata: Record<string, number> = {}) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  let subscriptionId = 0;
  let itemId = 0;
  let now = 1_000;
  const subscriptions = new SubscriptionRepository(
    database,
    () => `subscription-${++subscriptionId}`,
    () => now,
  );
  const items = new ItemRepository(database, () => `item-${++itemId}`);
  const sourceKey = kind === "releases" ? "cli/cli:releases" : "cli/cli:commits:main";
  const sourceUrl =
    kind === "releases"
      ? "https://github.com/cli/cli/releases.atom"
      : "https://github.com/cli/cli/commits/main.atom";
  const subscription = subscriptions.create({
    adapter: "github_atom",
    sourceKey,
    sourceUrl,
    metadata,
  });
  return {
    database,
    subscriptions,
    items,
    subscription,
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
  };
}

describe("GithubAtomSourceAdapter", () => {
  test("backfills releases, persists validators, updates changes, and handles 304", async () => {
    const context = setup("releases", { backfillLimit: 2, initialDeliveryLimit: 1 });
    new DeliveryRepository(
      context.database,
      () => "destination-1",
      () => 500,
    ).syncTelegramDestination("@channel");
    const release3 = "tag:github.com,2008:Release/3/v3";
    const release2 = "tag:github.com,2008:Release/2/v2";
    const release1 = "tag:github.com,2008:Release/1/v1";
    const client = new FakeClient([
      response(
        feed(
          releaseEntry(release3, "v3", "2026-08-18T00:00:00Z") +
            releaseEntry(release2, "v2", "2026-08-17T00:00:00Z") +
            releaseEntry(release1, "v1", "2026-08-16T00:00:00Z"),
        ),
        { etag: '"version-1"', lastModified: "Tue, 18 Aug 2026 00:00:00 GMT" },
      ),
      response(
        feed(
          releaseEntry("tag:github.com,2008:Release/4/v4", "v4", "2026-08-19T00:00:00Z") +
            releaseEntry(release3, "v3-edited", "2026-08-18T00:00:00Z", "2026-08-19T01:00:00Z") +
            releaseEntry(release2, "v2", "2026-08-17T00:00:00Z"),
        ),
        { etag: '"version-2"', lastModified: "Wed, 19 Aug 2026 01:00:00 GMT" },
      ),
      response("", { status: 304 }),
    ]);
    const adapter = new GithubAtomSourceAdapter(
      client,
      context.subscriptions,
      context.items,
      context.now,
    );

    const first = await adapter.poll(context.subscription.id);
    expect(first).toMatchObject({ status: "fetched", insertedItems: 2, duplicateItems: 0 });
    expect(
      context.database
        .query<{ external_id: string }, []>(
          "SELECT i.external_id FROM deliveries d JOIN items i ON i.id = d.item_id ORDER BY d.created_at",
        )
        .all()
        .map((row) => row.external_id),
    ).toEqual([release3]);

    context.setNow(2_000);
    const second = await adapter.poll(context.subscription.id);
    expect(second).toMatchObject({ status: "fetched", insertedItems: 1, duplicateItems: 1 });
    expect(
      context.items
        .listBySubscription(context.subscription.id, 100)
        .find((item) => item.externalId === release3),
    ).toMatchObject({ title: "v3-edited" });

    context.setNow(3_000);
    const third = await adapter.poll(context.subscription.id);
    expect(third).toMatchObject({ status: "not_modified", insertedItems: 0, duplicateItems: 0 });
    expect(client.requests[0]?.headers).toEqual({ Accept: "application/atom+xml" });
    expect(client.requests[1]?.headers).toEqual({
      Accept: "application/atom+xml",
      "If-None-Match": '"version-1"',
      "If-Modified-Since": "Tue, 18 Aug 2026 00:00:00 GMT",
    });
    expect(client.requests[2]?.headers).toEqual({
      Accept: "application/atom+xml",
      "If-None-Match": '"version-2"',
      "If-Modified-Since": "Wed, 19 Aug 2026 01:00:00 GMT",
    });
    expect(context.subscriptions.findById(context.subscription.id)?.cursor).toMatchObject({
      etag: '"version-2"',
      lastModified: "Wed, 19 Aug 2026 01:00:00 GMT",
    });
    context.database.close();
  });

  test("uses commit SHA as the item ID and stores branch metadata", async () => {
    const context = setup("commits", { backfillLimit: 20, initialDeliveryLimit: 1 });
    const firstSha = "0123456789abcdef0123456789abcdef01234567";
    const secondSha = "abcdef0123456789abcdef0123456789abcdef01";
    const client = new FakeClient([
      response(
        feed(
          commitEntry(secondSha, "Second commit", "2026-08-18T02:00:00Z") +
            commitEntry(firstSha, "First commit", "2026-08-18T01:00:00Z"),
        ),
      ),
    ]);
    const adapter = new GithubAtomSourceAdapter(
      client,
      context.subscriptions,
      context.items,
      context.now,
    );

    const result = await adapter.poll(context.subscription.id);

    expect(result).toMatchObject({ insertedItems: 2, duplicateItems: 0 });
    const item = context.items
      .listBySubscription(context.subscription.id, 100)
      .find((entry) => entry.externalId === firstSha);
    expect(item).toMatchObject({ externalId: firstSha });
    expect(item?.metadata).toMatchObject({
      github: {
        repository: "cli/cli",
        branch: "main",
        kind: "commit",
        commitSha: firstSha,
      },
    });
    expect(context.items.listBySubscription(context.subscription.id)).not.toContainEqual(
      expect.objectContaining({ externalId: `tag:github.com,2008:Commit/${firstSha}` }),
    );
    context.database.close();
  });

  test("does not insert an unchanged feed again", async () => {
    const context = setup("releases");
    const entry = releaseEntry("tag:github.com,2008:Release/1/v1", "v1", "2026-08-18T00:00:00Z");
    const client = new FakeClient([response(feed(entry)), response(feed(entry))]);
    const adapter = new GithubAtomSourceAdapter(
      client,
      context.subscriptions,
      context.items,
      context.now,
    );

    await adapter.poll(context.subscription.id);
    context.setNow(2_000);
    const result = await adapter.poll(context.subscription.id);

    expect(result).toMatchObject({ insertedItems: 0, duplicateItems: 0 });
    expect(context.items.listBySubscription(context.subscription.id)).toHaveLength(1);
    context.database.close();
  });
});
