import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { gzipSync } from "node:zlib";
import { ProbeError } from "../../src/probe/errors.ts";
import { type ConnectionOptions, SafeHttpClient } from "../../src/probe/http-client.ts";
import type { ProbeResolver, ResolvedAddress } from "../../src/probe/types.ts";

const servers: Bun.Server<unknown>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

class FakeResolver implements ProbeResolver {
  readonly hostnames: string[] = [];

  constructor(private readonly records: Record<string, ResolvedAddress[]>) {}

  async resolve(hostname: string): Promise<ResolvedAddress[]> {
    this.hostnames.push(hostname);
    return this.records[hostname] ?? [];
  }
}

function localConnectionFactory(port: number | undefined, calls: ConnectionOptions[]) {
  if (port === undefined) throw new Error("Test server has no listening port");
  return (options: ConnectionOptions) => {
    calls.push(options);
    return connect({ host: "127.0.0.1", port });
  };
}

function startServer(
  fetch: (request: Request) => Response | Promise<Response>,
): Bun.Server<unknown> {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  return server;
}

describe("SafeHttpClient", () => {
  test("dials the validated address while preserving the hostname", async () => {
    const server = startServer((request) =>
      Response.json({ host: request.headers.get("host"), path: new URL(request.url).pathname }),
    );
    const resolver = new FakeResolver({
      "probe.test": [{ address: "8.8.8.8", family: 4 }],
    });
    const connections: ConnectionOptions[] = [];
    const client = new SafeHttpClient(
      resolver,
      localConnectionFactory(server.port, connections),
      1_000,
    );

    const result = await client.get("http://probe.test/path", () => 1_024);

    expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({
      host: "probe.test",
      path: "/path",
    });
    expect(connections).toEqual([
      {
        address: "8.8.8.8",
        family: 4,
        port: 80,
        tls: false,
        servername: "probe.test",
      },
    ]);
  });

  test("blocks mixed public and private DNS results before dialing", async () => {
    const resolver = new FakeResolver({
      "mixed.test": [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    const connections: ConnectionOptions[] = [];
    const client = new SafeHttpClient(resolver, (options) => {
      connections.push(options);
      throw new Error("must not dial");
    });

    await expect(client.get("http://mixed.test", () => 100)).rejects.toMatchObject({
      code: "blocked_address",
    });
    expect(connections).toEqual([]);
  });

  test("revalidates redirects and blocks a private target before the second request", async () => {
    const server = startServer(
      () =>
        new Response(null, { status: 302, headers: { Location: "http://private.test/secret" } }),
    );
    const resolver = new FakeResolver({
      "public.test": [{ address: "8.8.8.8", family: 4 }],
      "private.test": [{ address: "127.0.0.1", family: 4 }],
    });
    const connections: ConnectionOptions[] = [];
    const client = new SafeHttpClient(
      resolver,
      localConnectionFactory(server.port, connections),
      1_000,
    );

    await expect(client.get("http://public.test", () => 100)).rejects.toMatchObject({
      code: "blocked_address",
    });
    expect(resolver.hostnames).toEqual(["public.test", "private.test"]);
    expect(connections).toHaveLength(1);
  });

  test("detects redirect loops and redirect limits", async () => {
    const loopServer = startServer(
      () => new Response(null, { status: 302, headers: { Location: "/loop" } }),
    );
    const limitServer = startServer((request) => {
      const step = Number(new URL(request.url).pathname.slice(1) || "0");
      return new Response(null, { status: 302, headers: { Location: `/${step + 1}` } });
    });
    const resolver = new FakeResolver({
      "loop.test": [{ address: "8.8.8.8", family: 4 }],
      "limit.test": [{ address: "8.8.4.4", family: 4 }],
    });

    const loopClient = new SafeHttpClient(
      resolver,
      localConnectionFactory(loopServer.port, []),
      1_000,
    );
    await expect(loopClient.get("http://loop.test/loop", () => 100)).rejects.toMatchObject({
      code: "redirect_loop",
    });

    const limitClient = new SafeHttpClient(
      resolver,
      localConnectionFactory(limitServer.port, []),
      1_000,
      1,
    );
    await expect(limitClient.get("http://limit.test/0", () => 100)).rejects.toMatchObject({
      code: "redirect_limit",
    });
  });

  test("rejects unsupported schemes and URL credentials before DNS", async () => {
    const resolver = new FakeResolver({});
    const client = new SafeHttpClient(resolver);

    await expect(client.get("file:///etc/passwd", () => 100)).rejects.toMatchObject({
      code: "unsupported_scheme",
    });
    await expect(client.get("https://user:secret@example.com", () => 100)).rejects.toMatchObject({
      code: "url_credentials",
    });
    expect(resolver.hostnames).toEqual([]);
  });

  test("enforces the limit after decompression", async () => {
    const compressed = gzipSync("x".repeat(1_000));
    const server = startServer(
      () =>
        new Response(compressed, {
          headers: { "Content-Encoding": "gzip", "Content-Type": "application/xml" },
        }),
    );
    const resolver = new FakeResolver({
      "compressed.test": [{ address: "8.8.8.8", family: 4 }],
    });
    const client = new SafeHttpClient(resolver, localConnectionFactory(server.port, []), 1_000);

    await expect(client.get("http://compressed.test", () => 100)).rejects.toMatchObject({
      code: "body_limit",
    });
  });

  test("applies the timeout to DNS resolution", async () => {
    const resolver: ProbeResolver = {
      resolve: () => new Promise(() => {}),
    };
    const client = new SafeHttpClient(resolver, undefined, 10);

    await expect(client.get("http://dns-timeout.test", () => 100)).rejects.toMatchObject({
      code: "request_timeout",
    });
  });

  test("reports timeouts with a typed error", async () => {
    const server = startServer(async () => {
      await Bun.sleep(100);
      return new Response("late");
    });
    const resolver = new FakeResolver({
      "slow.test": [{ address: "8.8.8.8", family: 4 }],
    });
    const client = new SafeHttpClient(resolver, localConnectionFactory(server.port, []), 10);

    try {
      await client.get("http://slow.test", () => 100);
      throw new Error("request unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(ProbeError);
      expect(error).toMatchObject({ code: "request_timeout" });
    }
  });
});
