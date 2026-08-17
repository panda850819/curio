import type { ItemRepository, SubscriptionRepository } from "../../db/repositories.ts";
import type { CanonicalItem, Subscription } from "../../domain/types.ts";
import type { SourcePoller, SourcePollResult } from "../../scheduler.ts";
import type { TelegramChannelPost, TelegramChannelPostHandler } from "./types.ts";
import { telegramChatSourceKey, telegramMessageUrl, telegramUsernameSourceKey } from "./url.ts";

const MAX_CONTENT_LENGTH = 64 * 1024;
const SUMMARY_LENGTH = 320;

function trimContent(value: string): string {
  return [...value.trim()].slice(0, MAX_CONTENT_LENGTH).join("");
}

function summaryFor(value: string): string {
  const summary = [...value].slice(0, SUMMARY_LENGTH).join("");
  return summary.length < value.length ? `${summary}…` : summary;
}

function itemTitle(value: string, messageId: number): string {
  const firstLine = value.split(/\r?\n/u, 1)[0]?.trim();
  return firstLine ? [...firstLine].slice(0, 160).join("") : `Telegram post #${messageId}`;
}

function itemFor(post: TelegramChannelPost): CanonicalItem {
  const content = trimContent(post.text || "[Telegram media]");
  const username = post.chat.username;
  const publishedAt = post.date * 1_000;
  const sourceUpdatedAt = (post.editDate ?? post.date) * 1_000;
  return {
    externalId: `telegram:${post.chat.id}:${post.messageId}`,
    url: telegramMessageUrl(username, post.messageId),
    title: itemTitle(content, post.messageId),
    summary: summaryFor(content),
    contentText: content,
    contentHtml: null,
    author: username ? `@${username}` : post.chat.title,
    publishedAt,
    sourceUpdatedAt,
    metadata: {
      telegram: {
        chatId: post.chat.id,
        messageId: post.messageId,
        updateId: post.updateId,
        edited: post.editDate !== null,
      },
    },
  };
}

function matches(post: TelegramChannelPost, subscription: Subscription): boolean {
  if (subscription.adapter !== "telegram") return false;
  if (
    post.chat.username &&
    subscription.sourceKey === telegramUsernameSourceKey(post.chat.username)
  ) {
    return true;
  }
  return subscription.sourceKey === telegramChatSourceKey(post.chat.id);
}

export class TelegramSourceAdapter implements SourcePoller, TelegramChannelPostHandler {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly items: ItemRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async poll(_subscriptionId: string): Promise<SourcePollResult> {
    throw new Error("Telegram source subscriptions are event-driven and cannot be polled");
  }

  handleChannelPost(post: TelegramChannelPost): void {
    const subscriptions = this.subscriptions
      .list(500)
      .filter((subscription) => subscription.enabled && matches(post, subscription));
    const item = itemFor(post);
    const eventAt = this.now();
    for (const subscription of subscriptions) {
      this.items.recordEvent({
        subscriptionId: subscription.id,
        item,
        cursor: { lastUpdateId: post.updateId },
        eventAt,
        notifyOnInsert: post.editDate === null,
      });
    }
  }
}
