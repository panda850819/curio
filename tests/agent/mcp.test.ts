import { describe, expect, test } from "bun:test";
import { CurioAgentApiClient } from "../../src/agent/client.ts";
import { AGENT_MANIFEST } from "../../src/agent/manifest.ts";
import { createCurioMcpServer } from "../../src/agent/mcp.ts";
import { createCurioAgentTools } from "../../src/agent/tools.ts";

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(status >= 400 ? { error: data } : { data }, { status });
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
    return jsonResponse({ code: "not_found", message: "Route not found" }, 404);
  };
  const client = new CurioAgentApiClient("http://curio.test", { fetch: fetchImpl });
  const server = createCurioMcpServer(createCurioAgentTools(client));
  return { requests, server };
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
});
