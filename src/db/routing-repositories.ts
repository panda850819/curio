import type { Database } from "bun:sqlite";
import type {
  Destination,
  DestinationUpdate,
  JsonValue,
  NewDestination,
  NewRoute,
  PageCursor,
  RepositoryPage,
  Route,
} from "../domain/types.ts";

interface DestinationRow {
  id: string;
  destination_key: string;
  kind: "telegram";
  config_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface RouteRow {
  id: string;
  subscription_id: string;
  destination_id: string;
  enabled: number;
  config_json: string;
  created_at: number;
  updated_at: number;
}

export class DuplicateDestinationError extends Error {
  constructor(destinationKey: string) {
    super(`Destination already exists: ${destinationKey}`);
    this.name = "DuplicateDestinationError";
  }
}

export class DuplicateRouteError extends Error {
  constructor(subscriptionId: string, destinationId: string) {
    super(`Route already exists: ${subscriptionId}/${destinationId}`);
    this.name = "DuplicateRouteError";
  }
}

function requireText(value: string, field: string): string {
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

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeTelegramConfig(config: JsonValue): { chatId: string } {
  if (!isJsonObject(config)) throw new Error("Telegram destination config must be an object");
  const unknownKeys = Object.keys(config).filter((key) => key !== "chatId");
  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported Telegram destination config field: ${unknownKeys[0]}`);
  }
  if (typeof config.chatId !== "string" || !config.chatId.trim()) {
    throw new Error("Telegram destination config requires a chat ID");
  }
  return { chatId: config.chatId.trim() };
}

function mapDestination(row: DestinationRow): Destination {
  return {
    id: row.id,
    destinationKey: row.destination_key,
    kind: row.kind,
    config: parseJson(row.config_json),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoute(row: RouteRow): Route {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    destinationId: row.destination_id,
    enabled: row.enabled === 1,
    config: parseJson(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  return limit;
}

export class DestinationRepository {
  constructor(
    private readonly database: Database,
    private readonly generateId: () => string = () => Bun.randomUUIDv7(),
    private readonly now: () => number = Date.now,
  ) {}

  create(input: NewDestination): Destination {
    const destinationKey = requireText(input.destinationKey, "destinationKey");
    if (input.kind !== "telegram") throw new Error(`Unsupported destination kind: ${input.kind}`);
    const config = normalizeTelegramConfig(input.config);
    const existing = this.findByKey(destinationKey);
    if (existing) throw new DuplicateDestinationError(destinationKey);
    const timestamp = this.now();
    const row = this.database
      .query<DestinationRow, [string, string, string, string, number, number, number]>(
        `INSERT INTO destinations (
           id, destination_key, kind, config_json, enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        this.generateId(),
        destinationKey,
        input.kind,
        serializeJson(config),
        input.enabled === false ? 0 : 1,
        timestamp,
        timestamp,
      );
    if (!row) throw new Error("Failed to create destination");
    return mapDestination(row);
  }

  list(limit = 100): Destination[] {
    return this.database
      .query<DestinationRow, [number]>("SELECT * FROM destinations ORDER BY created_at, id LIMIT ?")
      .all(requireLimit(limit))
      .map(mapDestination);
  }

  listPage(limit = 100, cursor?: PageCursor): RepositoryPage<Destination> {
    const boundedLimit = requireLimit(limit);
    const rows = cursor
      ? this.database
          .query<DestinationRow, [number, number, string, number]>(
            `SELECT * FROM destinations
             WHERE created_at > ? OR (created_at = ? AND id > ?)
             ORDER BY created_at, id LIMIT ?`,
          )
          .all(cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)
      : this.database
          .query<DestinationRow, [number]>(
            "SELECT * FROM destinations ORDER BY created_at, id LIMIT ?",
          )
          .all(boundedLimit + 1);
    return {
      items: rows.slice(0, boundedLimit).map(mapDestination),
      hasMore: rows.length > boundedLimit,
    };
  }

  findById(id: string): Destination | null {
    const row = this.database
      .query<DestinationRow, [string]>("SELECT * FROM destinations WHERE id = ?")
      .get(id);
    return row ? mapDestination(row) : null;
  }

  get(id: string): Destination | null {
    return this.findById(id);
  }

  findByKey(destinationKey: string): Destination | null {
    const row = this.database
      .query<DestinationRow, [string]>("SELECT * FROM destinations WHERE destination_key = ?")
      .get(destinationKey);
    return row ? mapDestination(row) : null;
  }

  update(id: string, input: DestinationUpdate): Destination | null {
    const existing = this.findById(id);
    if (!existing) return null;
    const config =
      input.config === undefined ? existing.config : normalizeTelegramConfig(input.config);
    const timestamp = this.now();
    const row = this.database
      .query<DestinationRow, [string, number, number, string]>(
        `UPDATE destinations
         SET config_json = ?, enabled = ?, updated_at = ?
         WHERE id = ? RETURNING *`,
      )
      .get(
        serializeJson(config),
        input.enabled === undefined ? (existing.enabled ? 1 : 0) : input.enabled ? 1 : 0,
        timestamp,
        id,
      );
    return row ? mapDestination(row) : null;
  }

  setEnabled(id: string, enabled: boolean): Destination | null {
    return this.update(id, { enabled });
  }

  enable(id: string): Destination | null {
    return this.setEnabled(id, true);
  }

  disable(id: string): Destination | null {
    return this.setEnabled(id, false);
  }

  syncTelegramDestination(chatId: string, destinationKey = "telegram-primary"): Destination {
    const config = normalizeTelegramConfig({ chatId });
    const existing = this.findByKey(destinationKey);
    if (existing) {
      const updated = this.update(existing.id, { config, enabled: true });
      if (!updated) throw new Error("Failed to update Telegram destination");
      return updated;
    }
    return this.create({
      destinationKey,
      kind: "telegram",
      config,
      enabled: true,
    });
  }
}

export class RouteRepository {
  constructor(
    private readonly database: Database,
    private readonly generateId: () => string = () => Bun.randomUUIDv7(),
    private readonly now: () => number = Date.now,
  ) {}

  create(input: NewRoute): Route {
    const subscriptionId = requireText(input.subscriptionId, "subscriptionId");
    const destinationId = requireText(input.destinationId, "destinationId");
    const existing = this.findBySubscriptionAndDestination(subscriptionId, destinationId);
    if (existing) throw new DuplicateRouteError(subscriptionId, destinationId);
    const timestamp = this.now();
    const row = this.database
      .query<RouteRow, [string, string, string, number, string, number, number]>(
        `INSERT INTO routes (
           id, subscription_id, destination_id, enabled, config_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        this.generateId(),
        subscriptionId,
        destinationId,
        input.enabled === false ? 0 : 1,
        serializeJson(input.config ?? {}),
        timestamp,
        timestamp,
      );
    if (!row) throw new Error("Failed to create route");
    return mapRoute(row);
  }

  list(limit = 100): Route[] {
    return this.database
      .query<RouteRow, [number]>("SELECT * FROM routes ORDER BY created_at, id LIMIT ?")
      .all(requireLimit(limit))
      .map(mapRoute);
  }

  listPage(limit = 100, cursor?: PageCursor): RepositoryPage<Route> {
    const boundedLimit = requireLimit(limit);
    const rows = cursor
      ? this.database
          .query<RouteRow, [number, number, string, number]>(
            `SELECT * FROM routes
             WHERE created_at > ? OR (created_at = ? AND id > ?)
             ORDER BY created_at, id LIMIT ?`,
          )
          .all(cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)
      : this.database
          .query<RouteRow, [number]>("SELECT * FROM routes ORDER BY created_at, id LIMIT ?")
          .all(boundedLimit + 1);
    return {
      items: rows.slice(0, boundedLimit).map(mapRoute),
      hasMore: rows.length > boundedLimit,
    };
  }

  listBySubscription(subscriptionId: string, limit = 100, enabledOnly = false): Route[] {
    const query = enabledOnly
      ? `SELECT * FROM routes
         WHERE subscription_id = ? AND enabled = 1
         ORDER BY created_at, id LIMIT ?`
      : `SELECT * FROM routes
         WHERE subscription_id = ?
         ORDER BY created_at, id LIMIT ?`;
    return this.database
      .query<RouteRow, [string, number]>(query)
      .all(requireText(subscriptionId, "subscriptionId"), requireLimit(limit))
      .map(mapRoute);
  }

  listPageBySubscription(
    subscriptionId: string,
    limit = 100,
    cursor?: PageCursor,
  ): RepositoryPage<Route> {
    const boundedLimit = requireLimit(limit);
    const value = requireText(subscriptionId, "subscriptionId");
    const rows = cursor
      ? this.database
          .query<RouteRow, [string, number, number, string, number]>(
            `SELECT * FROM routes
             WHERE subscription_id = ?
               AND (created_at > ? OR (created_at = ? AND id > ?))
             ORDER BY created_at, id LIMIT ?`,
          )
          .all(value, cursor.timestamp, cursor.timestamp, cursor.id, boundedLimit + 1)
      : this.database
          .query<RouteRow, [string, number]>(
            `SELECT * FROM routes
             WHERE subscription_id = ?
             ORDER BY created_at, id LIMIT ?`,
          )
          .all(value, boundedLimit + 1);
    return {
      items: rows.slice(0, boundedLimit).map(mapRoute),
      hasMore: rows.length > boundedLimit,
    };
  }

  listForSubscription(subscriptionId: string, limit = 100): Route[] {
    return this.listBySubscription(subscriptionId, limit);
  }

  listEnabledForSubscription(subscriptionId: string, limit = 100): Route[] {
    return this.listBySubscription(subscriptionId, limit, true);
  }

  findById(id: string): Route | null {
    const row = this.database
      .query<RouteRow, [string]>("SELECT * FROM routes WHERE id = ?")
      .get(id);
    return row ? mapRoute(row) : null;
  }

  get(id: string): Route | null {
    return this.findById(id);
  }

  findBySubscriptionAndDestination(subscriptionId: string, destinationId: string): Route | null {
    const row = this.database
      .query<RouteRow, [string, string]>(
        "SELECT * FROM routes WHERE subscription_id = ? AND destination_id = ?",
      )
      .get(subscriptionId, destinationId);
    return row ? mapRoute(row) : null;
  }

  update(id: string, input: { enabled?: boolean; config?: JsonValue }): Route | null {
    const existing = this.findById(id);
    if (!existing) return null;
    const timestamp = this.now();
    const row = this.database
      .query<RouteRow, [number, string, number, string]>(
        `UPDATE routes
         SET enabled = ?, config_json = ?, updated_at = ?
         WHERE id = ? RETURNING *`,
      )
      .get(
        input.enabled === undefined ? (existing.enabled ? 1 : 0) : input.enabled ? 1 : 0,
        serializeJson(input.config ?? existing.config),
        timestamp,
        id,
      );
    return row ? mapRoute(row) : null;
  }

  setEnabled(id: string, enabled: boolean): Route | null {
    return this.update(id, { enabled });
  }

  enable(id: string): Route | null {
    return this.setEnabled(id, true);
  }

  disable(id: string): Route | null {
    return this.setEnabled(id, false);
  }

  delete(id: string): boolean {
    const result = this.database.query<never, [string]>("DELETE FROM routes WHERE id = ?").run(id);
    return result.changes === 1;
  }

  remove(id: string): boolean {
    return this.delete(id);
  }

  ensureCompatibility(destinationId: string, timestamp = this.now()): number {
    const initialize = this.database.transaction(() => {
      const marker = this.database
        .query<{ destination_id: string }, [string]>(
          "SELECT destination_id FROM route_compatibility_runs WHERE destination_id = ?",
        )
        .get(destinationId);
      if (marker) return 0;

      const changes = this.database
        .query<never, [string, string, number, number]>(
          `INSERT INTO routes (
             id, subscription_id, destination_id, enabled, config_json, created_at, updated_at
           )
           SELECT 'compatibility:' || subscriptions.id || ':' || ?, subscriptions.id, ?, 1, '{}', ?, ?
           FROM subscriptions
           WHERE subscriptions.deleted_at IS NULL
           ON CONFLICT (subscription_id, destination_id) DO NOTHING`,
        )
        .run(destinationId, destinationId, timestamp, timestamp).changes;
      this.database
        .query<never, [string, number]>(
          `INSERT INTO route_compatibility_runs (destination_id, initialized_at)
           VALUES (?, ?)
           ON CONFLICT (destination_id) DO NOTHING`,
        )
        .run(destinationId, timestamp);
      return changes;
    });
    return initialize();
  }

  ensureCompatibilityForRestoredSubscription(
    subscriptionId: string,
    previouslyDeletedAt: number,
    timestamp = this.now(),
  ): number {
    return this.database
      .query<never, [number, number, string, number]>(
        `INSERT INTO routes (
           id, subscription_id, destination_id, enabled, config_json, created_at, updated_at
         )
         SELECT 'compatibility:' || subscriptions.id || ':' || destinations.id,
                subscriptions.id, destinations.id, 1, '{}', ?, ?
         FROM subscriptions
         JOIN destinations ON destinations.destination_key = 'telegram-primary'
         JOIN route_compatibility_runs
           ON route_compatibility_runs.destination_id = destinations.id
         WHERE subscriptions.id = ?
           AND ? <= route_compatibility_runs.initialized_at
         ON CONFLICT (subscription_id, destination_id) DO NOTHING`,
      )
      .run(timestamp, timestamp, subscriptionId, previouslyDeletedAt).changes;
  }
}
