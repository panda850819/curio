import type { ItemRepository, SubscriptionRepository } from "../../db/repositories.ts";
import type { Subscription } from "../../domain/types.ts";
import { isFeedContentType } from "../../probe/feed.ts";
import type { ProbeHttpClient } from "../../probe/types.ts";
import { sanitizeErrorMessage } from "../../security/redaction.ts";
import { normalizeFeed } from "./normalize.ts";
import {
  isJsonObject,
  type NormalizedFeedEntry,
  type RssCursor,
  type RssPollResult,
  type RssPollWarning,
} from "./types.ts";

const FEED_LIMIT = 5 * 1024 * 1024;
const DEFAULT_BACKFILL_LIMIT = 20;
const MAXIMUM_BACKFILL_LIMIT = 500;
const MAXIMUM_CURSOR_HEADER_LENGTH = 1_024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function readCursor(subscription: Subscription): RssCursor {
  if (subscription.cursor === null) return {};
  if (!isJsonObject(subscription.cursor)) throw new Error("RSS cursor must be a JSON object");

  const etag = subscription.cursor.etag;
  const lastModified = subscription.cursor.lastModified;
  if (etag !== undefined && typeof etag !== "string")
    throw new Error("RSS cursor etag must be a string");
  if (lastModified !== undefined && typeof lastModified !== "string") {
    throw new Error("RSS cursor lastModified must be a string");
  }
  return { etag, lastModified };
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

function conditionalHeaders(cursor: RssCursor): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cursor.etag) headers["If-None-Match"] = cursor.etag;
  if (cursor.lastModified) headers["If-Modified-Since"] = cursor.lastModified;
  return headers;
}

function safeCursorHeader(
  value: string | null,
  name: string,
  warnings: RssPollWarning[],
): string | undefined {
  if (value === null) return undefined;
  if (
    value.length > MAXIMUM_CURSOR_HEADER_LENGTH ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    warnings.push({
      code: "invalid_cursor_header",
      message: `${name} was ignored because it is invalid or too long`,
    });
    return undefined;
  }
  return value;
}

function updatedCursor(
  current: RssCursor,
  getHeader: (name: string) => string | null,
  warnings: RssPollWarning[],
  preserveMissing: boolean,
): RssCursor {
  const etag = safeCursorHeader(getHeader("etag"), "ETag", warnings);
  const lastModified = safeCursorHeader(getHeader("last-modified"), "Last-Modified", warnings);
  return {
    etag: etag ?? (preserveMissing ? current.etag : undefined),
    lastModified: lastModified ?? (preserveMissing ? current.lastModified : undefined),
  };
}

function cursorJson(cursor: RssCursor): Record<string, string> {
  const value: Record<string, string> = {};
  if (cursor.etag !== undefined) value.etag = cursor.etag;
  if (cursor.lastModified !== undefined) value.lastModified = cursor.lastModified;
  return value;
}

function firstBackfill(entries: NormalizedFeedEntry[], limit: number): NormalizedFeedEntry[] {
  return [...entries]
    .sort((left, right) => {
      const leftDate = left.item.publishedAt;
      const rightDate = right.item.publishedAt;
      if (
        leftDate !== null &&
        leftDate !== undefined &&
        rightDate !== null &&
        rightDate !== undefined
      ) {
        return rightDate - leftDate || left.sourceIndex - right.sourceIndex;
      }
      if (leftDate !== null && leftDate !== undefined) return -1;
      if (rightDate !== null && rightDate !== undefined) return 1;
      return left.sourceIndex - right.sourceIndex;
    })
    .slice(0, limit);
}

export class RssSourceAdapter {
  constructor(
    private readonly client: ProbeHttpClient,
    private readonly subscriptions: SubscriptionRepository,
    private readonly items: ItemRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async poll(subscriptionId: string): Promise<RssPollResult> {
    const subscription = this.subscriptions.findById(subscriptionId);
    if (!subscription) throw new Error(`Subscription not found: ${subscriptionId}`);
    if (!subscription.enabled) throw new Error(`Subscription is disabled: ${subscriptionId}`);
    if (subscription.adapter !== "rss") {
      throw new Error(`Subscription adapter must be rss, received: ${subscription.adapter}`);
    }

    const polledAt = this.now();
    const nextPollAt = polledAt + subscription.pollIntervalMinutes * 60_000;
    try {
      const cursor = readCursor(subscription);
      const backfillLimit = subscription.cursor === null ? readBackfillLimit(subscription) : null;
      const response = await this.client.get(
        subscription.sourceUrl,
        () => FEED_LIMIT,
        conditionalHeaders(cursor),
      );
      const warnings: RssPollWarning[] = [];
      const nextCursor = updatedCursor(
        cursor,
        (name) => response.headers.get(name),
        warnings,
        response.status === 304,
      );

      if (response.status === 304) {
        const result = this.items.recordPoll({
          subscriptionId,
          items: [],
          cursor: cursorJson(nextCursor),
          polledAt,
          nextPollAt,
        });
        return { status: "not_modified", ...result, warnings, cursor: nextCursor };
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status} while polling ${subscription.sourceUrl}`);
      }
      if (!isFeedContentType(response.headers.get("content-type"))) {
        throw new Error("Feed response has an unsupported Content-Type");
      }

      const normalized = normalizeFeed(decoder.decode(response.body), response.url);
      warnings.push(...normalized.warnings);
      const selected =
        backfillLimit === null
          ? normalized.entries
          : firstBackfill(normalized.entries, backfillLimit);
      const result = this.items.recordPoll({
        subscriptionId,
        items: selected.map((entry) => entry.item),
        cursor: cursorJson(nextCursor),
        polledAt,
        nextPollAt,
      });

      return { status: "fetched", ...result, warnings, cursor: nextCursor };
    } catch (error) {
      this.subscriptions.recordFailure(subscriptionId, sanitizeErrorMessage(error), polledAt);
      throw error;
    }
  }
}
