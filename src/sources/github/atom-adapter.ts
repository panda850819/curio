import type { ItemRepository, SubscriptionRepository } from "../../db/repositories.ts";
import type { JsonValue, Subscription } from "../../domain/types.ts";
import type { ProbeHttpClient } from "../../probe/types.ts";
import { sanitizeErrorMessage } from "../../security/redaction.ts";
import { normalizeGithubAtomFeed } from "./atom-normalize.ts";
import { GITHUB_ATOM_HEADERS } from "./atom-probe.ts";
import { parseGithubAtomInput } from "./atom-url.ts";
import type { GithubAtomCursor, GithubAtomEntry, GithubAtomPollResult } from "./types.ts";

const GITHUB_ATOM_LIMIT = 5 * 1024 * 1024;
const DEFAULT_BACKFILL_LIMIT = 20;
const DEFAULT_INITIAL_DELIVERY_LIMIT = 1;
const MAXIMUM_BACKFILL_LIMIT = 500;
const MAXIMUM_CURSOR_HEADER_LENGTH = 1_024;

function isJsonObject(value: JsonValue | null): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readCursor(subscription: Subscription): GithubAtomCursor {
  if (subscription.cursor === null) return {};
  if (!isJsonObject(subscription.cursor)) {
    throw new Error("GitHub Atom cursor must be an object");
  }
  const { etag, lastModified, lastUpdatedAt } = subscription.cursor;
  if (etag !== undefined && typeof etag !== "string") {
    throw new Error("GitHub Atom cursor etag must be a string");
  }
  if (lastModified !== undefined && typeof lastModified !== "string") {
    throw new Error("GitHub Atom cursor lastModified must be a string");
  }
  if (
    lastUpdatedAt !== undefined &&
    (typeof lastUpdatedAt !== "number" || !Number.isSafeInteger(lastUpdatedAt) || lastUpdatedAt < 0)
  ) {
    throw new Error("GitHub Atom cursor lastUpdatedAt must be a non-negative integer");
  }
  return { etag, lastModified, lastUpdatedAt };
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

function conditionalHeaders(cursor: GithubAtomCursor): Readonly<Record<string, string>> {
  return {
    ...GITHUB_ATOM_HEADERS,
    ...(cursor.etag ? { "If-None-Match": cursor.etag } : {}),
    ...(cursor.lastModified ? { "If-Modified-Since": cursor.lastModified } : {}),
  };
}

function isAtomContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/atom+xml";
}

function cursorJson(cursor: GithubAtomCursor): Record<string, JsonValue> {
  return {
    ...(cursor.etag === undefined ? {} : { etag: cursor.etag }),
    ...(cursor.lastModified === undefined ? {} : { lastModified: cursor.lastModified }),
    ...(cursor.lastUpdatedAt === undefined ? {} : { lastUpdatedAt: cursor.lastUpdatedAt }),
  };
}

function maxUpdatedAt(
  entries: readonly GithubAtomEntry[],
  current: number | undefined,
): number | undefined {
  return entries.reduce<number | undefined>(
    (maximum, entry) =>
      maximum === undefined ? entry.updatedAt : Math.max(maximum, entry.updatedAt),
    current,
  );
}

function selectInitial(entries: readonly GithubAtomEntry[], limit: number): GithubAtomEntry[] {
  return [...entries].sort((left, right) => right.sortAt - left.sortAt).slice(0, limit);
}

export class GithubAtomSourceAdapter {
  constructor(
    private readonly client: ProbeHttpClient,
    private readonly subscriptions: SubscriptionRepository,
    private readonly items: ItemRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async poll(subscriptionId: string): Promise<GithubAtomPollResult> {
    const subscription = this.subscriptions.findById(subscriptionId);
    if (!subscription) throw new Error(`Subscription not found: ${subscriptionId}`);
    if (!subscription.enabled) throw new Error(`Subscription is disabled: ${subscriptionId}`);
    if (subscription.adapter !== "github_atom") {
      throw new Error(
        `Subscription adapter must be github_atom, received: ${subscription.adapter}`,
      );
    }

    const polledAt = this.now();
    const nextPollAt = polledAt + subscription.pollIntervalMinutes * 60_000;
    try {
      const reference = parseGithubAtomInput(subscription.sourceUrl);
      if (!reference || reference.sourceKey !== subscription.sourceKey) {
        throw new Error("GitHub Atom subscription source identity is invalid");
      }
      const cursor = readCursor(subscription);
      const firstPoll = subscription.cursor === null;
      const backfillLimit = firstPoll ? readBackfillLimit(subscription) : null;
      const initialDeliveryLimit =
        backfillLimit === null ? null : readInitialDeliveryLimit(subscription, backfillLimit);
      const response = await this.client.get(
        reference.sourceUrl,
        () => GITHUB_ATOM_LIMIT,
        conditionalHeaders(cursor),
      );
      const nextCursor: GithubAtomCursor = {
        etag: cursor.etag,
        lastModified: cursor.lastModified,
        lastUpdatedAt: cursor.lastUpdatedAt,
      };
      if (response.status === 304) {
        const result = this.items.recordPoll({
          subscriptionId,
          items: [],
          cursor: cursorJson(nextCursor),
          polledAt,
          nextPollAt,
        });
        return { status: "not_modified", ...result, cursor: nextCursor };
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`GitHub Atom returned HTTP ${response.status}`);
      }
      if (!isAtomContentType(response.headers.get("content-type"))) {
        throw new Error("GitHub Atom response has an unsupported Content-Type");
      }
      nextCursor.etag = safeCursorHeader(response.headers.get("etag"), "ETag");
      nextCursor.lastModified = safeCursorHeader(
        response.headers.get("last-modified"),
        "Last-Modified",
      );
      const entries = normalizeGithubAtomFeed(
        new TextDecoder("utf-8", { fatal: true }).decode(response.body),
        response.url,
        reference.repository,
        reference.branch,
        reference.kind,
      );
      nextCursor.lastUpdatedAt = maxUpdatedAt(entries, cursor.lastUpdatedAt);
      const selected = firstPoll
        ? selectInitial(entries, backfillLimit as number)
        : entries.filter(
            (entry) => cursor.lastUpdatedAt === undefined || entry.updatedAt > cursor.lastUpdatedAt,
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
          ? selected.slice(0, initialDeliveryLimit as number).map((entry) => entry.item.externalId)
          : [],
      );
      let insertedItems = 0;
      let duplicateItems = 0;
      for (const entry of selected) {
        const result = this.items.recordEvent({
          subscriptionId,
          item: entry.item,
          cursor: cursorJson(nextCursor),
          eventAt: polledAt,
          nextPollAt,
          notifyOnInsert: firstPoll ? initialDeliveryIds.has(entry.item.externalId) : true,
        });
        insertedItems += result.insertedItems;
        duplicateItems += result.updatedItems;
      }
      return { status: "fetched", insertedItems, duplicateItems, cursor: nextCursor };
    } catch (error) {
      this.subscriptions.recordFailure(subscriptionId, sanitizeErrorMessage(error), polledAt);
      throw error;
    }
  }
}
