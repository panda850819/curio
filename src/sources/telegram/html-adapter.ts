import type { ItemRepository, SubscriptionRepository } from "../../db/repositories.ts";
import type { CanonicalItem, JsonValue, Subscription } from "../../domain/types.ts";
import { isHtmlContentType } from "../../probe/feed.ts";
import type { ProbeHttpClient } from "../../probe/types.ts";
import type { SourcePoller, SourcePollResult } from "../../scheduler.ts";
import { sanitizeErrorMessage } from "../../security/redaction.ts";
import {
  allElements,
  type HtmlElementNode,
  parentMap,
  parseHtml,
  textContent,
} from "../html/normalize.ts";

const HTML_LIMIT = 5 * 1024 * 1024;
const MAX_CONTENT_LENGTH = 64 * 1024;
const MAXIMUM_BACKFILL_LIMIT = 500;
const DEFAULT_BACKFILL_LIMIT = 20;
const DEFAULT_INITIAL_DELIVERY_LIMIT = 1;
const MAXIMUM_CURSOR_HEADER_LENGTH = 1_024;

interface TelegramHtmlCursor {
  etag?: string;
  lastModified?: string;
  lastMessageId?: number;
}

export interface TelegramHtmlPost {
  messageId: number;
  username: string;
  title: string | null;
  contentText: string;
  url: string;
  publishedAt: number | null;
}

function isJsonObject(value: JsonValue | null): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readCursor(subscription: Subscription): TelegramHtmlCursor {
  if (subscription.cursor === null) return {};
  if (!isJsonObject(subscription.cursor)) throw new Error("Telegram HTML cursor must be an object");
  const { etag, lastModified, lastMessageId } = subscription.cursor;
  if (etag !== undefined && typeof etag !== "string") {
    throw new Error("Telegram HTML cursor etag must be a string");
  }
  if (lastModified !== undefined && typeof lastModified !== "string") {
    throw new Error("Telegram HTML cursor lastModified must be a string");
  }
  if (
    lastMessageId !== undefined &&
    (typeof lastMessageId !== "number" || !Number.isSafeInteger(lastMessageId) || lastMessageId < 0)
  ) {
    throw new Error("Telegram HTML cursor lastMessageId must be a non-negative integer");
  }
  return { etag, lastModified, lastMessageId };
}

function readMetadataValue(subscription: Subscription, key: string): number | undefined {
  if (!isJsonObject(subscription.metadata)) return undefined;
  const value = subscription.metadata[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function backfillLimit(subscription: Subscription): number {
  const value = readMetadataValue(subscription, "backfillLimit") ?? DEFAULT_BACKFILL_LIMIT;
  if (value > MAXIMUM_BACKFILL_LIMIT) {
    throw new Error(`backfillLimit must not exceed ${MAXIMUM_BACKFILL_LIMIT}`);
  }
  return value;
}

function initialDeliveryLimit(subscription: Subscription, limit: number): number {
  const value =
    readMetadataValue(subscription, "initialDeliveryLimit") ??
    Math.min(DEFAULT_INITIAL_DELIVERY_LIMIT, limit);
  if (value > limit) throw new Error("initialDeliveryLimit must not exceed backfillLimit");
  return value;
}

function safeHeader(value: string | null, name: string): string | undefined {
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

function classContains(node: HtmlElementNode, name: string): boolean {
  return (node.rawAttributes.class ?? "").split(/\s+/u).includes(name);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos|nbsp);/giu,
    (match, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal !== undefined || hexadecimal !== undefined) {
        const codePoint = Number.parseInt(decimal ?? hexadecimal ?? "", decimal ? 10 : 16);
        if (Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
          try {
            return String.fromCodePoint(codePoint);
          } catch {
            return match;
          }
        }
        return match;
      }
      return (
        { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " }[
          match.toLowerCase()
        ] ?? match
      );
    },
  );
}

function cleanText(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/gu, " ").trim();
}

function textWithoutNestedMessageText(node: HtmlElementNode): string {
  const parents = parentMap(node);
  const textNodes = allElements(node).filter((candidate) => {
    if (
      !classContains(candidate, "tgme_widget_message_text") ||
      !classContains(candidate, "js-message_text")
    ) {
      return false;
    }
    let parent = parents.get(candidate) ?? null;
    while (parent) {
      if (
        classContains(parent, "tgme_widget_message_text") &&
        classContains(parent, "js-message_text")
      ) {
        return false;
      }
      parent = parents.get(parent) ?? null;
    }
    return true;
  });
  return cleanText(textNodes.map(textContent).join("\n"));
}

function parsePost(node: HtmlElementNode): TelegramHtmlPost | null {
  const dataPost = node.rawAttributes["data-post"];
  const match = dataPost?.match(/^([A-Za-z][A-Za-z0-9_]{4,31})\/(\d+)$/u);
  if (!match?.[1] || !match[2]) return null;
  const messageId = Number(match[2]);
  if (!Number.isSafeInteger(messageId)) return null;
  const elements = allElements(node);
  const titleNode = elements.find((element) =>
    classContains(element, "tgme_widget_message_owner_name"),
  );
  const dateNode = elements.find(
    (element) => element.tag === "time" && typeof element.rawAttributes.datetime === "string",
  );
  const datetime = dateNode?.rawAttributes.datetime;
  const publishedAt = datetime ? Date.parse(datetime) : Number.NaN;
  const contentText = textWithoutNestedMessageText(node) || "[Telegram media]";
  const username = match[1].toLowerCase();
  return {
    messageId,
    username,
    title: titleNode ? cleanText(textContent(titleNode)) || null : null,
    contentText: [...contentText].slice(0, MAX_CONTENT_LENGTH).join(""),
    url: `https://t.me/${username}/${messageId}`,
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
  };
}

export function parseTelegramHtml(html: string): TelegramHtmlPost[] {
  const root = parseHtml(html);
  return allElements(root)
    .filter(
      (node) =>
        node.rawAttributes["data-post"] !== undefined && classContains(node, "tgme_widget_message"),
    )
    .map(parsePost)
    .filter((post): post is TelegramHtmlPost => post !== null)
    .sort((left, right) => left.messageId - right.messageId);
}

function itemFor(subscription: Subscription, post: TelegramHtmlPost): CanonicalItem {
  return {
    externalId: `telegram-html:${post.username}:${post.messageId}`,
    url: post.url,
    title: post.title || subscription.title || `Telegram @${post.username}`,
    summary: post.contentText.slice(0, 320),
    contentText: post.contentText,
    contentHtml: null,
    author: post.title || `@${post.username}`,
    publishedAt: post.publishedAt,
    sourceUpdatedAt: post.publishedAt,
    metadata: {
      telegram: {
        username: post.username,
        messageId: post.messageId,
        source: "public_html",
      },
    },
  };
}

function cursorJson(cursor: TelegramHtmlCursor): Record<string, JsonValue> {
  return {
    ...(cursor.etag ? { etag: cursor.etag } : {}),
    ...(cursor.lastModified ? { lastModified: cursor.lastModified } : {}),
    ...(cursor.lastMessageId === undefined ? {} : { lastMessageId: cursor.lastMessageId }),
  };
}

export class TelegramHtmlSourceAdapter implements SourcePoller {
  constructor(
    private readonly client: ProbeHttpClient,
    private readonly subscriptions: SubscriptionRepository,
    private readonly items: ItemRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async poll(subscriptionId: string): Promise<SourcePollResult> {
    const subscription = this.subscriptions.findById(subscriptionId);
    if (!subscription) throw new Error(`Subscription not found: ${subscriptionId}`);
    if (!subscription.enabled) throw new Error(`Subscription is disabled: ${subscriptionId}`);
    if (subscription.adapter !== "telegram_html") {
      throw new Error(
        `Subscription adapter must be telegram_html, received: ${subscription.adapter}`,
      );
    }

    const polledAt = this.now();
    const nextPollAt = polledAt + subscription.pollIntervalMinutes * 60_000;
    try {
      const cursor = readCursor(subscription);
      const response = await this.client.get(subscription.sourceUrl, () => HTML_LIMIT, {
        ...(cursor.etag ? { "If-None-Match": cursor.etag } : {}),
        ...(cursor.lastModified ? { "If-Modified-Since": cursor.lastModified } : {}),
      });
      const nextCursor: TelegramHtmlCursor = {
        etag: safeHeader(response.headers.get("etag"), "ETag") ?? cursor.etag,
        lastModified:
          safeHeader(response.headers.get("last-modified"), "Last-Modified") ?? cursor.lastModified,
        lastMessageId: cursor.lastMessageId,
      };
      if (response.status === 304) {
        const result = this.items.recordPoll({
          subscriptionId,
          items: [],
          cursor: cursorJson(nextCursor),
          polledAt,
          nextPollAt,
        });
        return { status: "not_modified", ...result };
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status} while polling ${subscription.sourceUrl}`);
      }
      if (!isHtmlContentType(response.headers.get("content-type"))) {
        throw new Error("Telegram public page returned an unsupported Content-Type");
      }

      const html = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
      const posts = parseTelegramHtml(html);
      if (posts.length === 0) throw new Error("Telegram public page contained no channel posts");
      const latestMessageId = posts.at(-1)?.messageId;
      if (latestMessageId !== undefined) {
        nextCursor.lastMessageId = Math.max(cursor.lastMessageId ?? 0, latestMessageId);
      }

      const selected =
        cursor.lastMessageId === undefined
          ? (() => {
              const limit = backfillLimit(subscription);
              return limit === 0 ? [] : posts.slice(-limit);
            })()
          : posts;
      if (selected.length === 0) {
        const result = this.items.recordPoll({
          subscriptionId,
          items: [],
          cursor: cursorJson(nextCursor),
          polledAt,
          nextPollAt,
        });
        return { status: "not_modified", ...result };
      }

      const initialDelivery =
        cursor.lastMessageId === undefined
          ? initialDeliveryLimit(subscription, selected.length)
          : selected.length;
      let insertedItems = 0;
      let updatedItems = 0;
      for (const [index, post] of selected.entries()) {
        const result = this.items.recordEvent({
          subscriptionId,
          item: itemFor(subscription, post),
          cursor: cursorJson(nextCursor),
          eventAt: polledAt,
          nextPollAt,
          notifyOnInsert:
            cursor.lastMessageId !== undefined && post.messageId > cursor.lastMessageId
              ? true
              : cursor.lastMessageId === undefined && index >= selected.length - initialDelivery,
        });
        insertedItems += result.insertedItems;
        updatedItems += result.updatedItems;
      }
      return {
        status: cursor.lastMessageId === undefined ? "backfilled" : "fetched",
        insertedItems,
        duplicateItems: updatedItems,
      };
    } catch (error) {
      this.subscriptions.recordFailure(subscriptionId, sanitizeErrorMessage(error), polledAt);
      throw error;
    }
  }
}
