import type { ItemRepository, SubscriptionRepository } from "../../db/repositories.ts";
import type { JsonValue, Subscription } from "../../domain/types.ts";
import type { HttpResponse, ProbeHttpClient } from "../../probe/types.ts";
import { sanitizeErrorMessage } from "../../security/redaction.ts";
import { normalizeGithubReleases } from "./normalize.ts";
import { GITHUB_API_HEADERS } from "./probe.ts";
import type { GithubCursor, GithubNormalizedRelease, GithubPollResult } from "./types.ts";
import { githubReleasesApiUrl } from "./url.ts";

const GITHUB_JSON_LIMIT = 5 * 1024 * 1024;
const DEFAULT_BACKFILL_LIMIT = 20;
const DEFAULT_INITIAL_DELIVERY_LIMIT = 1;
const MAXIMUM_BACKFILL_LIMIT = 500;
const MAXIMUM_CURSOR_HEADER_LENGTH = 1_024;
const MAXIMUM_PAGES = 100;

class GithubRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAt: number | undefined,
  ) {
    super(message);
    this.name = "GithubRateLimitError";
  }
}

function isJsonObject(value: JsonValue | null): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readCursor(subscription: Subscription): GithubCursor {
  if (subscription.cursor === null) return {};
  if (!isJsonObject(subscription.cursor)) throw new Error("GitHub cursor must be an object");
  const { etag, lastUpdatedAt } = subscription.cursor;
  if (etag !== undefined && typeof etag !== "string") {
    throw new Error("GitHub cursor etag must be a string");
  }
  if (
    lastUpdatedAt !== undefined &&
    (typeof lastUpdatedAt !== "number" || !Number.isSafeInteger(lastUpdatedAt) || lastUpdatedAt < 0)
  ) {
    throw new Error("GitHub cursor lastUpdatedAt must be a non-negative integer");
  }
  return { etag, lastUpdatedAt };
}

function readBackfillLimit(subscription: Subscription): number {
  if (!isJsonObject(subscription.metadata)) return DEFAULT_BACKFILL_LIMIT;
  const configured = subscription.metadata.backfillLimit;
  if (configured === undefined) return DEFAULT_BACKFILL_LIMIT;
  if (
    typeof configured !== "number" ||
    !Number.isSafeInteger(configured) ||
    configured < 0 ||
    configured > MAXIMUM_BACKFILL_LIMIT
  ) {
    throw new Error(`backfillLimit must be an integer between 0 and ${MAXIMUM_BACKFILL_LIMIT}`);
  }
  return configured;
}

function readInitialDeliveryLimit(subscription: Subscription, backfillLimit: number): number {
  if (!isJsonObject(subscription.metadata)) {
    return Math.min(DEFAULT_INITIAL_DELIVERY_LIMIT, backfillLimit);
  }
  const configured = subscription.metadata.initialDeliveryLimit;
  if (configured === undefined) return Math.min(DEFAULT_INITIAL_DELIVERY_LIMIT, backfillLimit);
  if (
    typeof configured !== "number" ||
    !Number.isSafeInteger(configured) ||
    configured < 0 ||
    configured > backfillLimit
  ) {
    throw new Error(
      `initialDeliveryLimit must be an integer between 0 and backfillLimit (${backfillLimit})`,
    );
  }
  return configured;
}

function safeCursorHeader(value: string | null, name: string): string | undefined {
  if (value === null) return undefined;
  if (
    value.length > MAXIMUM_CURSOR_HEADER_LENGTH ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new Error(`${name} is invalid or too long`);
  }
  return value;
}

function conditionalHeaders(cursor: GithubCursor): Readonly<Record<string, string>> {
  return {
    ...GITHUB_API_HEADERS,
    ...(cursor.etag ? { "If-None-Match": cursor.etag } : {}),
  };
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    throw new Error(`GitHub releases response is not valid JSON: ${String(error)}`);
  }
}

function isJsonContentType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType === "application/vnd.github+json";
}

function parseIntegerHeader(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function retryAtFromHeaders(response: HttpResponse, now: number): number | undefined {
  const resetSeconds = parseIntegerHeader(response.headers.get("x-ratelimit-reset"));
  const retryAfter = response.headers.get("retry-after")?.trim();
  const retryAfterSeconds =
    retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : undefined;
  const retryAfterDate =
    retryAfter && retryAfterSeconds === undefined ? Date.parse(retryAfter) : Number.NaN;
  const candidates = [
    resetSeconds === undefined ? undefined : resetSeconds * 1_000,
    retryAfterSeconds === undefined
      ? Number.isFinite(retryAfterDate)
        ? retryAfterDate
        : undefined
      : now + retryAfterSeconds * 1_000,
  ].filter((value): value is number => value !== undefined && Number.isSafeInteger(value));
  if (candidates.length === 0) return undefined;
  return Math.max(now + 1_000, ...candidates);
}

function nextLink(value: string | null, currentUrl: string): string | null {
  if (!value) return null;
  for (const part of value.split(/,(?=\s*<)/u)) {
    const match = /^\s*<([^>]+)>\s*;(.+)$/u.exec(part);
    if (!match?.[1] || !match[2]) continue;
    const relation = /(?:^|;)\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu.exec(match[2]);
    const relations = (relation?.[1] ?? relation?.[2] ?? "").split(/\s+/u);
    if (!relations.includes("next")) continue;
    let url: URL;
    try {
      url = new URL(match[1], currentUrl);
    } catch {
      throw new Error("GitHub Link header contains an invalid next URL");
    }
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "api.github.com") {
      throw new Error("GitHub Link header contains an unsupported next URL");
    }
    return url.toString();
  }
  return null;
}

function cursorJson(cursor: GithubCursor): Record<string, JsonValue> {
  return {
    ...(cursor.etag === undefined ? {} : { etag: cursor.etag }),
    ...(cursor.lastUpdatedAt === undefined ? {} : { lastUpdatedAt: cursor.lastUpdatedAt }),
  };
}

function maxUpdatedAt(
  releases: readonly GithubNormalizedRelease[],
  current: number | undefined,
): number | undefined {
  return releases.reduce<number | undefined>(
    (maximum, release) =>
      maximum === undefined ? release.updatedAt : Math.max(maximum, release.updatedAt),
    current,
  );
}

function selectInitial(
  releases: readonly GithubNormalizedRelease[],
  backfillLimit: number,
): GithubNormalizedRelease[] {
  return [...releases].sort((left, right) => right.sortAt - left.sortAt).slice(0, backfillLimit);
}

interface FetchResult {
  status: "fetched" | "not_modified";
  values: unknown[];
  etag?: string;
}

export class GithubSourceAdapter {
  constructor(
    private readonly client: ProbeHttpClient,
    private readonly subscriptions: SubscriptionRepository,
    private readonly items: ItemRepository,
    private readonly now: () => number = Date.now,
  ) {}

  private async fetchReleases(
    subscription: Subscription,
    cursor: GithubCursor,
    polledAt: number,
  ): Promise<FetchResult> {
    let url = githubReleasesApiUrl(subscription.sourceKey);
    let firstPage = true;
    let pages = 0;
    const visited = new Set<string>();
    const values: unknown[] = [];
    let etag: string | undefined;

    while (true) {
      if (visited.has(url)) throw new Error("GitHub Link pagination loop detected");
      visited.add(url);
      pages += 1;
      if (pages > MAXIMUM_PAGES) throw new Error("GitHub Link pagination exceeded the page limit");

      const response = await this.client.get(
        url,
        () => GITHUB_JSON_LIMIT,
        firstPage ? conditionalHeaders(cursor) : GITHUB_API_HEADERS,
      );
      if (firstPage && response.status === 304) {
        return { status: "not_modified", values: [], etag: cursor.etag };
      }
      if (response.status === 403 || response.status === 429) {
        throw new GithubRateLimitError(
          `GitHub API rate limit response: HTTP ${response.status}`,
          retryAtFromHeaders(response, polledAt),
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`GitHub API returned HTTP ${response.status}`);
      }
      if (!isJsonContentType(response.headers.get("content-type"))) {
        throw new Error("GitHub API response has an unsupported Content-Type");
      }
      const payload = parseJson(response.body);
      if (!Array.isArray(payload)) throw new Error("GitHub releases response must be an array");
      values.push(...payload);
      if (firstPage) etag = safeCursorHeader(response.headers.get("etag"), "ETag");

      const link = nextLink(response.headers.get("link"), response.url);
      if (!link) return { status: "fetched", values, etag };
      url = link;
      firstPage = false;
    }
  }

  async poll(subscriptionId: string): Promise<GithubPollResult> {
    const subscription = this.subscriptions.findById(subscriptionId);
    if (!subscription) throw new Error(`Subscription not found: ${subscriptionId}`);
    if (!subscription.enabled) throw new Error(`Subscription is disabled: ${subscriptionId}`);
    if (subscription.adapter !== "github") {
      throw new Error(`Subscription adapter must be github, received: ${subscription.adapter}`);
    }

    const polledAt = this.now();
    const nextPollAt = polledAt + subscription.pollIntervalMinutes * 60_000;
    try {
      const cursor = readCursor(subscription);
      const firstPoll = subscription.cursor === null;
      const backfillLimit = firstPoll ? readBackfillLimit(subscription) : null;
      const initialDeliveryLimit =
        backfillLimit === null ? null : readInitialDeliveryLimit(subscription, backfillLimit);
      const fetched = await this.fetchReleases(subscription, cursor, polledAt);
      const nextCursor: GithubCursor = {
        etag: fetched.etag,
        lastUpdatedAt: cursor.lastUpdatedAt,
      };

      if (fetched.status === "not_modified") {
        const result = this.items.recordPoll({
          subscriptionId,
          items: [],
          cursor: cursorJson(nextCursor),
          polledAt,
          nextPollAt,
        });
        return { status: "not_modified", ...result, cursor: nextCursor };
      }

      const normalized = normalizeGithubReleases(fetched.values, subscription.sourceKey);
      nextCursor.lastUpdatedAt = maxUpdatedAt(normalized, cursor.lastUpdatedAt);
      const selected = firstPoll
        ? selectInitial(normalized, backfillLimit as number)
        : normalized.filter(
            (release) =>
              cursor.lastUpdatedAt === undefined || release.updatedAt > cursor.lastUpdatedAt,
          );
      if (selected.length === 0) {
        const result = this.items.recordPoll({
          subscriptionId,
          items: [],
          cursor: cursorJson(nextCursor),
          polledAt,
          nextPollAt,
        });
        return { status: "fetched", ...result, cursor: nextCursor };
      }

      const initialDeliveryIds = new Set(
        firstPoll
          ? selected
              .slice(0, initialDeliveryLimit as number)
              .map((release) => release.item.externalId)
          : [],
      );
      let insertedItems = 0;
      let duplicateItems = 0;
      for (const release of selected) {
        const result = this.items.recordEvent({
          subscriptionId,
          item: release.item,
          cursor: cursorJson(nextCursor),
          eventAt: polledAt,
          nextPollAt,
          notifyOnInsert: firstPoll ? initialDeliveryIds.has(release.item.externalId) : true,
        });
        insertedItems += result.insertedItems;
        duplicateItems += result.updatedItems;
      }
      return { status: "fetched", insertedItems, duplicateItems, cursor: nextCursor };
    } catch (error) {
      const retryAt = error instanceof GithubRateLimitError ? error.retryAt : undefined;
      this.subscriptions.recordFailure(
        subscriptionId,
        sanitizeErrorMessage(error),
        polledAt,
        retryAt,
      );
      throw error;
    }
  }
}
