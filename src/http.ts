import { AGENT_MANIFEST } from "./agent/manifest.ts";
import { AppError, statusForAppError, toAppError } from "./app/errors.ts";
import { decodeCursor } from "./app/pagination.ts";
import type { ApplicationServices } from "./app/types.ts";
import type { TelegramWebhookHandler } from "./bot/webhook.ts";
import { DELIVERY_STATUSES } from "./delivery/types.ts";
import type {
  DeliveryStatus,
  DestinationUpdate,
  JsonValue,
  NewDestination,
  NewRoute,
  SubscriptionUpdate,
} from "./domain/types.ts";
import type { SubscriptionCandidate } from "./probe/types.ts";
import { redactSensitiveUrls, sanitizeErrorMessage } from "./security/redaction.ts";
import { isValidUiPath, type UiHandler } from "./ui/handler.ts";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const DEFAULT_API_LIMIT = 50;
const MAXIMUM_API_LIMIT = 100;

export interface RequestLogEvent {
  level: "info" | "error";
  message: "http_request_completed";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  errorCode?: string;
}

export type HttpAuthGuard = (request: Request) => void | Promise<void>;

export interface HttpDependencies {
  services?: ApplicationServices;
  telegramWebhook?: TelegramWebhookHandler;
  ui?: UiHandler;
  authGuard?: HttpAuthGuard;
  startedAt?: number;
  now?: () => number;
  createRequestId?: () => string;
  log?: (event: RequestLogEvent) => void;
}

export type HttpHandler = (request: Request) => Response | Promise<Response>;

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

type JsonObject = Record<string, unknown>;

function defaultRequestId(): string {
  return crypto.randomUUID();
}

function requestIdFrom(request: Request, createRequestId: () => string): string {
  const supplied = request.headers.get("x-request-id");
  return supplied && /^[A-Za-z0-9._-]{1,128}$/.test(supplied) ? supplied : createRequestId();
}

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function sanitizeDetails(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveUrls(value);
  if (Array.isArray(value)) return value.map(sanitizeDetails);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        sanitizeDetails(nested),
      ]),
    );
  }
  return value;
}

function errorResponse(error: unknown): { response: Response; errorCode: string } {
  const appError = toAppError(error);
  const body: ErrorBody = {
    error: {
      code: appError.code,
      message:
        appError.kind === "unexpected"
          ? "Internal server error"
          : sanitizeErrorMessage(appError.message),
    },
  };
  if (appError.kind !== "unexpected" && appError.details !== undefined) {
    body.error.details = sanitizeDetails(appError.details);
  }
  return {
    response: Response.json(body, { status: statusForAppError(appError) }),
    errorCode: appError.code,
  };
}

export function successResponse<T>(data: T, status = 200): Response {
  return Response.json({ data }, { status });
}

function routeRequest(request: Request, startedAt: number, now: () => number): Response {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({
      status: "ok",
      service: "curio",
      uptimeSeconds: Math.floor((now() - startedAt) / 1_000),
    });
  }
  throw new AppError("not_found", "not_found", "Route not found");
}

function asObject(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("validation", "invalid_body", `${field} must be a JSON object`);
  }
  return value as JsonObject;
}

function rejectUnknownFields(body: JsonObject, allowed: readonly string[]): void {
  const unknown = Object.keys(body).find((field) => !allowed.includes(field));
  if (unknown) {
    throw new AppError("validation", "unknown_field", `Unknown request field: ${unknown}`, {
      field: unknown,
    });
  }
}

function requiredString(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("validation", "invalid_field", `${field} must be a non-empty string`, {
      field,
    });
  }
  return value.trim();
}

function optionalString(body: JsonObject, field: string): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new AppError("validation", "invalid_field", `${field} must be a string or null`, {
      field,
    });
  }
  return value.trim();
}

function optionalBoolean(body: JsonObject, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new AppError("validation", "invalid_field", `${field} must be a boolean`, { field });
  }
  return value;
}

function optionalInteger(body: JsonObject, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AppError("validation", "invalid_field", `${field} must be an integer`, { field });
  }
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    return Object.values(value as JsonObject).every(isJsonValue);
  }
  return false;
}

function optionalJsonValue(body: JsonObject, field: string): JsonValue | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!isJsonValue(value)) {
    throw new AppError("validation", "invalid_field", `${field} must contain valid JSON`, {
      field,
    });
  }
  return value;
}

function requiredJsonObject(body: JsonObject, field: string): JsonValue {
  const value = optionalJsonValue(body, field);
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("validation", "invalid_field", `${field} must be a JSON object`, { field });
  }
  return value;
}

function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return DEFAULT_API_LIMIT;
  if (!/^\d+$/u.test(raw)) {
    throw new AppError("validation", "invalid_limit", "limit must be an integer");
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_API_LIMIT) {
    throw new AppError(
      "validation",
      "invalid_limit",
      `limit must be an integer between 1 and ${MAXIMUM_API_LIMIT}`,
    );
  }
  return limit;
}

function parseCursor(url: URL) {
  return decodeCursor(url.searchParams.get("cursor") ?? null);
}

function decodeSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) throw new Error("empty path segment");
    return decoded;
  } catch {
    throw new AppError("validation", "invalid_path", "Path parameter is invalid");
  }
}

async function readJsonBody(request: Request): Promise<JsonObject> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AppError(
      "validation",
      "invalid_content_type",
      "Request Content-Type must be application/json",
    );
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      throw new AppError("validation", "invalid_content_length", "Content-Length is invalid");
    }
    if (Number(contentLength) > MAX_JSON_BODY_BYTES) {
      throw new AppError("validation", "body_too_large", "Request body is too large");
    }
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value) continue;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new AppError("validation", "body_too_large", "Request body is too large");
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AppError("validation", "malformed_json", "Request body is not valid JSON");
  }
  return asObject(parsed, "body");
}

function parseCandidate(value: unknown): SubscriptionCandidate {
  const body = asObject(value, "candidate");
  rejectUnknownFields(body, [
    "adapter",
    "format",
    "sourceUrl",
    "sourceKey",
    "title",
    "discoveredVia",
  ]);
  const adapter = requiredString(body, "adapter");
  const format = requiredString(body, "format");
  const discoveredVia = requiredString(body, "discoveredVia");
  if (
    adapter !== "rss" &&
    adapter !== "x" &&
    adapter !== "html" &&
    adapter !== "youtube" &&
    adapter !== "telegram" &&
    adapter !== "telegram_html"
  ) {
    throw new AppError("validation", "invalid_enum", "adapter is not supported");
  }
  if (
    !(["rss", "atom", "rdf", "x", "html", "youtube", "telegram"] as const).includes(
      format as "rss" | "atom" | "rdf" | "x" | "html" | "youtube" | "telegram",
    )
  ) {
    throw new AppError("validation", "invalid_enum", "format is not supported");
  }
  if (discoveredVia !== "direct" && discoveredVia !== "html-link") {
    throw new AppError("validation", "invalid_enum", "discoveredVia is not supported");
  }
  return {
    adapter,
    format: format as SubscriptionCandidate["format"],
    sourceUrl: requiredString(body, "sourceUrl"),
    sourceKey: requiredString(body, "sourceKey"),
    title: optionalString(body, "title") ?? null,
    discoveredVia,
  };
}

function parseDeliveryStatus(url: URL): DeliveryStatus | undefined {
  const raw = url.searchParams.get("status");
  if (raw === null) return undefined;
  if (!DELIVERY_STATUSES.includes(raw as DeliveryStatus)) {
    throw new AppError("validation", "invalid_enum", "status is not supported");
  }
  return raw as DeliveryStatus;
}

function methodNotAllowed(): never {
  throw new AppError("validation", "method_not_allowed", "HTTP method is not supported");
}

async function handleApiRequest(
  request: Request,
  services: ApplicationServices,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments[1] !== "v1") {
    throw new AppError("not_found", "not_found", "Route not found");
  }
  const resource = segments[2];
  const id = segments[3] === undefined ? undefined : decodeSegment(segments[3]);
  const action = segments[4];

  if (resource === "agent" && segments.length === 4 && segments[3] === "manifest") {
    if (request.method !== "GET") methodNotAllowed();
    return successResponse(AGENT_MANIFEST);
  }

  if (resource === "probes" && segments.length === 3) {
    if (request.method !== "POST") methodNotAllowed();
    const body = await readJsonBody(request);
    rejectUnknownFields(body, ["url"]);
    return successResponse(await services.probe.probe(requiredString(body, "url")));
  }

  if (resource === "subscriptions") {
    if (id === undefined && segments.length === 3) {
      if (request.method === "GET") {
        return successResponse(services.subscriptions.listPage(parseLimit(url), parseCursor(url)));
      }
      if (request.method !== "POST") methodNotAllowed();
      const body = await readJsonBody(request);
      rejectUnknownFields(body, [
        "candidate",
        "pollIntervalMinutes",
        "intervalMinutes",
        "metadata",
      ]);
      const pollIntervalMinutes =
        optionalInteger(body, "pollIntervalMinutes") ??
        optionalInteger(body, "intervalMinutes") ??
        60;
      if (
        body.pollIntervalMinutes !== undefined &&
        body.intervalMinutes !== undefined &&
        body.pollIntervalMinutes !== body.intervalMinutes
      ) {
        throw new AppError("validation", "conflicting_fields", "Poll interval fields must match");
      }
      const candidate = parseCandidate(body.candidate);
      const metadata = optionalJsonValue(body, "metadata");
      const result = await services.subscriptions.followVerified({
        candidate,
        intervalMinutes: pollIntervalMinutes,
        metadata,
      });
      return successResponse(result, result.disposition === "created" ? 201 : 200);
    }
    if (id === undefined) throw new AppError("not_found", "not_found", "Route not found");
    if (action === undefined && segments.length === 4) {
      if (request.method === "GET") return successResponse(services.subscriptions.get(id));
      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        rejectUnknownFields(body, ["title", "enabled", "pollIntervalMinutes", "metadata"]);
        const update: SubscriptionUpdate = {
          title: optionalString(body, "title"),
          enabled: optionalBoolean(body, "enabled"),
          pollIntervalMinutes: optionalInteger(body, "pollIntervalMinutes"),
          metadata: optionalJsonValue(body, "metadata"),
        };
        return successResponse(services.subscriptions.update(id, update));
      }
      if (request.method === "DELETE") return successResponse(services.subscriptions.remove(id));
      methodNotAllowed();
    }
    if (action === "poll" && segments.length === 5) {
      if (request.method !== "POST") methodNotAllowed();
      return successResponse(await services.subscriptions.poll(id));
    }
    if (action === "items" && segments.length === 5) {
      if (request.method !== "GET") methodNotAllowed();
      return successResponse(
        services.subscriptions.listItemsPage(parseLimit(url), id, parseCursor(url)),
      );
    }
    throw new AppError("not_found", "not_found", "Route not found");
  }

  if (resource === "destinations") {
    if (id === undefined && segments.length === 3) {
      if (request.method === "GET") {
        return successResponse(services.destinations.listPage(parseLimit(url), parseCursor(url)));
      }
      if (request.method !== "POST") methodNotAllowed();
      const body = await readJsonBody(request);
      rejectUnknownFields(body, ["destinationKey", "kind", "config", "enabled"]);
      const kind = requiredString(body, "kind");
      if (kind !== "telegram")
        throw new AppError("validation", "invalid_enum", "kind is not supported");
      const input: NewDestination = {
        destinationKey: requiredString(body, "destinationKey"),
        kind,
        config: requiredJsonObject(body, "config"),
        enabled: optionalBoolean(body, "enabled"),
      };
      return successResponse(services.destinations.create(input), 201);
    }
    if (id === undefined) throw new AppError("not_found", "not_found", "Route not found");
    if (action === "verify" && segments.length === 5) {
      if (request.method !== "POST") methodNotAllowed();
      return successResponse(await services.destinations.verify(id));
    }
    if (segments.length === 4) {
      if (request.method !== "PATCH") methodNotAllowed();
      const body = await readJsonBody(request);
      rejectUnknownFields(body, ["config", "enabled"]);
      const update: DestinationUpdate = {
        config: optionalJsonValue(body, "config"),
        enabled: optionalBoolean(body, "enabled"),
      };
      return successResponse(services.destinations.update(id, update));
    }
    throw new AppError("not_found", "not_found", "Route not found");
  }

  if (resource === "routes") {
    if (id === undefined && segments.length === 3) {
      if (request.method === "GET") {
        return successResponse(
          services.routes.listPage(
            parseLimit(url),
            url.searchParams.get("subscriptionId") ?? undefined,
            parseCursor(url),
          ),
        );
      }
      if (request.method !== "POST") methodNotAllowed();
      const body = await readJsonBody(request);
      rejectUnknownFields(body, ["subscriptionId", "destinationId", "enabled", "config"]);
      const input: NewRoute = {
        subscriptionId: requiredString(body, "subscriptionId"),
        destinationId: requiredString(body, "destinationId"),
        enabled: optionalBoolean(body, "enabled"),
        config: optionalJsonValue(body, "config"),
      };
      return successResponse(services.routes.create(input), 201);
    }
    if (id === undefined || segments.length !== 4) {
      throw new AppError("not_found", "not_found", "Route not found");
    }
    if (request.method === "PATCH") {
      const body = await readJsonBody(request);
      rejectUnknownFields(body, ["enabled", "config"]);
      return successResponse(
        services.routes.update(id, {
          enabled: optionalBoolean(body, "enabled"),
          config: optionalJsonValue(body, "config"),
        }),
      );
    }
    if (request.method === "DELETE") return successResponse(services.routes.remove(id));
    if (request.method === "GET") return successResponse(services.routes.get(id));
    methodNotAllowed();
  }

  if (resource === "items" && id === undefined && segments.length === 3) {
    if (request.method !== "GET") methodNotAllowed();
    return successResponse(
      services.subscriptions.listItemsPage(
        parseLimit(url),
        url.searchParams.get("subscriptionId") ?? undefined,
        parseCursor(url),
      ),
    );
  }

  if (resource === "deliveries") {
    if (id === undefined && segments.length === 3) {
      if (request.method !== "GET") methodNotAllowed();
      return successResponse(
        services.deliveries.listPage(parseDeliveryStatus(url), parseLimit(url), parseCursor(url)),
      );
    }
    if (id !== undefined && action === "retry" && segments.length === 5) {
      if (request.method !== "POST") methodNotAllowed();
      return successResponse(services.deliveries.retry(id));
    }
    throw new AppError("not_found", "not_found", "Route not found");
  }

  throw new AppError("not_found", "not_found", "Route not found");
}

async function dispatchWithServices(
  request: Request,
  services: ApplicationServices | undefined,
  telegramWebhook: TelegramWebhookHandler | undefined,
  ui: UiHandler | undefined,
  authGuard: HttpAuthGuard | undefined,
  startedAt: number,
  now: () => number,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/telegram/webhook" && telegramWebhook) return telegramWebhook(request);
  if (authGuard) await authGuard(request);
  const uiRequest =
    ui &&
    (isValidUiPath(pathname) ||
      (!pathname.startsWith("/api/") &&
        pathname !== "/health" &&
        pathname !== "/telegram/webhook"));
  if (uiRequest) return ui(request);
  if (pathname === "/health") return routeRequest(request, startedAt, now);
  if (!services) return routeRequest(request, startedAt, now);
  return handleApiRequest(request, services);
}

export function createHttpHandler(dependencies: HttpDependencies = {}): HttpHandler {
  const now = dependencies.now ?? Date.now;
  const startedAt = dependencies.startedAt ?? now();
  const createRequestId = dependencies.createRequestId ?? defaultRequestId;
  const log = dependencies.log ?? ((event) => console.log(JSON.stringify(event)));

  return (request) => {
    const requestId = requestIdFrom(request, createRequestId);
    const path = new URL(request.url).pathname;
    const requestStartedAt = now();
    let result: Response | Promise<Response>;
    let errorCode: string | undefined;

    try {
      result =
        dependencies.services ||
        dependencies.telegramWebhook ||
        dependencies.ui ||
        dependencies.authGuard
          ? dispatchWithServices(
              request,
              dependencies.services,
              dependencies.telegramWebhook,
              dependencies.ui,
              dependencies.authGuard,
              startedAt,
              now,
            )
          : routeRequest(request, startedAt, now);
    } catch (error) {
      const failure = errorResponse(error);
      result = failure.response;
      errorCode = failure.errorCode;
    }

    const finish = (response: Response): Response => {
      const responseWithId = withRequestId(response, requestId);
      log({
        level: responseWithId.status >= 500 ? "error" : "info",
        message: "http_request_completed",
        requestId,
        method: request.method,
        path,
        status: responseWithId.status,
        durationMs: Math.max(0, now() - requestStartedAt),
        ...(errorCode ? { errorCode } : {}),
      });
      return responseWithId;
    };

    if (result instanceof Promise) {
      return result.then(finish).catch((error) => {
        const failure = errorResponse(error);
        errorCode = failure.errorCode;
        return finish(failure.response);
      });
    }
    return finish(result);
  };
}

const defaultHandler = createHttpHandler({ log: () => undefined });

export function handleRequest(request: Request): Response {
  const response = defaultHandler(request);
  if (response instanceof Promise) throw new Error("Default HTTP handler must be synchronous");
  return response;
}
