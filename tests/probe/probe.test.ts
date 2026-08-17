import { describe, expect, test } from "bun:test";
import { probe } from "../../src/probe/probe.ts";
import type { HttpHeaders, HttpResponse, ProbeHttpClient } from "../../src/probe/types.ts";

class Headers implements HttpHeaders {
  constructor(private readonly values: Record<string, string>) {}
  get(name: string): string | null {
    return this.values[name.toLowerCase()] ?? null;
  }
}

function response(url: string, contentType: string, body: string, status = 200): HttpResponse {
  return {
    url,
    status,
    headers: new Headers({ "content-type": contentType }),
    body: new TextEncoder().encode(body),
  };
}

class FakeClient implements ProbeHttpClient {
  readonly requested: string[] = [];

  constructor(private readonly responses: Map<string, HttpResponse | Error>) {}

  async get(url: string): Promise<HttpResponse> {
    this.requested.push(url);
    const result = this.responses.get(url);
    if (!result) throw new Error(`Unexpected URL: ${url}`);
    if (result instanceof Error) throw result;
    return result;
  }
}

const feedCases = [
  ["rss", "application/rss+xml", "<rss version='2.0'><channel /></rss>"],
  ["atom", "application/atom+xml", "<feed xmlns='http://www.w3.org/2005/Atom'></feed>"],
  [
    "rdf",
    "application/rdf+xml",
    "<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'></rdf:RDF>",
  ],
] as const;

describe("probe", () => {
  for (const [format, contentType, xml] of feedCases) {
    test(`detects a direct ${format} feed`, async () => {
      const url = `https://example.com/${format}`;
      const client = new FakeClient(new Map([[url, response(url, contentType, xml)]]));

      const result = await probe(url, client);

      expect(result.candidates).toEqual([
        {
          adapter: "rss",
          format,
          sourceUrl: url,
          sourceKey: url,
          title: null,
          discoveredVia: "direct",
        },
      ]);
    });
  }

  test("discovers relative HTML links, deduplicates, and preserves partial success", async () => {
    const page = "https://example.com/articles/page";
    const valid = "https://example.com/feed.xml";
    const invalid = "https://example.com/broken.xml";
    const html = `<!doctype html><html><head>
      <link rel="ALTERNATE" type="application/rss+xml" href="/feed.xml" title="Example feed">
      <link rel="alternate stylesheet" type="application/rss+xml" href="/feed.xml#top">
      <link rel="alternate" type="application/atom+xml" href="/broken.xml">
      <link rel="alternate" type="text/html" href="/not-a-feed">
    </head></html>`;
    const client = new FakeClient(
      new Map([
        [page, response(page, "text/html; charset=utf-8", html)],
        [valid, response(valid, "application/rss+xml", "<rss><channel /></rss>")],
        [invalid, response(invalid, "application/atom+xml", "<not-feed />")],
      ]),
    );

    const result = await probe(page, client);

    expect(result.candidates).toContainEqual({
      adapter: "rss",
      format: "rss",
      sourceUrl: valid,
      sourceKey: valid,
      title: "Example feed",
      discoveredVia: "html-link",
    });
    expect(result.candidates).toContainEqual({
      adapter: "html",
      format: "html",
      sourceUrl: page,
      sourceKey: page,
      title: null,
      discoveredVia: "direct",
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: "candidate_failed", url: invalid });
    expect(client.requested.filter((url) => url === valid)).toHaveLength(1);
  });

  test("rejects an RDF-looking root without the RDF namespace", async () => {
    const url = "https://example.com/not-rdf";
    const client = new FakeClient(
      new Map([[url, response(url, "application/rdf+xml", "<rdf></rdf>")]]),
    );

    await expect(probe(url, client)).rejects.toMatchObject({ code: "invalid_feed" });
  });

  test("recognizes a public Telegram channel without falling back to HTML", async () => {
    const client = new FakeClient(new Map());

    await expect(probe("https://t.me/journey_of_someone", client)).resolves.toEqual({
      inputUrl: "https://t.me/journey_of_someone",
      finalUrl: "https://t.me/s/journey_of_someone",
      candidates: [
        {
          adapter: "telegram_html",
          format: "html",
          sourceUrl: "https://t.me/s/journey_of_someone",
          sourceKey: "telegram-html:journey_of_someone",
          title: "Telegram HTML: @journey_of_someone",
          discoveredVia: "direct",
        },
      ],
      warnings: [],
    });
    expect(client.requested).toEqual([]);
  });

  test("returns an HTML candidate for a page without feeds", async () => {
    const url = "https://example.com/";
    const client = new FakeClient(
      new Map([[url, response(url, "text/html", "<html><body>Nothing here</body></html>")]]),
    );

    await expect(probe(url, client)).resolves.toMatchObject({
      candidates: [
        {
          adapter: "html",
          format: "html",
          sourceUrl: url,
          sourceKey: url,
          title: null,
          discoveredVia: "direct",
        },
      ],
      warnings: [],
    });
  });
});
