import type { Database } from "bun:sqlite";
import { DestinationRepository, RouteRepository } from "../db/routing-repositories.ts";
import type {
  Delivery,
  DeliveryAttempt,
  DeliveryStatus,
  Destination,
  DestinationUpdate,
  Item,
  NewDestination,
  PageCursor,
  PollFailureEvent,
  RepositoryPage,
  Subscription,
} from "../domain/types.ts";
import { sanitizeErrorMessage } from "../security/redaction.ts";
import type { DeliveryCompletion, DeliveryPayload } from "./types.ts";

interface DestinationRow {
  id: string;
  destination_key: string;
  kind: "telegram";
  config_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}
interface DeliveryRow {
  id: string;
  destination_id: string;
  item_id: string | null;
  failure_event_id: string | null;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: number | null;
  telegram_message_id: number | null;
  last_error: string | null;
  claimed_at: number | null;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
}
interface AttemptRow {
  id: string;
  delivery_id: string;
  attempt: number;
  outcome: DeliveryAttempt["outcome"];
  http_status: number | null;
  error: string | null;
  started_at: number;
  finished_at: number;
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
interface FailureRow {
  id: string;
  subscription_id: string;
  attempt: number;
  error: string;
  failed_at: number;
  created_at: number;
  delivered_at: number | null;
}
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

function mapDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    destinationId: row.destination_id,
    itemId: row.item_id,
    failureEventId: row.failure_event_id,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    telegramMessageId: row.telegram_message_id,
    lastError: row.last_error,
    claimedAt: row.claimed_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapAttempt(row: AttemptRow): DeliveryAttempt {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    attempt: row.attempt,
    outcome: row.outcome,
    httpStatus: row.http_status,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class DeliveryRepository {
  private readonly destinations: DestinationRepository;
  private readonly routes: RouteRepository;

  constructor(
    private readonly database: Database,
    private readonly generateId: () => string = () => Bun.randomUUIDv7(),
    private readonly now: () => number = Date.now,
    destinations?: DestinationRepository,
    routes?: RouteRepository,
  ) {
    this.destinations = destinations ?? new DestinationRepository(database, generateId, now);
    this.routes = routes ?? new RouteRepository(database, generateId, now);
  }

  syncTelegramDestination(chatId: string): Destination {
    const timestamp = this.now();
    const sync = this.database.transaction(() => {
      const destination = this.destinations.syncTelegramDestination(chatId);
      this.routes.ensureCompatibility(destination.id, timestamp);
      this.database
        .query<never, [number, number, string]>(
          `INSERT INTO deliveries (id, destination_id, failure_event_id, created_at, updated_at)
           SELECT poll_failure_events.id || ':' || destinations.id, destinations.id,
                  poll_failure_events.id, ?, ?
           FROM poll_failure_events
           JOIN routes ON routes.subscription_id = poll_failure_events.subscription_id
           JOIN destinations ON destinations.id = routes.destination_id
           WHERE routes.destination_id = ?
             AND routes.enabled = 1 AND destinations.enabled = 1
             AND poll_failure_events.delivered_at IS NULL
           ON CONFLICT (destination_id, failure_event_id) DO NOTHING`,
        )
        .run(timestamp, timestamp, destination.id);
      return destination;
    });
    return sync();
  }

  disableTelegramDestination(): boolean {
    const destination = this.destinations.findByKey("telegram-primary");
    if (!destination?.enabled) return false;
    return this.destinations.setEnabled(destination.id, false) !== null;
  }

  createDestination(input: NewDestination): Destination {
    return this.destinations.create(input);
  }

  listDestinations(limit = 100): Destination[] {
    return this.destinations.list(limit);
  }

  findDestinationById(id: string): Destination | null {
    return this.destinations.findById(id);
  }

  getDestination(id: string): Destination | null {
    return this.findDestinationById(id);
  }

  updateDestination(id: string, input: DestinationUpdate): Destination | null {
    return this.destinations.update(id, input);
  }

  setDestinationEnabled(id: string, enabled: boolean): Destination | null {
    return this.destinations.setEnabled(id, enabled);
  }

  findById(id: string): Delivery | null {
    const row = this.database
      .query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE id = ?")
      .get(id);
    return row ? mapDelivery(row) : null;
  }

  list(status?: DeliveryStatus, limit = 100): Delivery[] {
    const rows = status
      ? this.database
          .query<DeliveryRow, [DeliveryStatus, number]>(
            "SELECT * FROM deliveries WHERE status = ? ORDER BY created_at, id LIMIT ?",
          )
          .all(status, limit)
      : this.database
          .query<DeliveryRow, [number]>("SELECT * FROM deliveries ORDER BY created_at, id LIMIT ?")
          .all(limit);
    return rows.map(mapDelivery);
  }

  listPage(
    status: DeliveryStatus | undefined,
    limit = 100,
    cursor?: PageCursor,
  ): RepositoryPage<Delivery> {
    const boundedLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 500 ? limit : null;
    if (boundedLimit === null) throw new Error("limit must be an integer between 1 and 500");
    const rows = status
      ? cursor
        ? this.database
            .query<DeliveryRow, [DeliveryStatus, number, number, string, number]>(
              `SELECT * FROM deliveries
               WHERE status = ?
                 AND (created_at > ? OR (created_at = ? AND id > ?))
               ORDER BY created_at, id LIMIT ?`,
            )
            .all(status, cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)
        : this.database
            .query<DeliveryRow, [DeliveryStatus, number]>(
              "SELECT * FROM deliveries WHERE status = ? ORDER BY created_at, id LIMIT ?",
            )
            .all(status, boundedLimit + 1)
      : cursor
        ? this.database
            .query<DeliveryRow, [number, number, string, number]>(
              `SELECT * FROM deliveries
               WHERE created_at > ? OR (created_at = ? AND id > ?)
               ORDER BY created_at, id LIMIT ?`,
            )
            .all(cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)
        : this.database
            .query<DeliveryRow, [number]>(
              "SELECT * FROM deliveries ORDER BY created_at, id LIMIT ?",
            )
            .all(boundedLimit + 1);
    return {
      items: rows.slice(0, boundedLimit).map(mapDelivery),
      hasMore: rows.length > boundedLimit,
    };
  }

  listAttempts(deliveryId: string): DeliveryAttempt[] {
    return this.database
      .query<AttemptRow, [string]>(
        "SELECT * FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt",
      )
      .all(deliveryId)
      .map(mapAttempt);
  }

  recoverProcessing(): number {
    const timestamp = this.now();
    const recover = this.database.transaction(() => {
      const processing = this.database
        .query<DeliveryRow, []>("SELECT * FROM deliveries WHERE status = 'processing'")
        .all();
      for (const delivery of processing) {
        this.database
          .query<never, [string, string, number, number, number]>(
            `INSERT INTO delivery_attempts (
               id, delivery_id, attempt, outcome, error, started_at, finished_at
             ) VALUES (?, ?, ?, 'uncertain', 'Process restarted during delivery', ?, ?)`,
          )
          .run(
            this.generateId(),
            delivery.id,
            delivery.attempt_count,
            delivery.claimed_at ?? delivery.updated_at,
            timestamp,
          );
        this.database
          .query<never, [string, number, string]>(
            `UPDATE deliveries SET status = 'uncertain', last_error = ?, claimed_at = NULL,
               updated_at = ? WHERE id = ?`,
          )
          .run("Process restarted during delivery", timestamp, delivery.id);
      }
      return processing.length;
    });
    return recover();
  }

  claimDue(limit = 4): Delivery[] {
    const timestamp = this.now();
    const claim = this.database.transaction(() => {
      const rows = this.database
        .query<DeliveryRow, [number, number]>(
          `SELECT d.*
           FROM deliveries AS d
           LEFT JOIN items AS delivery_item ON delivery_item.id = d.item_id
           WHERE (d.status = 'pending' OR (d.status = 'retry_scheduled' AND d.next_attempt_at <= ?))
             AND NOT EXISTS (
               SELECT 1
               FROM deliveries AS earlier
               LEFT JOIN items AS earlier_item ON earlier_item.id = earlier.item_id
               WHERE earlier.destination_id = d.destination_id
                 AND earlier.status IN ('pending', 'processing', 'retry_scheduled', 'uncertain')
                 AND (
                   COALESCE(earlier_item.published_at, earlier.created_at) <
                     COALESCE(delivery_item.published_at, d.created_at)
                   OR (
                     COALESCE(earlier_item.published_at, earlier.created_at) =
                       COALESCE(delivery_item.published_at, d.created_at)
                     AND (
                       earlier.created_at < d.created_at
                       OR (earlier.created_at = d.created_at AND earlier.id < d.id)
                     )
                 )
             )
           )
           ORDER BY COALESCE(delivery_item.published_at, d.created_at), d.created_at, d.id
           LIMIT ?`,
        )
        .all(timestamp, limit);
      const claimed: Delivery[] = [];
      for (const row of rows) {
        const updated = this.database
          .query<DeliveryRow, [number, number, string]>(
            `UPDATE deliveries SET status = 'processing', attempt_count = attempt_count + 1,
             claimed_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'retry_scheduled') RETURNING *`,
          )
          .get(timestamp, timestamp, row.id);
        if (updated) claimed.push(mapDelivery(updated));
      }
      return claimed;
    });
    return claim();
  }

  loadPayload(deliveryId: string): DeliveryPayload {
    const deliveryRow = this.database
      .query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE id = ?")
      .get(deliveryId);
    if (!deliveryRow) throw new Error(`Delivery not found: ${deliveryId}`);
    const destination = this.database
      .query<DestinationRow, [string]>("SELECT * FROM destinations WHERE id = ?")
      .get(deliveryRow.destination_id);
    if (!destination) throw new Error("Delivery destination not found");
    const config = JSON.parse(destination.config_json) as { chatId?: unknown };
    if (typeof config.chatId !== "string")
      throw new Error("Telegram destination chat ID is invalid");
    const item =
      deliveryRow.item_id === null
        ? null
        : this.database
            .query<ItemRow, [string]>("SELECT * FROM items WHERE id = ?")
            .get(deliveryRow.item_id);
    const event =
      deliveryRow.failure_event_id === null
        ? null
        : this.database
            .query<FailureRow, [string]>("SELECT * FROM poll_failure_events WHERE id = ?")
            .get(deliveryRow.failure_event_id);
    const subscriptionId = item?.subscription_id ?? event?.subscription_id;
    if (!subscriptionId) throw new Error("Delivery payload not found");
    const subscription = this.database
      .query<SubscriptionRow, [string]>("SELECT * FROM subscriptions WHERE id = ?")
      .get(subscriptionId);
    if (!subscription) throw new Error("Delivery subscription not found");
    return {
      delivery: mapDelivery(deliveryRow),
      chatId: config.chatId,
      item: item
        ? ({
            id: item.id,
            subscriptionId: item.subscription_id,
            externalId: item.external_id,
            url: item.url,
            title: item.title,
            summary: item.summary,
            contentText: item.content_text,
            contentHtml: item.content_html,
            author: item.author,
            publishedAt: item.published_at,
            sourceUpdatedAt: item.source_updated_at,
            discoveredAt: item.discovered_at,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
            metadata: JSON.parse(item.metadata_json),
          } satisfies Item)
        : null,
      failureEvent: event
        ? ({
            id: event.id,
            subscriptionId: event.subscription_id,
            attempt: event.attempt,
            error: event.error,
            failedAt: event.failed_at,
            createdAt: event.created_at,
            deliveredAt: event.delivered_at,
          } satisfies PollFailureEvent)
        : null,
      subscription: {
        id: subscription.id,
        adapter: subscription.adapter,
        sourceKey: subscription.source_key,
        sourceUrl: subscription.source_url,
        title: subscription.title,
        enabled: subscription.enabled === 1,
        cursor: subscription.cursor_json === null ? null : JSON.parse(subscription.cursor_json),
        metadata: JSON.parse(subscription.metadata_json),
        lastPolledAt: subscription.last_polled_at,
        lastSuccessAt: subscription.last_success_at,
        nextPollAt: subscription.next_poll_at,
        pollIntervalMinutes: subscription.poll_interval_minutes,
        consecutiveFailures: subscription.consecutive_failures,
        lastError: subscription.last_error,
        lastFailedAt: subscription.last_failed_at,
        createdAt: subscription.created_at,
        updatedAt: subscription.updated_at,
        deletedAt: subscription.deleted_at,
      } satisfies Subscription,
    };
  }

  complete(input: DeliveryCompletion): Delivery {
    const error = input.error == null ? null : sanitizeErrorMessage(input.error);
    const finish = this.database.transaction(() => {
      const current = this.database
        .query<DeliveryRow, [string]>(
          "SELECT * FROM deliveries WHERE id = ? AND status = 'processing'",
        )
        .get(input.deliveryId);
      if (!current) throw new Error("Delivery is not processing");
      this.database
        .query<
          never,
          [string, string, number, string, number | null, string | null, number, number]
        >(
          `INSERT INTO delivery_attempts (id, delivery_id, attempt, outcome, http_status, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.generateId(),
          current.id,
          current.attempt_count,
          input.outcome,
          input.httpStatus ?? null,
          error,
          input.startedAt,
          input.finishedAt,
        );
      const status: DeliveryStatus = input.outcome === "retry" ? "retry_scheduled" : input.outcome;
      const updated = this.database
        .query<
          DeliveryRow,
          [
            DeliveryStatus,
            number | null,
            number | null,
            string | null,
            number | null,
            number,
            string,
          ]
        >(
          `UPDATE deliveries SET status = ?, next_attempt_at = ?, telegram_message_id = ?, last_error = ?,
           claimed_at = NULL, delivered_at = ?, updated_at = ? WHERE id = ? RETURNING *`,
        )
        .get(
          status,
          input.nextAttemptAt ?? null,
          input.telegramMessageId ?? null,
          error,
          input.outcome === "delivered" ? input.finishedAt : null,
          input.finishedAt,
          current.id,
        );
      if (!updated) throw new Error("Failed to complete delivery");
      if (input.outcome === "delivered" && current.failure_event_id) {
        this.database
          .query("UPDATE poll_failure_events SET delivered_at = ? WHERE id = ?")
          .run(input.finishedAt, current.failure_event_id);
      }
      return mapDelivery(updated);
    });
    return finish();
  }

  retry(deliveryId: string): Delivery {
    const timestamp = this.now();
    const row = this.database
      .query<DeliveryRow, [number, string]>(
        `UPDATE deliveries SET status = 'pending', next_attempt_at = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('uncertain', 'permanent_failure') RETURNING *`,
      )
      .get(timestamp, deliveryId);
    if (!row) throw new Error("Delivery is not retryable");
    return mapDelivery(row);
  }
}
