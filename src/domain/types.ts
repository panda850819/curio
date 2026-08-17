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

export interface SubscriptionUpdate {
  title?: string | null;
  enabled?: boolean;
  pollIntervalMinutes?: number;
  metadata?: JsonValue;
}

export interface PageCursor {
  timestamp: number;
  id: string;
}

export interface RepositoryPage<T> {
  items: T[];
  hasMore: boolean;
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

export interface NewDestination {
  destinationKey: string;
  kind: "telegram";
  config: JsonValue;
  enabled?: boolean;
}

export interface DestinationUpdate {
  config?: JsonValue;
  enabled?: boolean;
}

export interface Route {
  id: string;
  subscriptionId: string;
  destinationId: string;
  enabled: boolean;
  config: JsonValue;
  createdAt: number;
  updatedAt: number;
}

export interface NewRoute {
  subscriptionId: string;
  destinationId: string;
  enabled?: boolean;
  config?: JsonValue;
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

export interface EventWrite {
  subscriptionId: string;
  item: CanonicalItem;
  cursor: JsonValue | null;
  eventAt: number;
  nextPollAt?: number | null;
  notifyOnInsert?: boolean;
}

export interface EventWriteResult {
  insertedItems: number;
  updatedItems: number;
}
