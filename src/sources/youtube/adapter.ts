import type { ItemRepository, SubscriptionRepository } from "../../db/repositories.ts";
import type { JsonValue, Subscription } from "../../domain/types.ts";
import { isFeedContentType, isHtmlContentType } from "../../probe/feed.ts";
import type { ProbeHttpClient } from "../../probe/types.ts";
import { sanitizeErrorMessage } from "../../security/redaction.ts";
import { normalizeYoutubeFeed } from "./normalize.ts";
import { normalizeYoutubeChannelPage } from "./page.ts";
import { youtubeChannelIdFromFeedUrl } from "./probe.ts";
import type { YoutubeCursor, YoutubePollResult } from "./types.ts";

const FEED_LIMIT = 5 * 1024 * 1024;
const CHANNEL_PAGE_LIMIT = 5 * 1024 * 1024;
const DEFAULT_BACKFILL_LIMIT = 20;
const DEFAULT_INITIAL_DELIVERY_LIMIT = 1;
const MAXIMUM_BACKFILL_LIMIT = 500;
const MAXIMUM_CURSOR_HEADER_LENGTH = 1_024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function channelPageUrl(sourceKey: string): string {
  return `https://www.youtube.com/channel/${encodeURIComponent(sourceKey)}/videos`;
}

function youtubeChannelId(subscription: Subscription): string | null {
  if (subscription.adapter === "youtube") return subscription.sourceKey;
  if (subscription.adapter === "rss") return youtubeChannelIdFromFeedUrl(subscription.sourceUrl);
  return null;
}

function shouldUseChannelPageFallback(status: number): boolean {
  return status === 400 || status === 404 || status >= 500;
}

type YoutubeEntry = ReturnType<typeof normalizeYoutubeFeed>["entries"][number];

function canonicalizeLegacyEntries(
  entries: YoutubeEntry[],
  existingExternalIds: ReadonlySet<string>,
): YoutubeEntry[] {
  return entries.map((entry) => {
    const videoId = entry.item.externalId;
    const legacyExternalId = `yt:video:${videoId}`;
    if (existingExternalIds.has(videoId) || !existingExternalIds.has(legacyExternalId)) {
      return entry;
    }
    return {
      ...entry,
      item: { ...entry.item, externalId: legacyExternalId },
    };
  });
}

function isJsonObject(value: Subscription["metadata"]): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readCursor(subscription: Subscription): YoutubeCursor {
  if (subscription.cursor === null) return {};
  if (!isJsonObject(subscription.cursor)) throw new Error("YouTube cursor must be a JSON object");
  const cursor: YoutubeCursor = {};
  for (const key of ["etag", "lastModified"] as const) {
    const value = subscription.cursor[key];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`YouTube cursor ${key} must be a string`);
    }
    if (value !== undefined) cursor[key] = value;
  }
  return cursor;
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
  if (!isJsonObject(subscription.metadata))
    return Math.min(DEFAULT_INITIAL_DELIVERY_LIMIT, backfillLimit);
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

function conditionalHeaders(cursor: YoutubeCursor): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cursor.etag) headers["If-None-Match"] = cursor.etag;
  if (cursor.lastModified) headers["If-Modified-Since"] = cursor.lastModified;
  return headers;
}

function safeCursorHeader(
  value: string | null,
  name: string,
  warnings: string[],
): string | undefined {
  if (value === null) return undefined;
  if (
    value.length > MAXIMUM_CURSOR_HEADER_LENGTH ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    warnings.push(`${name} was ignored because it is invalid or too long`);
    return undefined;
  }
  return value;
}

function updatedCursor(
  current: YoutubeCursor,
  getHeader: (name: string) => string | null,
  warnings: string[],
  preserveMissing: boolean,
): YoutubeCursor {
  const etag = safeCursorHeader(getHeader("etag"), "ETag", warnings);
  const lastModified = safeCursorHeader(getHeader("last-modified"), "Last-Modified", warnings);
  return {
    etag: etag ?? (preserveMissing ? current.etag : undefined),
    lastModified: lastModified ?? (preserveMissing ? current.lastModified : undefined),
  };
}

function firstBackfill(entries: ReturnType<typeof normalizeYoutubeFeed>["entries"], limit: number) {
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

function cursorJson(cursor: YoutubeCursor): Record<string, string> {
  return Object.fromEntries(
    Object.entries(cursor).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export class YoutubeSourceAdapter {
  constructor(
    private readonly client: ProbeHttpClient,
    private readonly subscriptions: SubscriptionRepository,
    private readonly items: ItemRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async poll(subscriptionId: string): Promise<YoutubePollResult> {
    const subscription = this.subscriptions.findById(subscriptionId);
    if (!subscription) throw new Error(`Subscription not found: ${subscriptionId}`);
    if (!subscription.enabled) throw new Error(`Subscription is disabled: ${subscriptionId}`);
    const channelId = youtubeChannelId(subscription);
    if (!channelId) {
      throw new Error(`Subscription adapter must be youtube, received: ${subscription.adapter}`);
    }

    const polledAt = this.now();
    const nextPollAt = polledAt + subscription.pollIntervalMinutes * 60_000;
    try {
      const cursor = readCursor(subscription);
      const backfillLimit = subscription.cursor === null ? readBackfillLimit(subscription) : null;
      const initialDeliveryLimit =
        backfillLimit === null ? null : readInitialDeliveryLimit(subscription, backfillLimit);
      const response = await this.client.get(
        subscription.sourceUrl,
        () => FEED_LIMIT,
        conditionalHeaders(cursor),
      );
      const warnings: string[] = [];
      if (response.status === 304) {
        const nextCursor = updatedCursor(
          cursor,
          (name) => response.headers.get(name),
          warnings,
          true,
        );
        const result = this.items.recordPoll({
          subscriptionId,
          items: [],
          cursor: cursorJson(nextCursor),
          polledAt,
          nextPollAt,
        });
        return {
          status: "not_modified",
          ...result,
          warnings: warnings.map((message) => ({
            code: "invalid_cursor_header" as const,
            message,
          })),
          cursor: nextCursor,
        };
      }

      let nextCursor: YoutubeCursor;
      let entries: ReturnType<typeof normalizeYoutubeFeed>["entries"];
      let normalizedWarnings: YoutubePollResult["warnings"] = [];
      if (response.status >= 200 && response.status < 300) {
        if (!isFeedContentType(response.headers.get("content-type"))) {
          throw new Error("YouTube response has an unsupported feed Content-Type");
        }
        nextCursor = updatedCursor(cursor, (name) => response.headers.get(name), warnings, false);
        const normalized = normalizeYoutubeFeed(
          decoder.decode(response.body),
          response.url,
          channelId,
        );
        entries = normalized.entries;
        normalizedWarnings = normalized.warnings;
      } else if (shouldUseChannelPageFallback(response.status)) {
        const pageResponse = await this.client.get(
          channelPageUrl(channelId),
          () => CHANNEL_PAGE_LIMIT,
        );
        if (pageResponse.status < 200 || pageResponse.status >= 300) {
          throw new Error(`HTTP ${response.status} while polling ${subscription.sourceUrl}`);
        }
        if (!isHtmlContentType(pageResponse.headers.get("content-type"))) {
          throw new Error("YouTube channel page has an unsupported Content-Type");
        }
        const normalized = normalizeYoutubeChannelPage(
          decoder.decode(pageResponse.body),
          channelId,
          subscription.title?.trim() || channelId,
        );
        entries = normalized.entries;
        nextCursor = {};
      } else {
        throw new Error(`HTTP ${response.status} while polling ${subscription.sourceUrl}`);
      }

      const canonicalEntries =
        subscription.adapter === "rss"
          ? canonicalizeLegacyEntries(entries, new Set(this.items.listExternalIds(subscriptionId)))
          : entries;
      const selected =
        backfillLimit === null ? canonicalEntries : firstBackfill(canonicalEntries, backfillLimit);
      const result = this.items.recordPoll({
        subscriptionId,
        items: selected.map((entry) => entry.item),
        cursor: cursorJson(nextCursor),
        polledAt,
        nextPollAt,
        deliveryExternalIds:
          initialDeliveryLimit === null
            ? undefined
            : selected.slice(0, initialDeliveryLimit).map((entry) => entry.item.externalId),
      });
      return {
        status: "fetched",
        ...result,
        warnings: [
          ...normalizedWarnings,
          ...warnings.map((message) => ({ code: "invalid_cursor_header" as const, message })),
        ],
        cursor: nextCursor,
      };
    } catch (error) {
      this.subscriptions.recordFailure(subscriptionId, sanitizeErrorMessage(error), polledAt);
      throw error;
    }
  }
}
