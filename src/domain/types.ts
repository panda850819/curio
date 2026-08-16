export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface Subscription {
  id: string;
  adapter: string;
  sourceKey: string;
  sourceUrl: string;
  title: string | null;
  enabled: boolean;
  cursor: JsonValue | null;
  metadata: JsonValue;
  lastPolledAt: number | null;
  lastSuccessAt: number | null;
  nextPollAt: number | null;
  pollIntervalMinutes: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastFailedAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface NewSubscription {
  adapter: string;
  sourceKey: string;
  sourceUrl: string;
  title?: string | null;
  metadata?: JsonValue;
  nextPollAt?: number | null;
  pollIntervalMinutes?: number;
}

export interface PollFailureEvent {
  id: string;
  subscriptionId: string;
  attempt: number;
  error: string;
  failedAt: number;
  createdAt: number;
  deliveredAt: number | null;
}

export type DeliveryStatus =
  | "pending"
  | "processing"
  | "retry_scheduled"
  | "delivered"
  | "uncertain"
  | "permanent_failure";

export interface Destination {
  id: string;
  destinationKey: string;
  kind: "telegram";
  config: JsonValue;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Delivery {
  id: string;
  destinationId: string;
  itemId: string | null;
  failureEventId: string | null;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: number | null;
  telegramMessageId: number | null;
  lastError: string | null;
  claimedAt: number | null;
  deliveredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  attempt: number;
  outcome: "delivered" | "retry" | "uncertain" | "permanent_failure";
  httpStatus: number | null;
  error: string | null;
  startedAt: number;
  finishedAt: number;
}

export interface CanonicalItem {
  externalId: string;
  url?: string | null;
  title?: string | null;
  summary?: string | null;
  contentText?: string | null;
  contentHtml?: string | null;
  author?: string | null;
  publishedAt?: number | null;
  sourceUpdatedAt?: number | null;
  metadata?: JsonValue;
}

export interface Item extends CanonicalItem {
  id: string;
  subscriptionId: string;
  discoveredAt: number;
  createdAt: number;
  updatedAt: number;
  metadata: JsonValue;
}

export interface PollWrite {
  subscriptionId: string;
  items: CanonicalItem[];
  cursor: JsonValue | null;
  polledAt: number;
  nextPollAt?: number | null;
  deliveryExternalIds?: string[];
}

export interface PollWriteResult {
  insertedItems: number;
  duplicateItems: number;
}
