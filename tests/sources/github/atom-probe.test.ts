import { describe, expect, test } from "bun:test";
import type { HttpHeaders, HttpResponse, ProbeHttpClient } from "../../../src/probe/types.ts";
import { githubAtomProbeResult } from "../../../src/sources/github/atom-probe.ts";

class Headers implements HttpHeaders {
  constructor(private readonly values: Record<string, string>) {}

  get(name: string): string | null {
    return this.values[name.toLowerCase()] ?? null;
  }
}

class FakeClient implements ProbeHttpClient {
  readonly requests: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];

  constructor(private readonly responses: Array<HttpResponse | Error>) {}

  async get(
    url: string,
    _maximumBytes: (contentType: string | null) => number,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<HttpResponse> {
    this.requests.push({ url, headers });
    const response = this.responses.shift();
    if (!response) throw new Error("No fake response configured");
    if (response instanceof Error) throw response;
    return response;
  }
}

function feed(entry: string): string {
  return `<feed xmlns="http://www.w3.org/2005/Atom"><title>GitHub</title><id>https://github.com/cli/cli</id><updated>2026-08-18T00:00:00Z</updated>${entry}</feed>`;
}

function releaseEntry(): string {
  return `<entry><title>v1.2.3</title><id>tag:github.com,2008:Release/123/v1.2.3</id><link rel="alternate" href="https://github.com/cli/cli/releases/tag/v1.2.3"/><published>2026-08-18T00:00:00Z</published><updated>2026-08-18T01:00:00Z</updated><summary>Release summary</summary></entry>`;
}

function response(
  body: string,
  options: { status?: number; contentType?: string; url?: string } = {},
): HttpResponse {
  const url = options.url ?? "https://github.com/cli/cli/releases.atom";
  return {
    url,
    status: options.status ?? 200,
    headers: new Headers({ "content-type": options.contentType ?? "application/atom+xml" }),
    body: new TextEncoder().encode(body),
  };
}

describe("GitHub Atom probe", () => {
  test("accepts a capability-probed releases feed", async () => {
    const client = new FakeClient([response(feed(releaseEntry()))]);

    const result = await githubAtomProbeResult(
      "https://www.github.com/CLI/CLI/releases.atom",
      client,
    );

    expect(result).toMatchObject({
      finalUrl: "https://github.com/cli/cli/releases.atom",
      candidates: [
        {
          adapter: "github_atom",
          format: "atom",
          sourceUrl: "https://github.com/cli/cli/releases.atom",
          sourceKey: "cli/cli:releases",
          title: "GitHub releases (Atom): cli/cli",
          discoveredVia: "direct",
        },
      ],
    });
    expect(client.requests).toEqual([
      {
        url: "https://github.com/cli/cli/releases.atom",
        headers: { Accept: "application/atom+xml" },
      },
    ]);
  });

  test("normalizes a branch path and stores a branch-specific source key", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const client = new FakeClient([
      response(
        feed(
          `<entry><title>Commit</title><id>tag:github.com,2008:Commit/${sha}</id><link rel="alternate" href="https://github.com/cli/cli/commit/${sha}"/><updated>2026-08-18T01:00:00Z</updated></entry>`,
        ),
        { url: "https://github.com/cli/cli/commits/feature/work.atom" },
      ),
    ]);

    const result = await githubAtomProbeResult(
      "https://www.github.com/CLI/CLI/commits/feature%2Fwork.atom",
      client,
    );

    expect(result).toMatchObject({
      candidates: [
        {
          adapter: "github_atom",
          sourceUrl: "https://github.com/cli/cli/commits/feature/work.atom",
          sourceKey: "cli/cli:commits:feature/work",
          title: "GitHub commits (Atom): cli/cli@feature/work",
        },
      ],
    });
  });

  test("rejects unsupported status and content type without fallback", async () => {
    const statusClient = new FakeClient([response("", { status: 406 })]);
    await expect(
      githubAtomProbeResult("https://github.com/cli/cli/releases.atom", statusClient),
    ).rejects.toMatchObject({ code: "http_status" });

    const contentTypeClient = new FakeClient([response("{}", { contentType: "application/json" })]);
    await expect(
      githubAtomProbeResult("https://github.com/cli/cli/releases.atom", contentTypeClient),
    ).rejects.toMatchObject({ code: "invalid_feed" });
  });
});
