import { describe, expect, test } from "bun:test";
import type { HttpHeaders, HttpResponse, ProbeHttpClient } from "../../../src/probe/types.ts";
import { githubProbeResult } from "../../../src/sources/github/probe.ts";

class Headers implements HttpHeaders {
  constructor(private readonly values: Record<string, string>) {}

  get(name: string): string | null {
    return this.values[name.toLowerCase()] ?? null;
  }
}

class FakeClient implements ProbeHttpClient {
  readonly requests: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];

  async get(
    url: string,
    _maximumBytes: (contentType: string | null) => number,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<HttpResponse> {
    this.requests.push({ url, headers });
    return {
      url,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode("[]"),
    };
  }
}

describe("GitHub probe", () => {
  test("normalizes a repository URL and shorthand without HTML probing", async () => {
    const client = new FakeClient();

    const result = await githubProbeResult("CLI/CLI", client);

    expect(result).toEqual({
      inputUrl: "CLI/CLI",
      finalUrl: "https://github.com/cli/cli",
      candidates: [
        {
          adapter: "github",
          format: "github",
          sourceUrl: "https://github.com/cli/cli",
          sourceKey: "cli/cli",
          title: "GitHub releases: cli/cli",
          discoveredVia: "direct",
        },
      ],
      warnings: [],
    });
    expect(client.requests).toEqual([
      {
        url: "https://api.github.com/repos/cli/cli/releases?per_page=100",
        headers: { Accept: "application/vnd.github+json" },
      },
    ]);
  });

  test("returns null for non-GitHub input", async () => {
    const client = new FakeClient();

    await expect(githubProbeResult("https://example.com/repository", client)).resolves.toBeNull();
    expect(client.requests).toEqual([]);
  });
});
