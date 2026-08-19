import type { SubscriptionRepository } from "../db/repositories.ts";
import type { SourcePoller, SourcePollResult } from "../scheduler.ts";
import { youtubeChannelIdFromFeedUrl } from "./youtube/probe.ts";

export class SourceRouter implements SourcePoller {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly pollers: Readonly<Record<string, SourcePoller>>,
  ) {}

  poll(subscriptionId: string): Promise<SourcePollResult> {
    const subscription = this.subscriptions.findById(subscriptionId);
    if (!subscription) return Promise.reject(new Error("Subscription not found"));
    const legacyYoutubeFeed =
      subscription.adapter === "rss" &&
      youtubeChannelIdFromFeedUrl(subscription.sourceUrl) !== null;
    const adapter = legacyYoutubeFeed ? "youtube" : subscription.adapter;
    const poller = this.pollers[adapter];
    if (!poller) return Promise.reject(new Error(`Unsupported source adapter: ${adapter}`));
    return poller.poll(subscriptionId);
  }
}
