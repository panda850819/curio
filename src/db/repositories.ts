import type { Database } from "bun:sqlite";
import type {
  CanonicalItem,
  EventWrite,
  EventWriteResult,
  Item,
  JsonValue,
  NewSubscription,
  PageCursor,
  PollFailureEvent,
  PollWrite,
  PollWriteResult,
  RepositoryPage,
  Subscription,
  SubscriptionUpdate,
} from "../domain/types.ts";
import { sanitizeErrorMessage } from "../security/redaction.ts";
import { RouteRepository } from "./routing-repositories.ts";

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
  poll_interval_minutes: number;
  consecutive_failures: number;
  last_error: string | null;
  last_failed_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface PollFailureEventRow {
  id: string;
  subscription_id: string;
  attempt: number;
  error: string;
  failed_at: number;
  created_at: number;
  delivered_at: number | null;
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

function requireLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  return limit;
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
    pollIntervalMinutes: row.poll_interval_minutes,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    lastFailedAt: row.last_failed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapFailureEvent(row: PollFailureEventRow): PollFailureEvent {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    attempt: row.attempt,
    error: row.error,
    failedAt: row.failed_at,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
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
  private readonly routes: RouteRepository;

  constructor(
    private readonly database: Database,
    private readonly generateId: () => string = () => Bun.randomUUIDv7(),
    private readonly now: () => number = Date.now,
    routes?: RouteRepository,
  ) {
    this.routes = routes ?? new RouteRepository(database, generateId, now);
  }

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
          .query<
            SubscriptionRow,
            [string, string | null, string, number | null, number, number, string]
          >(
            `UPDATE subscriptions
             SET source_url = ?, title = ?, metadata_json = ?, next_poll_at = ?,
                 poll_interval_minutes = ?, enabled = 1, deleted_at = NULL, updated_at = ?
             WHERE id = ?
             RETURNING *`,
          )
          .get(
            sourceUrl,
            input.title === undefined ? existing.title : input.title,
            metadataJson ?? existing.metadata_json,
            input.nextPollAt === undefined ? existing.next_poll_at : input.nextPollAt,
            input.pollIntervalMinutes ?? existing.poll_interval_minutes,
            timestamp,
            existing.id,
          );
        if (!restored) throw new Error("Failed to restore subscription");
        const hasRouteSchema = this.database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'routes'",
          )
          .get()?.count;
        if (hasRouteSchema === 1 && existing.deleted_at !== null) {
          this.routes.ensureCompatibilityForRestoredSubscription(
            existing.id,
            existing.deleted_at,
            timestamp,
          );
        }
        return mapSubscription(restored);
      }

      const created = this.database
        .query<
          SubscriptionRow,
          [
            string,
            string,
            string,
            string,
            string | null,
            string,
            number | null,
            number,
            number,
            number,
          ]
        >(
          `INSERT INTO subscriptions (
             id, adapter, source_key, source_url, title, metadata_json, next_poll_at,
             poll_interval_minutes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          input.pollIntervalMinutes ?? 60,
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

  list(limit = 100): Subscription[] {
    return this.database
      .query<SubscriptionRow, [number]>(
        `SELECT * FROM subscriptions
         WHERE deleted_at IS NULL
         ORDER BY created_at, id
         LIMIT ?`,
      )
      .all(limit)
      .map(mapSubscription);
  }

  listPage(limit = 100, cursor?: PageCursor): RepositoryPage<Subscription> {
    const boundedLimit = requireLimit(limit);
    const rows = cursor
      ? this.database
          .query<SubscriptionRow, [number, number, string, number]>(
            `SELECT * FROM subscriptions
             WHERE deleted_at IS NULL
               AND (created_at > ? OR (created_at = ? AND id > ?))
             ORDER BY created_at, id
             LIMIT ?`,
          )
          .all(cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)
      : this.database
          .query<SubscriptionRow, [number]>(
            `SELECT * FROM subscriptions
             WHERE deleted_at IS NULL
             ORDER BY created_at, id
             LIMIT ?`,
          )
          .all(boundedLimit + 1);
    return {
      items: rows.slice(0, boundedLimit).map(mapSubscription),
      hasMore: rows.length > boundedLimit,
    };
  }

  findBySource(adapter: string, sourceKey: string): Subscription | null {
    const row = this.database
      .query<SubscriptionRow, [string, string]>(
        `SELECT * FROM subscriptions
         WHERE adapter = ? AND source_key = ? AND deleted_at IS NULL`,
      )
      .get(adapter, sourceKey);
    return row ? mapSubscription(row) : null;
  }

  findBySourceUrl(sourceUrl: string): Subscription[] {
    return this.database
      .query<SubscriptionRow, [string]>(
        `SELECT * FROM subscriptions
         WHERE source_url = ? AND deleted_at IS NULL
         ORDER BY created_at, id`,
      )
      .all(sourceUrl)
      .map(mapSubscription);
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

  update(id: string, input: SubscriptionUpdate): Subscription | null {
    const existing = this.findById(id);
    if (!existing) return null;
    const enabled = input.enabled === undefined ? existing.enabled : input.enabled;
    const intervalMinutes =
      input.pollIntervalMinutes === undefined
        ? existing.pollIntervalMinutes
        : input.pollIntervalMinutes;
    const metadataJson = serializeJson(
      input.metadata === undefined ? existing.metadata : input.metadata,
    );
    const timestamp = this.now();
    const row = this.database
      .query<
        SubscriptionRow,
        [string | null, number, string, number, number, number, number, string]
      >(
        `UPDATE subscriptions
         SET title = ?, enabled = ?, metadata_json = ?, poll_interval_minutes = ?,
             next_poll_at = CASE WHEN ? = 1 AND enabled = 0 THEN ? ELSE next_poll_at END,
             updated_at = ?
         WHERE id = ? AND deleted_at IS NULL RETURNING *`,
      )
      .get(
        input.title === undefined ? existing.title : input.title,
        enabled ? 1 : 0,
        metadataJson,
        intervalMinutes,
        enabled ? 1 : 0,
        timestamp,
        timestamp,
        id,
      );
    return row ? mapSubscription(row) : null;
  }

  setEnabled(id: string, enabled: boolean): Subscription | null {
    const timestamp = this.now();
    const row = this.database
      .query<SubscriptionRow, [number, number, number, number, string]>(
        `UPDATE subscriptions
         SET enabled = ?, next_poll_at = CASE WHEN ? = 1 THEN ? ELSE next_poll_at END,
             updated_at = ?
         WHERE id = ? AND deleted_at IS NULL RETURNING *`,
      )
      .get(enabled ? 1 : 0, enabled ? 1 : 0, timestamp, timestamp, id);
    return row ? mapSubscription(row) : null;
  }

  recordFailure(
    id: string,
    errorMessage: string,
    failedAt: number,
    retryAt?: number,
  ): Subscription | null {
    const storedError = sanitizeErrorMessage(errorMessage);
    const persist = this.database.transaction(() => {
      const row = this.database
        .query<SubscriptionRow, [string, number, number | null, number, number, string]>(
          `UPDATE subscriptions
           SET consecutive_failures = consecutive_failures + 1,
               last_error = ?, last_failed_at = ?,
               next_poll_at = COALESCE(?, ? + CASE consecutive_failures
                 WHEN 0 THEN 300000
                 WHEN 1 THEN 900000
                 WHEN 2 THEN 3600000
                 ELSE 21600000
               END),
               updated_at = ?
           WHERE id = ? AND enabled = 1 AND deleted_at IS NULL
           RETURNING *`,
        )
        .get(storedError, failedAt, retryAt ?? null, failedAt, failedAt, id);
      if (!row) return null;

      const failureEventId = Bun.randomUUIDv7();
      this.database
        .query<never, [string, string, number, string, number, number]>(
          `INSERT INTO poll_failure_events (
             id, subscription_id, attempt, error, failed_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(failureEventId, id, row.consecutive_failures, storedError, failedAt, failedAt);
      this.database
        .query<never, [string, string, number, number, string]>(
          `INSERT INTO deliveries (
             id, destination_id, failure_event_id, created_at, updated_at
           )
           SELECT ? || ':' || destinations.id, destinations.id, ?, ?, ?
           FROM routes
           JOIN destinations ON destinations.id = routes.destination_id
           WHERE routes.subscription_id = ?
             AND routes.enabled = 1 AND destinations.enabled = 1
           ON CONFLICT (destination_id, failure_event_id) DO NOTHING`,
        )
        .run(failureEventId, failureEventId, failedAt, failedAt, id);
      return mapSubscription(row);
    });
    return persist();
  }

  listFailureEvents(limit = 100): PollFailureEvent[] {
    return this.database
      .query<PollFailureEventRow, [number]>(
        `SELECT * FROM poll_failure_events ORDER BY failed_at, id LIMIT ?`,
      )
      .all(limit)
      .map(mapFailureEvent);
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

  listTimelinePage(
    limit = 100,
    subscriptionId?: string,
    cursor?: PageCursor,
  ): RepositoryPage<Item> {
    const boundedLimit = requireLimit(limit);
    const rows = subscriptionId
      ? cursor
        ? this.database
            .query<ItemRow, [string, number, number, string, number]>(
              `SELECT * FROM items
               WHERE subscription_id = ?
                 AND (
                   COALESCE(published_at, discovered_at) < ?
                   OR (
                     COALESCE(published_at, discovered_at) = ?
                     AND id < ?
                   )
                 )
               ORDER BY COALESCE(published_at, discovered_at) DESC, id DESC
               LIMIT ?`,
            )
            .all(subscriptionId, cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)
        : this.database
            .query<ItemRow, [string, number]>(
              `SELECT * FROM items
               WHERE subscription_id = ?
               ORDER BY COALESCE(published_at, discovered_at) DESC, id DESC
               LIMIT ?`,
            )
            .all(subscriptionId, boundedLimit + 1)
      : cursor
        ? this.database
            .query<ItemRow, [number, number, string, number]>(
              `SELECT * FROM items
               WHERE (
                 COALESCE(published_at, discovered_at) < ?
                 OR (
                   COALESCE(published_at, discovered_at) = ?
                   AND id < ?
                 )
               )
               ORDER BY COALESCE(published_at, discovered_at) DESC, id DESC
               LIMIT ?`,
            )
            .all(cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)
        : this.database
            .query<ItemRow, [number]>(
              `SELECT * FROM items
               ORDER BY COALESCE(published_at, discovered_at) DESC, id DESC
               LIMIT ?`,
            )
            .all(boundedLimit + 1);
    return { items: rows.slice(0, boundedLimit).map(mapItem), hasMore: rows.length > boundedLimit };
  }

  recordEvent(write: EventWrite): EventWriteResult {
    const item = this.prepareItem(write.item);
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

      const existing = this.database
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM items WHERE subscription_id = ? AND external_id = ?",
        )
        .get(write.subscriptionId, item.externalId);

      if (existing) {
        const update = this.database
          .query<
            never,
            [
              string | null,
              string | null,
              string | null,
              string | null,
              string | null,
              string | null,
              number | null,
              number | null,
              number,
              string,
              string,
            ]
          >(
            `UPDATE items
             SET url = ?, title = ?, summary = ?, content_text = ?, content_html = ?,
                 author = ?, published_at = ?, source_updated_at = ?, updated_at = ?,
                 metadata_json = ?
             WHERE id = ?`,
          )
          .run(
            item.url,
            item.title,
            item.summary,
            item.contentText,
            item.contentHtml,
            item.author,
            item.publishedAt,
            item.sourceUpdatedAt,
            write.eventAt,
            item.metadataJson,
            existing.id,
          );
        if (update.changes !== 1) throw new Error("Failed to update item");
        this.updateEventSubscription(
          write.subscriptionId,
          cursorJson,
          write.eventAt,
          write.nextPollAt,
        );
        return { insertedItems: 0, updatedItems: 1 };
      }

      const itemId = this.generateId();
      this.database
        .query<
          never,
          [
            string,
            string,
            string,
            string | null,
            string | null,
            string | null,
            string | null,
            string | null,
            string | null,
            number | null,
            number | null,
            number,
            number,
            number,
            string,
          ]
        >(
          `INSERT INTO items (
             id, subscription_id, external_id, url, title, summary, content_text, content_html,
             author, published_at, source_updated_at, discovered_at, created_at, updated_at,
             metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          itemId,
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
          write.eventAt,
          write.eventAt,
          write.eventAt,
          item.metadataJson,
        );

      if (write.notifyOnInsert !== false) {
        this.database
          .query<never, [string, string, number, number, string]>(
            `INSERT INTO deliveries (
               id, destination_id, item_id, created_at, updated_at
             )
             SELECT ? || ':' || destinations.id, destinations.id, ?, ?, ?
             FROM routes
             JOIN destinations ON destinations.id = routes.destination_id
             WHERE routes.subscription_id = ?
               AND routes.enabled = 1 AND destinations.enabled = 1
             ON CONFLICT (destination_id, item_id) DO NOTHING`,
          )
          .run(itemId, itemId, write.eventAt, write.eventAt, write.subscriptionId);
      }

      this.updateEventSubscription(
        write.subscriptionId,
        cursorJson,
        write.eventAt,
        write.nextPollAt,
      );
      return { insertedItems: 1, updatedItems: 0 };
    });
    return persist();
  }

  private updateEventSubscription(
    subscriptionId: string,
    cursorJson: string,
    eventAt: number,
    nextPollAt: number | null | undefined,
  ): void {
    const update = this.database
      .query<never, [string, number, number, number | null, number, string]>(
        `UPDATE subscriptions
         SET cursor_json = ?, last_polled_at = ?, last_success_at = ?, next_poll_at = ?,
             consecutive_failures = 0, last_error = NULL, last_failed_at = NULL, updated_at = ?
         WHERE id = ? AND enabled = 1 AND deleted_at IS NULL`,
      )
      .run(cursorJson, eventAt, eventAt, nextPollAt ?? null, eventAt, subscriptionId);
    if (update.changes !== 1) throw new Error("Failed to update Telegram subscription");
  }

  recordPoll(write: PollWrite): PollWriteResult {
    const preparedItems = write.items.map((item) => this.prepareItem(item));
    const cursorJson = serializeJson(write.cursor);
    const deliveryExternalIds =
      write.deliveryExternalIds === undefined ? null : new Set(write.deliveryExternalIds);
    if (
      deliveryExternalIds &&
      [...deliveryExternalIds].some(
        (externalId) => !preparedItems.some((item) => item.externalId === externalId),
      )
    ) {
      throw new Error("deliveryExternalIds must reference items in the same poll write");
    }

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
        const itemId = this.generateId();
        const result = insert.run(
          itemId,
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
        if (
          result.changes === 1 &&
          (deliveryExternalIds === null || deliveryExternalIds.has(item.externalId))
        ) {
          this.database
            .query<never, [string, string, number, number, string]>(
              `INSERT INTO deliveries (id, destination_id, item_id, created_at, updated_at)
               SELECT ? || ':' || destinations.id, destinations.id, ?, ?, ?
               FROM routes
               JOIN destinations ON destinations.id = routes.destination_id
               WHERE routes.subscription_id = ?
                 AND routes.enabled = 1 AND destinations.enabled = 1
               ON CONFLICT (destination_id, item_id) DO NOTHING`,
            )
            .run(itemId, itemId, write.polledAt, write.polledAt, write.subscriptionId);
        }
      }

      const nextPollAt =
        write.nextPollAt === undefined ? subscription.next_poll_at : write.nextPollAt;
      const update = this.database
        .query<never, [string, number, number, number | null, number, string]>(
          `UPDATE subscriptions
           SET cursor_json = ?, last_polled_at = ?, last_success_at = ?, next_poll_at = ?,
               consecutive_failures = 0, last_error = NULL, last_failed_at = NULL,
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

export {
  DestinationRepository,
  DuplicateDestinationError,
  DuplicateRouteError,
  RouteRepository,
} from "./routing-repositories.ts";
