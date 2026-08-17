import type { CurioAgentApiClient } from "./client.ts";

export interface CurioAgentTool {
  name: string;
  description: string;
  confirmation: "none" | "required";
  inputSchema: Record<string, unknown>;
  call(argumentsValue: unknown): Promise<unknown>;
}

export class CurioAgentToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CurioAgentToolError";
  }
}

const stringSchema = { type: "string", minLength: 1 };
const confirmationSchema = {
  type: "boolean",
  const: true,
  description: "Explicit user confirmation.",
};
const emptySchema = { type: "object", properties: {}, additionalProperties: false };

function objectArguments(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CurioAgentToolError("invalid_arguments", "Tool arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(argumentsValue: Record<string, unknown>, field: string): string {
  const value = argumentsValue[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new CurioAgentToolError("invalid_arguments", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  argumentsValue: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = argumentsValue[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new CurioAgentToolError("invalid_arguments", `${field} must be a string`);
  }
  return value.trim();
}

function optionalInteger(
  argumentsValue: Record<string, unknown>,
  field: string,
  minimum?: number,
  maximum?: number,
): number | undefined {
  const value = argumentsValue[field];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (minimum !== undefined && value < minimum) ||
    (maximum !== undefined && value > maximum)
  ) {
    const range =
      minimum !== undefined && maximum !== undefined ? ` between ${minimum} and ${maximum}` : "";
    throw new CurioAgentToolError("invalid_arguments", `${field} must be an integer${range}`);
  }
  return value;
}

function requiredObject(
  argumentsValue: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = argumentsValue[field];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CurioAgentToolError("invalid_arguments", `${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireConfirmation(argumentsValue: Record<string, unknown>, operation: string): void {
  if (argumentsValue.confirm !== true) {
    throw new CurioAgentToolError(
      "confirmation_required",
      `${operation} requires confirm=true after explicit user confirmation`,
    );
  }
}

function idPath(prefix: string, id: string): string {
  return `${prefix}/${encodeURIComponent(id)}`;
}

function listQuery(
  argumentsValue: Record<string, unknown>,
): Record<string, string | number | undefined> {
  return {
    limit: optionalInteger(argumentsValue, "limit", 1, 100),
    cursor: optionalString(argumentsValue, "cursor"),
  };
}

function tool(
  name: string,
  description: string,
  confirmation: CurioAgentTool["confirmation"],
  inputSchema: Record<string, unknown>,
  call: CurioAgentTool["call"],
): CurioAgentTool {
  return { name, description, confirmation, inputSchema, call };
}

export function createCurioAgentTools(client: CurioAgentApiClient): CurioAgentTool[] {
  return [
    tool(
      "curio_get_manifest",
      "Read the Curio agent capability manifest.",
      "none",
      emptySchema,
      () => client.get("/api/v1/agent/manifest"),
    ),
    tool("curio_get_health", "Read Curio service health and uptime.", "none", emptySchema, () =>
      client.get("/health"),
    ),
    tool(
      "curio_probe_source",
      "Probe a public URL and return validated subscription candidates.",
      "none",
      {
        type: "object",
        properties: { url: stringSchema },
        required: ["url"],
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        return client.post("/api/v1/probes", { url: requiredString(argumentsValue, "url") });
      },
    ),
    tool(
      "curio_list_sources",
      "List active Curio subscriptions.",
      "none",
      {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: stringSchema,
        },
        additionalProperties: false,
      },
      (value) => client.get("/api/v1/subscriptions", listQuery(objectArguments(value))),
    ),
    tool(
      "curio_get_source",
      "Read one subscription health record.",
      "none",
      {
        type: "object",
        properties: { id: stringSchema },
        required: ["id"],
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        return client.get(idPath("/api/v1/subscriptions", requiredString(argumentsValue, "id")));
      },
    ),
    tool(
      "curio_list_items",
      "Read the collected item timeline.",
      "none",
      {
        type: "object",
        properties: {
          subscriptionId: stringSchema,
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: stringSchema,
        },
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        return client.get("/api/v1/items", {
          ...listQuery(argumentsValue),
          subscriptionId: optionalString(argumentsValue, "subscriptionId"),
        });
      },
    ),
    tool(
      "curio_create_subscription",
      "Verify a candidate and create or resolve a subscription.",
      "required",
      {
        type: "object",
        properties: {
          candidate: { type: "object" },
          pollIntervalMinutes: { type: "integer", minimum: 5, maximum: 10080 },
          metadata: { type: "object" },
          confirm: confirmationSchema,
        },
        required: ["candidate", "confirm"],
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        requireConfirmation(argumentsValue, "curio_create_subscription");
        const body: Record<string, unknown> = {
          candidate: requiredObject(argumentsValue, "candidate"),
        };
        const interval = optionalInteger(argumentsValue, "pollIntervalMinutes", 5, 10_080);
        const metadata = argumentsValue.metadata;
        if (interval !== undefined) body.pollIntervalMinutes = interval;
        if (metadata !== undefined) body.metadata = requiredObject(argumentsValue, "metadata");
        return client.post("/api/v1/subscriptions", body);
      },
    ),
    tool(
      "curio_poll_source",
      "Run one normal poll for a subscription.",
      "none",
      {
        type: "object",
        properties: { id: stringSchema },
        required: ["id"],
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        return client.post(
          `${idPath("/api/v1/subscriptions", requiredString(argumentsValue, "id"))}/poll`,
        );
      },
    ),
    tool(
      "curio_pause_source",
      "Pause one subscription after explicit confirmation.",
      "required",
      {
        type: "object",
        properties: { id: stringSchema, confirm: confirmationSchema },
        required: ["id", "confirm"],
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        requireConfirmation(argumentsValue, "curio_pause_source");
        return client.patch(idPath("/api/v1/subscriptions", requiredString(argumentsValue, "id")), {
          enabled: false,
        });
      },
    ),
    tool(
      "curio_resume_source",
      "Resume one subscription after explicit confirmation.",
      "required",
      {
        type: "object",
        properties: { id: stringSchema, confirm: confirmationSchema },
        required: ["id", "confirm"],
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        requireConfirmation(argumentsValue, "curio_resume_source");
        return client.patch(idPath("/api/v1/subscriptions", requiredString(argumentsValue, "id")), {
          enabled: true,
        });
      },
    ),
    tool(
      "curio_remove_source",
      "Soft-delete one subscription; collected items remain.",
      "required",
      {
        type: "object",
        properties: { id: stringSchema, confirm: confirmationSchema },
        required: ["id", "confirm"],
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        requireConfirmation(argumentsValue, "curio_remove_source");
        return client.delete(idPath("/api/v1/subscriptions", requiredString(argumentsValue, "id")));
      },
    ),
    tool(
      "curio_list_destinations",
      "List delivery destinations without runtime secrets.",
      "none",
      {
        ...emptySchema,
        properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: stringSchema },
      },
      (value) => client.get("/api/v1/destinations", listQuery(objectArguments(value))),
    ),
    tool(
      "curio_list_routes",
      "List routes, optionally filtered by subscription.",
      "none",
      {
        type: "object",
        properties: {
          subscriptionId: stringSchema,
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: stringSchema,
        },
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        return client.get("/api/v1/routes", {
          ...listQuery(argumentsValue),
          subscriptionId: optionalString(argumentsValue, "subscriptionId"),
        });
      },
    ),
    tool(
      "curio_create_route",
      "Connect one subscription to one destination.",
      "required",
      {
        type: "object",
        properties: {
          subscriptionId: stringSchema,
          destinationId: stringSchema,
          enabled: { type: "boolean" },
          confirm: confirmationSchema,
        },
        required: ["subscriptionId", "destinationId", "confirm"],
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        requireConfirmation(argumentsValue, "curio_create_route");
        return client.post("/api/v1/routes", {
          subscriptionId: requiredString(argumentsValue, "subscriptionId"),
          destinationId: requiredString(argumentsValue, "destinationId"),
          ...(argumentsValue.enabled === undefined
            ? {}
            : { enabled: argumentsValue.enabled === true }),
        });
      },
    ),
    tool(
      "curio_remove_route",
      "Delete one subscription-to-destination route.",
      "required",
      {
        type: "object",
        properties: { id: stringSchema, confirm: confirmationSchema },
        required: ["id", "confirm"],
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        requireConfirmation(argumentsValue, "curio_remove_route");
        return client.delete(idPath("/api/v1/routes", requiredString(argumentsValue, "id")));
      },
    ),
    tool(
      "curio_list_deliveries",
      "List delivery records and statuses.",
      "none",
      {
        type: "object",
        properties: {
          status: stringSchema,
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: stringSchema,
        },
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        return client.get("/api/v1/deliveries", {
          ...listQuery(argumentsValue),
          status: optionalString(argumentsValue, "status"),
        });
      },
    ),
    tool(
      "curio_retry_delivery",
      "Retry an uncertain or permanent-failure delivery.",
      "required",
      {
        type: "object",
        properties: { id: stringSchema, confirm: confirmationSchema },
        required: ["id", "confirm"],
        additionalProperties: false,
      },
      (value) => {
        const argumentsValue = objectArguments(value);
        requireConfirmation(argumentsValue, "curio_retry_delivery");
        return client.post(
          `${idPath("/api/v1/deliveries", requiredString(argumentsValue, "id"))}/retry`,
        );
      },
    ),
  ];
}
