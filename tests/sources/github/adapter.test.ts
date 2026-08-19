import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migrate } from "../../../src/db/migrations.ts";
import { ItemRepository, SubscriptionRepository } from "../../../src/db/repositories.ts";
import { DeliveryRepository } from "../../../src/delivery/repository.ts";
import type { HttpHeaders, HttpResponse, ProbeHttpClient } from "../../../src/probe/types.ts";
import { GithubSourceAdapter } from "../../../src/sources/github/adapter.ts";

const migrationsPath = resolve(import.meta.dir, "../../../migrations");

class Headers implements HttpHeaders {
  constructor(private readonly values: Record<string, string>) {}

  get(name: string): string | null {
    return this.values[name.toLowerCase()] ?? null;
  }
}

interface RecordedRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
}

class FakeClient implements ProbeHttpClient {
  readonly requests: RecordedRequest[] = [];

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

interface ReleaseOptions {
  id: number;
  tag?: string;
  name?: string | null;
  updatedAt?: string;
  publishedAt?: string | null;
  body?: string | null;
}

function release(options: ReleaseOptions): Record<string, unknown> {
  const tag = options.tag ?? `v${options.id}`;
  const createdAt = options.publishedAt ?? "2026-08-15T00:00:00Z";
  return {
    id: options.id,
    node_id: `RE_node_${options.id}`,
    tag_name: tag,
    name: options.name === undefined ? `Release ${options.id}` : options.name,
    html_url: `https://github.com/cli/cli/releases/tag/${tag}`,
    published_at: options.publishedAt === undefined ? createdAt : options.publishedAt,
    created_at: createdAt,
    updated_at: options.updatedAt ?? createdAt,
    draft: false,
    prerelease: false,
    body: options.body ?? `Body ${options.id}`,
    author: { login: "octocat" },
  };
}

function response(
  body: unknown,
  options: {
    url?: string;
    status?: number;
    etag?: string;
    link?: string;
    retryAfter?: string;
    rateLimitReset?: string;
    contentType?: string;
  } = {},
): HttpResponse {
  const values: Record<string, string> = {
    "content-type": options.contentType ?? "application/json",
  };
  if (options.etag) values.etag = options.etag;
  if (options.link) values.link = options.link;
  if (options.retryAfter) values["retry-after"] = options.retryAfter;
  if (options.rateLimitReset) values["x-ratelimit-reset"] = options.rateLimitReset;
  return {
    url: options.url ?? "https://api.github.com/repos/cli/cli/releases?per_page=100",
    status: options.status ?? 200,
    headers: new Headers(values),
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function setup(metadata: Record<string, number> = {}) {
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
  const subscription = subscriptions.create({
    adapter: "github",
    sourceKey: "cli/cli",
    sourceUrl: "https://github.com/cli/cli",
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

describe("GithubSourceAdapter", () => {
  test("backfills releases, uses ETag, updates edits, and avoids duplicate delivery", async () => {
    const context = setup({ backfillLimit: 2, initialDeliveryLimit: 1 });
    new DeliveryRepository(
      context.database,
      () => "destination-1",
      () => 500,
    ).syncTelegramDestination("@channel");
    const client = new FakeClient([
      response(
        [
          release({ id: 3, publishedAt: "2026-08-18T00:00:00Z" }),
          release({ id: 2, publishedAt: "2026-08-17T00:00:00Z" }),
          release({ id: 1, publishedAt: "2026-08-16T00:00:00Z" }),
        ],
        { etag: '"version-1"' },
      ),
      response(
        [
          release({ id: 4, publishedAt: "2026-08-19T00:00:00Z" }),
          release({
            id: 3,
            name: "Release 3 edited",
            publishedAt: "2026-08-18T00:00:00Z",
            updatedAt: "2026-08-19T01:00:00Z",
          }),
          release({ id: 2, publishedAt: "2026-08-17T00:00:00Z" }),
        ],
        { etag: '"version-2"' },
      ),
      response([], { status: 304, etag: '"version-2"' }),
    ]);
    const adapter = new GithubSourceAdapter(
      client,
      context.subscriptions,
      context.items,
      context.now,
    );

    const first = await adapter.poll(context.subscription.id);
    expect(first).toMatchObject({ status: "fetched", insertedItems: 2, duplicateItems: 0 });
    expect(context.items.listBySubscription(context.subscription.id, 100)).toHaveLength(2);
    expect(
      context.database
        .query<{ external_id: string }, []>(
          "SELECT i.external_id FROM deliveries d JOIN items i ON i.id = d.item_id ORDER BY d.created_at",
        )
        .all()
        .map((row) => row.external_id),
    ).toEqual(["3"]);

    context.setNow(2_000);
    const second = await adapter.poll(context.subscription.id);
    expect(second).toMatchObject({ status: "fetched", insertedItems: 1, duplicateItems: 1 });
    expect(context.items.listBySubscription(context.subscription.id, 100)).toHaveLength(3);
    expect(
      context.items
        .listBySubscription(context.subscription.id, 100)
        .find((item) => item.externalId === "3"),
    ).toMatchObject({ title: "Release 3 edited" });
    expect(
      context.database
        .query<{ external_id: string }, []>(
          "SELECT i.external_id FROM deliveries d JOIN items i ON i.id = d.item_id ORDER BY d.created_at",
        )
        .all()
        .map((row) => row.external_id),
    ).toEqual(["3", "4"]);

    context.setNow(3_000);
    const third = await adapter.poll(context.subscription.id);
    expect(third).toMatchObject({ status: "not_modified", insertedItems: 0, duplicateItems: 0 });
    expect(client.requests[0]?.headers).toEqual({ Accept: "application/vnd.github+json" });
    expect(client.requests[1]?.headers).toEqual({
      Accept: "application/vnd.github+json",
      "If-None-Match": '"version-1"',
    });
    expect(client.requests[2]?.headers).toEqual({
      Accept: "application/vnd.github+json",
      "If-None-Match": '"version-2"',
    });
    expect(
      context.items
        .listBySubscription(context.subscription.id)
        .find((item) => item.externalId === "3")?.metadata,
    ).toMatchObject({
      github: {
        repository: "cli/cli",
        kind: "release",
        id: 3,
        nodeId: "RE_node_3",
        tagName: "v3",
        draft: false,
        prerelease: false,
      },
    });
    context.database.close();
  });

  test("sends an optional token without persisting it", async () => {
    const context = setup({ backfillLimit: 0 });
    const client = new FakeClient([response([])]);
    const adapter = new GithubSourceAdapter(
      client,
      context.subscriptions,
      context.items,
      context.now,
      "ghp_test-token",
    );

    await adapter.poll(context.subscription.id);

    expect(client.requests[0]?.headers).toEqual({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer ghp_test-token",
    });
    expect(
      JSON.stringify(context.subscriptions.findById(context.subscription.id)?.cursor),
    ).not.toContain("ghp_test-token");
    context.database.close();
  });

  test("follows GitHub Link pagination without persisting a page cursor", async () => {
    const context = setup({ backfillLimit: 20, initialDeliveryLimit: 0 });
    const secondPage = "https://api.github.com/repos/cli/cli/releases?per_page=100&page=2";
    const client = new FakeClient([
      response([release({ id: 2, publishedAt: "2026-08-17T00:00:00Z" })], {
        etag: '"version-1"',
        link: `<${secondPage}>; rel="next", <https://api.github.com/repos/cli/cli/releases?per_page=100&page=2>; rel="last"`,
      }),
      response([release({ id: 1, publishedAt: "2026-08-16T00:00:00Z" })], {
        url: secondPage,
      }),
    ]);
    const adapter = new GithubSourceAdapter(
      client,
      context.subscriptions,
      context.items,
      context.now,
    );

    const result = await adapter.poll(context.subscription.id);

    expect(result).toMatchObject({ insertedItems: 2, duplicateItems: 0 });
    expect(client.requests.map((request) => request.url)).toEqual([
      "https://api.github.com/repos/cli/cli/releases?per_page=100",
      secondPage,
    ]);
    expect(client.requests[1]?.headers).toEqual({ Accept: "application/vnd.github+json" });
    expect(context.subscriptions.findById(context.subscription.id)?.cursor).toMatchObject({
      etag: '"version-1"',
    });
    expect(
      JSON.stringify(context.subscriptions.findById(context.subscription.id)?.cursor),
    ).not.toContain("page");
    context.database.close();
  });

  test("honors rate-limit retry headers instead of using aggressive retry backoff", async () => {
    const context = setup();
    const client = new FakeClient([
      response({ message: "rate limited" }, { status: 429, retryAfter: "120" }),
    ]);
    const adapter = new GithubSourceAdapter(
      client,
      context.subscriptions,
      context.items,
      context.now,
    );

    await expect(adapter.poll(context.subscription.id)).rejects.toThrow("HTTP 429");
    expect(context.subscriptions.findById(context.subscription.id)).toMatchObject({
      nextPollAt: 121_000,
      consecutiveFailures: 1,
    });
    expect(context.items.listBySubscription(context.subscription.id)).toEqual([]);
    context.database.close();
  });

  test("uses the rate-limit reset boundary for a 403 response", async () => {
    const context = setup();
    context.setNow(2_000);
    const client = new FakeClient([
      response({ message: "rate limited" }, { status: 403, rateLimitReset: "10" }),
    ]);
    const adapter = new GithubSourceAdapter(
      client,
      context.subscriptions,
      context.items,
      context.now,
    );

    await expect(adapter.poll(context.subscription.id)).rejects.toThrow("HTTP 403");
    expect(context.subscriptions.findById(context.subscription.id)?.nextPollAt).toBe(10_000);
    context.database.close();
  });
});
