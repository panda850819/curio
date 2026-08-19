import {
  DuplicateSubscriptionError,
  type ItemRepository,
  type SubscriptionRepository,
} from "../../db/repositories.ts";
import type { Subscription } from "../../domain/types.ts";
import type { SourcePollResult } from "../../scheduler.ts";
import { normalizeEmail } from "./normalize.ts";
import {
  EMAIL_SOURCE_KEY,
  type EmailInbox,
  type EmailReceiveResult,
  type EmailSourceConfig,
  type InboundEmail,
} from "./types.ts";

export class EmailInboxUnavailableError extends Error {
  constructor(message = "Email inbox is not configured") {
    super(message);
    this.name = "EmailInboxUnavailableError";
  }
}

const EMAIL_SOURCE_URL = "email://shared-inbox";

export class EmailRecipientMismatchError extends Error {
  constructor() {
    super("Email recipient is not configured for this inbox");
    this.name = "EmailRecipientMismatchError";
  }
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

export class EmailSourceAdapter {
  constructor(
    private readonly config: EmailSourceConfig | null,
    private readonly subscriptions: SubscriptionRepository,
    private readonly items: ItemRepository,
    private readonly now: () => number = Date.now,
  ) {}

  get address(): string | null {
    return this.config?.address ?? null;
  }

  getInbox(): EmailInbox | null {
    if (!this.config) return null;
    const subscription = this.subscriptions.findBySource("email", EMAIL_SOURCE_KEY);
    return subscription ? { address: this.config.address, subscription } : null;
  }

  ensureSubscription(): Subscription {
    if (!this.config) throw new EmailInboxUnavailableError();
    const existing = this.subscriptions.findBySource("email", EMAIL_SOURCE_KEY);
    if (existing) return existing;
    try {
      return this.subscriptions.create({
        adapter: "email",
        sourceKey: EMAIL_SOURCE_KEY,
        sourceUrl: EMAIL_SOURCE_URL,
        title: "Email Inbox",
        nextPollAt: null,
        pollIntervalMinutes: 60,
        metadata: { mode: "shared-inbox", address: this.config.address },
      });
    } catch (error) {
      if (!(error instanceof DuplicateSubscriptionError)) throw error;
      const restored = this.subscriptions.findBySource("email", EMAIL_SOURCE_KEY);
      if (!restored) throw error;
      return restored;
    }
  }

  async poll(_subscriptionId: string): Promise<SourcePollResult> {
    throw new Error("Email source subscriptions are event-driven and cannot be polled");
  }

  receive(input: InboundEmail): EmailReceiveResult {
    if (!this.config) throw new EmailInboxUnavailableError();
    if (normalizeAddress(input.recipient) !== normalizeAddress(this.config.address)) {
      throw new EmailRecipientMismatchError();
    }
    const subscription = this.subscriptions.findBySource("email", EMAIL_SOURCE_KEY);
    if (!subscription || !subscription.enabled) {
      throw new EmailInboxUnavailableError("Email inbox is disabled");
    }
    const eventAt = this.now();
    const item = normalizeEmail(input, eventAt);
    const result = this.items.recordEvent({
      subscriptionId: subscription.id,
      item,
      cursor: input.messageId ? { lastMessageId: input.messageId } : { lastReceivedAt: eventAt },
      eventAt,
      nextPollAt: null,
    });
    return {
      subscriptionId: subscription.id,
      externalId: item.externalId,
      insertedItems: result.insertedItems,
      updatedItems: result.updatedItems,
    };
  }
}
