import type { ItemRepository, SubscriptionRepository } from "../../db/repositories.ts";
import type { JsonValue, Subscription } from "../../domain/types.ts";
import type { SourcePollResult } from "../../scheduler.ts";
import { sanitizeErrorMessage } from "../../security/redaction.ts";
import type { XbirdTimelineClient, XTweet } from "./types.ts";

const DEFAULT_BACKFILL_LIMIT = 20;
const DEFAULT_INITIAL_DELIVERY_LIMIT = 1;
const MAXIMUM_BACKFILL_LIMIT = 20;

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function limits(subscription: Subscription): { backfill: number; initialDelivery: number } {
  const metadata = isObject(subscription.metadata) ? subscription.metadata : {};
  const backfill = metadata.backfillLimit ?? DEFAULT_BACKFILL_LIMIT;
  if (
    typeof backfill !== "number" ||
    !Number.isSafeInteger(backfill) ||
    backfill < 0 ||
    backfill > MAXIMUM_BACKFILL_LIMIT
  ) {
    throw new Error(`backfillLimit must be an integer between 0 and ${MAXIMUM_BACKFILL_LIMIT}`);
  }
  const initialDelivery =
    metadata.initialDeliveryLimit ?? Math.min(DEFAULT_INITIAL_DELIVERY_LIMIT, backfill);
  if (
    typeof initialDelivery !== "number" ||
    !Number.isSafeInteger(initialDelivery) ||
    initialDelivery < 0 ||
    initialDelivery > backfill
  ) {
    throw new Error(
      `initialDeliveryLimit must be an integer between 0 and backfillLimit (${backfill})`,
    );
  }
  return { backfill, initialDelivery };
}

function normalizeTweet(tweet: XTweet): {
  item: import("../../domain/types.ts").CanonicalItem;
  publishedAt: number;
} {
  if (!/^\d+$/.test(tweet.id)) throw new Error("X source returned an invalid post ID");
  if (
    !tweet.author ||
    typeof tweet.author.username !== "string" ||
    typeof tweet.author.name !== "string"
  ) {
    throw new Error("X source returned an invalid author");
  }
  const publishedAt = Date.parse(tweet.createdAt ?? "");
  if (!Number.isFinite(publishedAt))
    throw new Error("X source returned an invalid publication date");
  const text = typeof tweet.text === "string" ? tweet.text.trim() : "";
  const title =
    tweet.article?.title?.trim() || text.split(/\r?\n/, 1)[0]?.slice(0, 180) || "X post";
  const username = tweet.author.username;
  return {
    publishedAt,
    item: {
      externalId: tweet.id,
      url: `https://x.com/${encodeURIComponent(username)}/status/${tweet.id}`,
      title,
      summary: text || tweet.article?.previewText?.trim() || null,
      contentText: text || null,
      author: `${tweet.author.name} (@${username})`,
      publishedAt,
      metadata: {
        platform: "x",
        username,
        conversationId: tweet.conversationId ?? null,
        quotedTweetId: tweet.quotedTweet?.id ?? null,
        media: (tweet.media ?? []).slice(0, 4).map((media) => ({
          type: media.type ?? null,
          url: media.url ?? media.videoUrl ?? null,
          previewUrl: media.previewUrl ?? null,
          width: media.width ?? null,
          height: media.height ?? null,
        })),
      },
    },
  };
}

export class XSourceAdapter {
  constructor(
    private readonly client: XbirdTimelineClient,
    private readonly subscriptions: SubscriptionRepository,
    private readonly items: ItemRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async poll(subscriptionId: string): Promise<SourcePollResult> {
    const subscription = this.subscriptions.findById(subscriptionId);
    if (!subscription || !subscription.enabled) throw new Error("Subscription is not active");
    if (subscription.adapter !== "x") {
      throw new Error(`Subscription adapter must be x, received: ${subscription.adapter}`);
    }
    const polledAt = this.now();
    const nextPollAt = polledAt + subscription.pollIntervalMinutes * 60_000;
    try {
      const firstPoll = subscription.cursor === null;
      const policy = limits(subscription);
      const tweets = await this.client.userTweets(
        subscription.sourceKey,
        Math.max(policy.backfill, 20),
      );
      const selected = tweets
        .filter(
          (tweet) =>
            !tweet.inReplyToStatusId &&
            !/^RT @/i.test(tweet.text) &&
            tweet.author.username.toLowerCase() === subscription.sourceKey.toLowerCase(),
        )
        .map(normalizeTweet)
        .sort((left, right) => right.publishedAt - left.publishedAt)
        .slice(0, firstPoll ? policy.backfill : MAXIMUM_BACKFILL_LIMIT);
      const result = this.items.recordPoll({
        subscriptionId,
        items: selected.map((entry) => entry.item),
        cursor: { initialized: true },
        polledAt,
        nextPollAt,
        deliveryExternalIds: firstPoll
          ? selected.slice(0, policy.initialDelivery).map((entry) => entry.item.externalId)
          : undefined,
      });
      return { status: "fetched", ...result };
    } catch (error) {
      this.subscriptions.recordFailure(subscriptionId, sanitizeErrorMessage(error), polledAt);
      throw error;
    }
  }
}
