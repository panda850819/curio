import { describe, expect, test } from "bun:test";
import { CurioAgentApiClient } from "../../src/agent/client.ts";
import { AGENT_MANIFEST } from "../../src/agent/manifest.ts";
import { createCurioMcpServer, runCurioMcpServer } from "../../src/agent/mcp.ts";
import { createCurioAgentTools } from "../../src/agent/tools.ts";

function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(status >= 400 ? { error: data } : { data }, { status, headers });
}

function harness() {
  const requests: Array<{ method: string; path: string; body: string | null }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname, body: await request.text() });
    if (url.pathname === "/api/v1/agent/manifest") {
      return jsonResponse({ manifestVersion: "1", service: "curio" });
    }
    if (url.pathname === "/api/v1/probes") {
      return jsonResponse({ candidates: [], warnings: [] });
    }
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "curio" });
    }
    return jsonResponse({ code: "not_found", message: "Route not found" }, 404);
  };
  const client = new CurioAgentApiClient("http://curio.test", { fetch: fetchImpl });
  const server = createCurioMcpServer(createCurioAgentTools(client));
  return { requests, client, server };
}

async function callTool(
  server: ReturnType<typeof createCurioMcpServer>,
  name: string,
  argumentsValue: unknown,
): Promise<Record<string, unknown>> {
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: argumentsValue },
  });
  const content = (response?.result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("Curio MCP transport", () => {
  test("negotiates, lists tools, and calls a read tool", async () => {
    const context = harness();
    const initialized = await context.server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect(initialized).toMatchObject({
      result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } } },
    });

    const listed = await context.server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listedTools = (listed?.result as { tools: Array<{ name: string }> }).tools;
    expect(listedTools.map((tool) => tool.name)).toContain("curio_probe_source");
    expect(listedTools.map((tool) => tool.name)).toContain("curio_remove_source");
    expect(listedTools.map((tool) => tool.name).sort()).toEqual(
      [...AGENT_MANIFEST.toolkit.toolNames].sort(),
    );

    const called = await context.server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "curio_probe_source", arguments: { url: "https://example.com/feed" } },
    });
    const content = (called?.result as { content: Array<{ text: string }> }).content;
    expect(JSON.parse(content[0]?.text ?? "{}")).toEqual({
      ok: true,
      data: { candidates: [], warnings: [] },
    });
    expect(context.requests).toEqual([
      { method: "POST", path: "/api/v1/probes", body: '{"url":"https://example.com/feed"}' },
    ]);
  });

  test("blocks destructive tools without explicit confirmation", async () => {
    const context = harness();
    const called = await context.server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "curio_remove_source", arguments: { id: "subscription-id" } },
    });
    const content = (called?.result as { content: Array<{ text: string }>; isError: boolean })
      .content;
    expect((called?.result as { isError: boolean }).isError).toBe(true);
    expect(JSON.parse(content[0]?.text ?? "{}")).toMatchObject({
      ok: false,
      error: { code: "confirmation_required" },
    });
    expect(context.requests).toHaveLength(0);
  });

  test("returns JSON-RPC errors for unknown tools and methods", async () => {
    const context = harness();
    await expect(
      context.server.handle({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "missing" },
      }),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    await expect(
      context.server.handle({ jsonrpc: "2.0", id: 6, method: "unknown/method" }),
    ).resolves.toMatchObject({ error: { code: -32601 } });
  });

  test("preserves request IDs and distinguishes validation, Curio, and transport errors", async () => {
    const successRequests: string[] = [];
    const successClient = new CurioAgentApiClient("http://curio.test", {
      fetch: async (input, init) => {
        successRequests.push(new Request(input, init).url);
        return jsonResponse({ candidates: [], warnings: [] }, 200, {
          "x-request-id": "request-success",
        });
      },
    });
    const successServer = createCurioMcpServer(createCurioAgentTools(successClient));
    expect(
      await callTool(successServer, "curio_probe_source", { url: "https://example.com" }),
    ).toEqual({
      ok: true,
      data: { candidates: [], warnings: [] },
      requestId: "request-success",
    });
    expect(await callTool(successServer, "curio_probe_source", { url: " " })).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(successRequests).toHaveLength(1);

    const apiErrorServer = createCurioMcpServer(
      createCurioAgentTools(
        new CurioAgentApiClient("http://curio.test", {
          fetch: async () =>
            jsonResponse({ code: "upstream_rate_limited", message: "Try again later" }, 429, {
              "x-request-id": "request-api-error",
            }),
        }),
      ),
    );
    expect(await callTool(apiErrorServer, "curio_get_health", {})).toMatchObject({
      ok: false,
      error: { code: "upstream_rate_limited", requestId: "request-api-error" },
    });

    const transportServer = createCurioMcpServer(
      createCurioAgentTools(
        new CurioAgentApiClient("http://curio.test", {
          fetch: async () => {
            throw new Error("connection refused");
          },
        }),
      ),
    );
    expect(await callTool(transportServer, "curio_get_health", {})).toMatchObject({
      ok: false,
      error: { code: "transport_error" },
    });
  });

  test("runs the newline-delimited stdio transport without opening a port", async () => {
    const context = harness();
    const outputs: Array<Record<string, unknown>> = [];
    const bytes = new TextEncoder().encode(
      [
        "not-json",
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize" }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "curio_get_health" },
        }),
      ].join("\n"),
    );
    async function* input(): AsyncGenerator<Uint8Array> {
      yield bytes.slice(0, 11);
      yield bytes.slice(11);
    }

    await runCurioMcpServer(context.client, input(), (value) => {
      outputs.push(value);
    });

    expect(outputs[0]).toMatchObject({ error: { code: -32700 } });
    expect(outputs[1]).toMatchObject({ id: 7, result: { protocolVersion: "2024-11-05" } });
    expect(outputs[2]).toMatchObject({
      id: 8,
      result: {
        content: [{ text: JSON.stringify({ ok: true, data: { status: "ok", service: "curio" } }) }],
      },
    });
  });

  test("supports the probe-to-subscribe-route-poll-verify flow", async () => {
    const requests: string[] = [];
    const candidate = {
      adapter: "rss",
      format: "rss",
      sourceUrl: "https://example.com/feed.xml",
      sourceKey: "https://example.com/feed.xml",
      title: "Example",
      discoveredVia: "direct",
    };
    const client = new CurioAgentApiClient("http://curio.test", {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (request.method === "POST" && url.pathname === "/api/v1/probes") {
          return jsonResponse({ candidates: [candidate], warnings: ["fixture warning"] });
        }
        if (request.method === "POST" && url.pathname === "/api/v1/subscriptions") {
          return jsonResponse(
            { subscription: { id: "subscription-1" }, disposition: "created" },
            201,
          );
        }
        if (request.method === "POST" && url.pathname === "/api/v1/routes") {
          return jsonResponse({ id: "route-1" }, 201);
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/v1/subscriptions/subscription-1/poll"
        ) {
          return jsonResponse({ status: "fetched", insertedItems: 1, duplicateItems: 0 });
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/v1/destinations/destination-1/verify"
        ) {
          return jsonResponse({
            destinationId: "destination-1",
            chat: { id: -1001, type: "channel" },
          });
        }
        return jsonResponse({ code: "not_found", message: "fixture route not found" }, 404);
      },
    });
    const server = createCurioMcpServer(createCurioAgentTools(client));

    const probe = await callTool(server, "curio_probe_source", { url: candidate.sourceUrl });
    expect(probe).toMatchObject({ ok: true, data: { candidates: [candidate] } });
    const subscription = await callTool(server, "curio_create_subscription", {
      candidate,
      confirm: true,
    });
    expect(subscription).toMatchObject({
      ok: true,
      data: { subscription: { id: "subscription-1" } },
    });
    expect(
      await callTool(server, "curio_create_route", {
        subscriptionId: "subscription-1",
        destinationId: "destination-1",
        confirm: true,
      }),
    ).toMatchObject({ ok: true, data: { id: "route-1" } });
    expect(await callTool(server, "curio_poll_source", { id: "subscription-1" })).toMatchObject({
      ok: true,
      data: { status: "fetched", insertedItems: 1 },
    });
    expect(
      await callTool(server, "curio_verify_destination", {
        id: "destination-1",
        confirm: true,
      }),
    ).toMatchObject({ ok: true, data: { destinationId: "destination-1" } });
    expect(requests).toEqual([
      "POST /api/v1/probes",
      "POST /api/v1/subscriptions",
      "POST /api/v1/routes",
      "POST /api/v1/subscriptions/subscription-1/poll",
      "POST /api/v1/destinations/destination-1/verify",
    ]);
  });
});
