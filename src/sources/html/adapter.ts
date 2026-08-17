import type { ItemRepository, SubscriptionRepository } from "../../db/repositories.ts";
import type { JsonValue, Subscription } from "../../domain/types.ts";
import { isHtmlContentType } from "../../probe/feed.ts";
import type { ProbeHttpClient } from "../../probe/types.ts";
import { sanitizeErrorMessage } from "../../security/redaction.ts";
import { normalizeHtmlDocument } from "./normalize.ts";
import type { HtmlCursor, HtmlPollResult, HtmlPollWarning } from "./types.ts";

const HTML_LIMIT = 2 * 1024 * 1024;
const MAXIMUM_CURSOR_HEADER_LENGTH = 1_024;
const MAXIMUM_CONTENT_BYTES = 256 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function isJsonObject(value: JsonValue | null): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readCursor(subscription: Subscription): HtmlCursor {
  if (subscription.cursor === null) return {};
  if (!isJsonObject(subscription.cursor)) throw new Error("HTML cursor must be a JSON object");
  const cursor: HtmlCursor = {};
  for (const key of ["etag", "lastModified", "lastHash"] as const) {
    const value = subscription.cursor[key];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`HTML cursor ${key} must be a string`);
    }
    if (value !== undefined) cursor[key] = value;
  }
  return cursor;
}

function metadata(subscription: Subscription): {
  selector?: string;
  notifyOnFirstPoll: boolean;
} {
  if (!isJsonObject(subscription.metadata)) return { notifyOnFirstPoll: false };
  const selector = subscription.metadata.selector;
  const notifyOnFirstPoll = subscription.metadata.notifyOnFirstPoll;
  if (selector !== undefined && typeof selector !== "string") {
    throw new Error("HTML selector metadata must be a string");
  }
  if (notifyOnFirstPoll !== undefined && typeof notifyOnFirstPoll !== "boolean") {
    throw new Error("notifyOnFirstPoll metadata must be a boolean");
  }
  return {
    selector: selector?.trim() || undefined,
    notifyOnFirstPoll: notifyOnFirstPoll === true,
  };
}

function safeCursorHeader(
  value: string | null,
  name: string,
  warnings: HtmlPollWarning[],
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

function conditionalHeaders(cursor: HtmlCursor): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cursor.etag) headers["If-None-Match"] = cursor.etag;
  if (cursor.lastModified) headers["If-Modified-Since"] = cursor.lastModified;
  return headers;
}

function updateCursor(
  current: HtmlCursor,
  getHeader: (name: string) => string | null,
  warnings: HtmlPollWarning[],
  preserveMissing: boolean,
): HtmlCursor {
  const etag = safeCursorHeader(getHeader("etag"), "ETag", warnings);
  const lastModified = safeCursorHeader(getHeader("last-modified"), "Last-Modified", warnings);
  return {
    etag: etag ?? (preserveMissing ? current.etag : undefined),
    lastModified: lastModified ?? (preserveMissing ? current.lastModified : undefined),
    lastHash: current.lastHash,
  };
}

function cursorJson(cursor: HtmlCursor): Record<string, string> {
  const value: Record<string, string> = {};
  if (cursor.etag !== undefined) value.etag = cursor.etag;
  if (cursor.lastModified !== undefined) value.lastModified = cursor.lastModified;
  if (cursor.lastHash !== undefined) value.lastHash = cursor.lastHash;
  return value;
}

function contentHash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function itemFor(
  subscription: Subscription,
  normalized: { canonical: string; text: string; title: string | null },
  hash: string,
  selector?: string,
) {
  return {
    externalId: `html:${hash}`,
    url: subscription.sourceUrl,
    title: normalized.title || subscription.title || "Monitored page changed",
    summary: selector
      ? `Page content changed in selector ${selector}`
      : "Monitored page content changed",
    contentText: normalized.text,
    contentHtml: null,
    metadata: {
      contentHash: hash,
      ...(selector ? { selector } : {}),
    },
  };
}

export class HtmlSourceAdapter {
  constructor(
    private readonly client: ProbeHttpClient,
    private readonly subscriptions: SubscriptionRepository,
    private readonly items: ItemRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async poll(subscriptionId: string): Promise<HtmlPollResult> {
    const subscription = this.subscriptions.findById(subscriptionId);
    if (!subscription) throw new Error(`Subscription not found: ${subscriptionId}`);
    if (!subscription.enabled) throw new Error(`Subscription is disabled: ${subscriptionId}`);
    if (subscription.adapter !== "html") {
      throw new Error(`Subscription adapter must be html, received: ${subscription.adapter}`);
    }

    const polledAt = this.now();
    const nextPollAt = polledAt + subscription.pollIntervalMinutes * 60_000;
    try {
      const cursor = readCursor(subscription);
      const configuration = metadata(subscription);
      const response = await this.client.get(
        subscription.sourceUrl,
        () => HTML_LIMIT,
        conditionalHeaders(cursor),
      );
      const warnings: HtmlPollWarning[] = [];
      const nextCursor = updateCursor(
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
      if (!isHtmlContentType(response.headers.get("content-type"))) {
        throw new Error("HTML response has an unsupported Content-Type");
      }

      const normalized = normalizeHtmlDocument(
        decoder.decode(response.body),
        response.url,
        configuration.selector,
        MAXIMUM_CONTENT_BYTES,
      );
      const hash = contentHash(normalized.canonical);
      nextCursor.lastHash = hash;
      if (cursor.lastHash === hash) {
        const result = this.items.recordPoll({
          subscriptionId,
          items: [],
          cursor: cursorJson(nextCursor),
          polledAt,
          nextPollAt,
        });
        return { status: "not_modified", ...result, warnings, cursor: nextCursor };
      }

      const item = itemFor(subscription, normalized, hash, configuration.selector);
      const isBaseline = cursor.lastHash === undefined;
      const result = this.items.recordPoll({
        subscriptionId,
        items: [item],
        cursor: cursorJson(nextCursor),
        polledAt,
        nextPollAt,
        deliveryExternalIds:
          isBaseline && !configuration.notifyOnFirstPoll ? [] : [item.externalId],
      });
      return {
        status: isBaseline ? "baseline" : "changed",
        ...result,
        warnings,
        cursor: nextCursor,
      };
    } catch (error) {
      this.subscriptions.recordFailure(subscriptionId, sanitizeErrorMessage(error), polledAt);
      throw error;
    }
  }
}
