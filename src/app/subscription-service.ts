import {
  DuplicateSubscriptionError,
  type ItemRepository,
  type SubscriptionRepository,
} from "../db/repositories.ts";
import type {
  Item,
  JsonValue,
  PageCursor,
  Subscription,
  SubscriptionUpdate,
} from "../domain/types.ts";
import { PollAlreadyRunningError, type SourcePoller } from "../scheduler.ts";
import { AppError } from "./errors.ts";
import { type Page, pageResult } from "./pagination.ts";
import type {
  FollowInput,
  FollowResult,
  ProbeService,
  SubscriptionService as SubscriptionServiceContract,
} from "./types.ts";

const MINIMUM_POLL_INTERVAL_MINUTES = 5;
const MAXIMUM_POLL_INTERVAL_MINUTES = 10_080;
const DEFAULT_LIST_LIMIT = 100;
const MAXIMUM_LIST_LIMIT = 500;
const DEFAULT_BACKFILL_LIMIT = 20;
const MAXIMUM_METADATA_LIMIT = 500;
const SUBSCRIPTION_METADATA_FIELDS = new Set([
  "backfillLimit",
  "initialDeliveryLimit",
  "selector",
  "notifyOnFirstPoll",
]);

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new AppError("validation", "invalid_input", `${field} must not be empty`);
  return normalized;
}

function requireLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_LIST_LIMIT) {
    throw new AppError(
      "validation",
      "invalid_limit",
      `limit must be an integer between 1 and ${MAXIMUM_LIST_LIMIT}`,
    );
  }
  return limit;
}

function requireInterval(intervalMinutes: number): number {
  if (
    !Number.isSafeInteger(intervalMinutes) ||
    intervalMinutes < MINIMUM_POLL_INTERVAL_MINUTES ||
    intervalMinutes > MAXIMUM_POLL_INTERVAL_MINUTES
  ) {
    throw new AppError(
      "validation",
      "invalid_poll_interval",
      `poll interval must be an integer between ${MINIMUM_POLL_INTERVAL_MINUTES} and ${MAXIMUM_POLL_INTERVAL_MINUTES} minutes`,
    );
  }
  return intervalMinutes;
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

function validateMetadata(value: JsonValue | undefined, base: JsonValue = {}): JsonValue {
  if (value === undefined) return base;
  if (!isJsonObject(value)) {
    throw new AppError("validation", "invalid_metadata", "metadata must be a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (!SUBSCRIPTION_METADATA_FIELDS.has(key)) {
      throw new AppError(
        "validation",
        "invalid_metadata_field",
        `Unsupported metadata field: ${key}`,
      );
    }
    const field = value[key];
    if (key === "selector") {
      if (
        typeof field !== "string" ||
        !field.trim() ||
        field.length > 512 ||
        [...field].some((character) => (character.codePointAt(0) ?? 0) < 32)
      ) {
        throw new AppError(
          "validation",
          "invalid_metadata_value",
          "selector must be a printable string of at most 512 characters",
        );
      }
      continue;
    }
    if (key === "notifyOnFirstPoll") {
      if (typeof field !== "boolean") {
        throw new AppError(
          "validation",
          "invalid_metadata_value",
          "notifyOnFirstPoll must be a boolean",
        );
      }
      continue;
    }
    if (
      typeof field !== "number" ||
      !Number.isSafeInteger(field) ||
      field < 0 ||
      field > MAXIMUM_METADATA_LIMIT
    ) {
      throw new AppError(
        "validation",
        "invalid_metadata_value",
        `${key} must be an integer between 0 and ${MAXIMUM_METADATA_LIMIT}`,
      );
    }
  }
  const merged: Record<string, JsonValue> = isJsonObject(base)
    ? { ...base, ...value }
    : { ...value };
  const backfillLimit = merged.backfillLimit ?? DEFAULT_BACKFILL_LIMIT;
  const initialDeliveryLimit = merged.initialDeliveryLimit;
  if (
    typeof backfillLimit !== "number" ||
    !Number.isSafeInteger(backfillLimit) ||
    backfillLimit < 0 ||
    backfillLimit > MAXIMUM_METADATA_LIMIT
  ) {
    throw new AppError("validation", "invalid_metadata_value", "backfillLimit is invalid");
  }
  if (
    initialDeliveryLimit !== undefined &&
    (typeof initialDeliveryLimit !== "number" || initialDeliveryLimit > backfillLimit)
  ) {
    throw new AppError(
      "validation",
      "invalid_metadata_value",
      "initialDeliveryLimit must not exceed backfillLimit",
    );
  }
  return merged;
}

export class DefaultSubscriptionService implements SubscriptionServiceContract {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly coordinator: SourcePoller,
    private readonly now: () => number = Date.now,
    private readonly probeService?: ProbeService,
    private readonly items?: ItemRepository,
  ) {}

  follow(input: FollowInput): FollowResult {
    const candidate = input.candidate;
    const adapter = requireText(candidate.adapter, "candidate adapter");
    const sourceKey = requireText(candidate.sourceKey, "candidate source key");
    const sourceUrl = requireText(candidate.sourceUrl, "candidate source URL");
    const intervalMinutes = requireInterval(input.intervalMinutes);
    const metadata = validateMetadata(input.metadata);

    try {
      const subscription = this.subscriptions.create({
        adapter,
        sourceKey,
        sourceUrl,
        title: candidate.title?.trim() || null,
        metadata,
        nextPollAt: this.now(),
        pollIntervalMinutes: intervalMinutes,
      });
      return { subscription, disposition: "created" };
    } catch (error) {
      if (!(error instanceof DuplicateSubscriptionError)) throw error;
      const existing = this.subscriptions.findBySource(adapter, sourceKey);
      if (!existing) throw error;
      return { subscription: existing, disposition: "existing" };
    }
  }

  async followVerified(input: FollowInput): Promise<FollowResult> {
    if (!this.probeService) {
      throw new AppError("unexpected", "probe_unavailable", "Probe service is unavailable");
    }
    const result = await this.probeService.probe(input.candidate.sourceUrl);
    const verified = result.candidates.find(
      (candidate) =>
        candidate.adapter === input.candidate.adapter &&
        candidate.sourceKey === input.candidate.sourceKey &&
        candidate.sourceUrl === input.candidate.sourceUrl,
    );
    if (!verified) {
      throw new AppError(
        "validation",
        "candidate_invalid",
        "Probe candidate is no longer available",
        { candidates: result.candidates },
      );
    }
    return this.follow({ ...input, candidate: verified });
  }

  list(limit = DEFAULT_LIST_LIMIT): Subscription[] {
    return this.subscriptions.list(requireLimit(limit));
  }

  listPage(limit = DEFAULT_LIST_LIMIT, cursor?: PageCursor): Page<Subscription> {
    const result = this.subscriptions.listPage(requireLimit(limit), cursor);
    return pageResult(result.items, result.hasMore, (item) => ({
      timestamp: item.createdAt,
      id: item.id,
    }));
  }

  get(id: string): Subscription {
    const subscriptionId = requireText(id, "subscription ID");
    const subscription = this.subscriptions.findById(subscriptionId);
    if (!subscription) {
      throw new AppError("not_found", "subscription_not_found", "Subscription not found");
    }
    return subscription;
  }

  resolve(target: string): Subscription {
    const value = requireText(target, "subscription target");
    const byId = this.subscriptions.findById(value);
    if (byId) return byId;

    const byUrl = this.subscriptions.findBySourceUrl(value);
    if (byUrl.length === 0) {
      throw new AppError("not_found", "subscription_not_found", "Subscription not found");
    }
    if (byUrl.length > 1) {
      throw new AppError(
        "conflict",
        "subscription_ambiguous",
        "Source URL matches multiple subscriptions",
      );
    }
    return byUrl[0] as Subscription;
  }

  pause(id: string): Subscription {
    return this.update(id, { enabled: false });
  }

  resume(id: string): Subscription {
    return this.update(id, { enabled: true });
  }

  remove(id: string): { id: string } {
    const subscription = this.get(id);
    if (!this.subscriptions.softDelete(subscription.id)) {
      throw new AppError("not_found", "subscription_not_found", "Subscription not found");
    }
    return { id: subscription.id };
  }

  update(id: string, input: SubscriptionUpdate): Subscription {
    const existing = this.get(id);
    const intervalMinutes =
      input.pollIntervalMinutes === undefined
        ? undefined
        : requireInterval(input.pollIntervalMinutes);
    const metadata =
      input.metadata === undefined
        ? undefined
        : validateMetadata(input.metadata, existing.metadata);
    const title =
      input.title === undefined ? undefined : input.title === null ? null : input.title.trim();
    const updated = this.subscriptions.update(existing.id, {
      title,
      enabled: input.enabled,
      pollIntervalMinutes: intervalMinutes,
      metadata,
    });
    if (!updated)
      throw new AppError("not_found", "subscription_not_found", "Subscription not found");
    return updated;
  }

  listItemsPage(
    limit = DEFAULT_LIST_LIMIT,
    subscriptionId?: string,
    cursor?: PageCursor,
  ): Page<Item> {
    if (subscriptionId !== undefined) this.get(subscriptionId);
    if (!this.items) {
      throw new AppError("unexpected", "items_unavailable", "Item service is unavailable");
    }
    const result = this.items.listTimelinePage(requireLimit(limit), subscriptionId, cursor);
    return pageResult(result.items, result.hasMore, (item) => ({
      timestamp: item.publishedAt ?? item.discoveredAt,
      id: item.id,
    }));
  }

  async poll(id: string) {
    const subscription = this.get(id);
    try {
      return await this.coordinator.poll(subscription.id);
    } catch (error) {
      if (error instanceof PollAlreadyRunningError) {
        throw new AppError("conflict", "poll_in_progress", error.message, undefined, {
          cause: error,
        });
      }
      throw error;
    }
  }
}

export { requireInterval, validateMetadata };
