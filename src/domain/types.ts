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
}

export interface PollWriteResult {
  insertedItems: number;
  duplicateItems: number;
}
