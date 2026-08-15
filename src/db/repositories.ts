import type { Database } from "bun:sqlite";
import type {
  CanonicalItem,
  Item,
  JsonValue,
  NewSubscription,
  PollWrite,
  PollWriteResult,
  Subscription,
} from "../domain/types.ts";

interface SubscriptionRow {
  id: string;
  adapter: string;
  source_key: string;
  source_url: string;
  title: string | null;
  enabled: number;
  cursor_json: string | null;
  metadata_json: string;
  last_polled_at: number | null;
  last_success_at: number | null;
  next_poll_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface ItemRow {
  id: string;
  subscription_id: string;
  external_id: string;
  url: string | null;
  title: string | null;
  summary: string | null;
  content_text: string | null;
  content_html: string | null;
  author: string | null;
  published_at: number | null;
  source_updated_at: number | null;
  discovered_at: number;
  created_at: number;
  updated_at: number;
  metadata_json: string;
}

export class DuplicateSubscriptionError extends Error {
  constructor(adapter: string, sourceKey: string) {
    super(`Subscription already exists: ${adapter}/${sourceKey}`);
    this.name = "DuplicateSubscriptionError";
  }
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function serializeJson(value: JsonValue): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Value is not JSON serializable");
  return serialized;
}

function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function mapSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    adapter: row.adapter,
    sourceKey: row.source_key,
    sourceUrl: row.source_url,
    title: row.title,
    enabled: row.enabled === 1,
    cursor: row.cursor_json === null ? null : parseJson(row.cursor_json),
    metadata: parseJson(row.metadata_json),
    lastPolledAt: row.last_polled_at,
    lastSuccessAt: row.last_success_at,
    nextPollAt: row.next_poll_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapItem(row: ItemRow): Item {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    summary: row.summary,
    contentText: row.content_text,
    contentHtml: row.content_html,
    author: row.author,
    publishedAt: row.published_at,
    sourceUpdatedAt: row.source_updated_at,
    discoveredAt: row.discovered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson(row.metadata_json),
  };
}

export class SubscriptionRepository {
  constructor(
    private readonly database: Database,
    private readonly generateId: () => string = () => Bun.randomUUIDv7(),
    private readonly now: () => number = Date.now,
  ) {}

  create(input: NewSubscription): Subscription {
    const adapter = requireNonEmpty(input.adapter, "adapter");
    const sourceKey = requireNonEmpty(input.sourceKey, "sourceKey");
    const sourceUrl = requireNonEmpty(input.sourceUrl, "sourceUrl");
    const metadataJson = input.metadata === undefined ? undefined : serializeJson(input.metadata);
    const timestamp = this.now();

    const createOrRestore = this.database.transaction(() => {
      const existing = this.database
        .query<SubscriptionRow, [string, string]>(
          "SELECT * FROM subscriptions WHERE adapter = ? AND source_key = ?",
        )
        .get(adapter, sourceKey);

      if (existing && existing.deleted_at === null) {
        throw new DuplicateSubscriptionError(adapter, sourceKey);
      }

      if (existing) {
        const restored = this.database
          .query<SubscriptionRow, [string, string | null, string, number | null, number, string]>(
            `UPDATE subscriptions
             SET source_url = ?, title = ?, metadata_json = ?, next_poll_at = ?,
                 enabled = 1, deleted_at = NULL, updated_at = ?
             WHERE id = ?
             RETURNING *`,
          )
          .get(
            sourceUrl,
            input.title === undefined ? existing.title : input.title,
            metadataJson ?? existing.metadata_json,
            input.nextPollAt === undefined ? existing.next_poll_at : input.nextPollAt,
            timestamp,
            existing.id,
          );
        if (!restored) throw new Error("Failed to restore subscription");
        return mapSubscription(restored);
      }

      const created = this.database
        .query<
          SubscriptionRow,
          [string, string, string, string, string | null, string, number | null, number, number]
        >(
          `INSERT INTO subscriptions (
             id, adapter, source_key, source_url, title, metadata_json, next_poll_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`,
        )
        .get(
          this.generateId(),
          adapter,
          sourceKey,
          sourceUrl,
          input.title ?? null,
          metadataJson ?? "{}",
          input.nextPollAt ?? null,
          timestamp,
          timestamp,
        );
      if (!created) throw new Error("Failed to create subscription");
      return mapSubscription(created);
    });

    return createOrRestore();
  }

  findById(id: string): Subscription | null {
    const row = this.database
      .query<SubscriptionRow, [string]>(
        "SELECT * FROM subscriptions WHERE id = ? AND deleted_at IS NULL",
      )
      .get(id);
    return row ? mapSubscription(row) : null;
  }

  listDue(timestamp: number, limit = 100): Subscription[] {
    return this.database
      .query<SubscriptionRow, [number, number]>(
        `SELECT * FROM subscriptions
         WHERE enabled = 1 AND deleted_at IS NULL
           AND (next_poll_at IS NULL OR next_poll_at <= ?)
         ORDER BY COALESCE(next_poll_at, 0), created_at
         LIMIT ?`,
      )
      .all(timestamp, limit)
      .map(mapSubscription);
  }

  setEnabled(id: string, enabled: boolean): Subscription | null {
    const row = this.database
      .query<SubscriptionRow, [number, number, string]>(
        `UPDATE subscriptions SET enabled = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL RETURNING *`,
      )
      .get(enabled ? 1 : 0, this.now(), id);
    return row ? mapSubscription(row) : null;
  }

  softDelete(id: string): boolean {
    const timestamp = this.now();
    const result = this.database
      .query<never, [number, number, string]>(
        `UPDATE subscriptions SET enabled = 0, deleted_at = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(timestamp, timestamp, id);
    return result.changes === 1;
  }
}

export class ItemRepository {
  constructor(
    private readonly database: Database,
    private readonly generateId: () => string = () => Bun.randomUUIDv7(),
  ) {}

  listBySubscription(subscriptionId: string, limit = 100): Item[] {
    return this.database
      .query<ItemRow, [string, number]>(
        `SELECT * FROM items WHERE subscription_id = ?
         ORDER BY COALESCE(published_at, discovered_at) DESC, discovered_at DESC
         LIMIT ?`,
      )
      .all(subscriptionId, limit)
      .map(mapItem);
  }

  recordPoll(write: PollWrite): PollWriteResult {
    const preparedItems = write.items.map((item) => this.prepareItem(item));
    const cursorJson = serializeJson(write.cursor);

    const persist = this.database.transaction(() => {
      const subscription = this.database
        .query<SubscriptionRow, [string]>(
          `SELECT * FROM subscriptions
           WHERE id = ? AND enabled = 1 AND deleted_at IS NULL`,
        )
        .get(write.subscriptionId);
      if (!subscription) {
        throw new Error(`Subscription is missing or inactive: ${write.subscriptionId}`);
      }

      const insert = this.database.prepare(
        `INSERT INTO items (
           id, subscription_id, external_id, url, title, summary, content_text, content_html,
           author, published_at, source_updated_at, discovered_at, created_at, updated_at,
           metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (subscription_id, external_id) DO NOTHING`,
      );

      let insertedItems = 0;
      for (const item of preparedItems) {
        const result = insert.run(
          this.generateId(),
          write.subscriptionId,
          item.externalId,
          item.url,
          item.title,
          item.summary,
          item.contentText,
          item.contentHtml,
          item.author,
          item.publishedAt,
          item.sourceUpdatedAt,
          write.polledAt,
          write.polledAt,
          write.polledAt,
          item.metadataJson,
        );
        insertedItems += result.changes;
      }

      const nextPollAt =
        write.nextPollAt === undefined ? subscription.next_poll_at : write.nextPollAt;
      const update = this.database
        .query<never, [string, number, number, number | null, number, string]>(
          `UPDATE subscriptions
           SET cursor_json = ?, last_polled_at = ?, last_success_at = ?, next_poll_at = ?,
               updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(
          cursorJson,
          write.polledAt,
          write.polledAt,
          nextPollAt,
          write.polledAt,
          write.subscriptionId,
        );
      if (update.changes !== 1) throw new Error("Failed to update subscription cursor");

      return {
        insertedItems,
        duplicateItems: preparedItems.length - insertedItems,
      };
    });

    return persist();
  }

  private prepareItem(item: CanonicalItem): {
    externalId: string;
    url: string | null;
    title: string | null;
    summary: string | null;
    contentText: string | null;
    contentHtml: string | null;
    author: string | null;
    publishedAt: number | null;
    sourceUpdatedAt: number | null;
    metadataJson: string;
  } {
    return {
      externalId: requireNonEmpty(item.externalId, "externalId"),
      url: item.url ?? null,
      title: item.title ?? null,
      summary: item.summary ?? null,
      contentText: item.contentText ?? null,
      contentHtml: item.contentHtml ?? null,
      author: item.author ?? null,
      publishedAt: item.publishedAt ?? null,
      sourceUpdatedAt: item.sourceUpdatedAt ?? null,
      metadataJson: serializeJson(item.metadata ?? {}),
    };
  }
}
