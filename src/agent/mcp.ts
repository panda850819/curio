import { CurioAgentApiClient, CurioAgentApiError } from "./client.ts";
import { type CurioAgentTool, CurioAgentToolError, createCurioAgentTools } from "./tools.ts";

const MCP_PROTOCOL_VERSION = "2024-11-05";

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return isObject(value) && value.jsonrpc === "2.0" && typeof value.method === "string";
}

function response(id: JsonRpcId, result: unknown): JsonObject {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(data: unknown): JsonObject {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }],
    isError: false,
  };
}

function toolError(error: unknown): JsonObject {
  const normalized =
    error instanceof CurioAgentToolError || error instanceof CurioAgentApiError
      ? { code: error.code, message: error.message }
      : { code: "tool_error", message: error instanceof Error ? error.message : String(error) };
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: normalized }) }],
    isError: true,
  };
}

export interface CurioMcpServer {
  handle(message: unknown): Promise<JsonObject | null>;
}

export function createCurioMcpServer(tools: CurioAgentTool[]): CurioMcpServer {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    async handle(message: unknown): Promise<JsonObject | null> {
      if (!isRequest(message)) return errorResponse(null, -32_600, "Invalid Request");
      if (message.id === undefined) {
        if (message.method === "notifications/initialized") return null;
        return null;
      }

      if (message.method === "initialize") {
        const requestedVersion = message.params?.protocolVersion;
        return response(message.id, {
          protocolVersion:
            typeof requestedVersion === "string" ? requestedVersion : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "curio", version: "1" },
          instructions: "Call curio_get_manifest before mutating Curio resources.",
        });
      }
      if (message.method === "tools/list") {
        return response(message.id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description:
              tool.confirmation === "required"
                ? `${tool.description} Requires arguments.confirm=true after explicit user confirmation.`
                : tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
      }
      if (message.method === "tools/call") {
        const name = message.params?.name;
        if (typeof name !== "string") {
          return errorResponse(message.id, -32_602, "tools/call requires params.name");
        }
        const tool = toolsByName.get(name);
        if (!tool) return errorResponse(message.id, -32_602, `Unknown tool: ${name}`);
        try {
          return response(message.id, toolResult(await tool.call(message.params?.arguments ?? {})));
        } catch (error) {
          return response(message.id, toolError(error));
        }
      }
      return errorResponse(message.id, -32_601, `Method not found: ${message.method}`);
    },
  };
}

async function writeResponse(value: JsonObject): Promise<void> {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function runCurioMcpServer(
  client: CurioAgentApiClient,
  input: AsyncIterable<Uint8Array> = Bun.stdin.stream(),
): Promise<void> {
  const server = createCurioMcpServer(createCurioAgentTools(client));
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        await writeResponse(errorResponse(null, -32_700, "Parse error"));
        continue;
      }
      const result = await server.handle(message);
      if (result) await writeResponse(result);
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    let message: unknown;
    try {
      message = JSON.parse(trailing);
    } catch {
      await writeResponse(errorResponse(null, -32_700, "Parse error"));
      return;
    }
    const result = await server.handle(message);
    if (result) await writeResponse(result);
  }
}

if (import.meta.main) {
  const baseUrl = process.env.CURIO_AGENT_URL ?? "http://127.0.0.1:3000";
  await runCurioMcpServer(new CurioAgentApiClient(baseUrl));
}
