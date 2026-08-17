import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { normalizeFeed } from "../../../src/sources/rss/normalize.ts";

async function fixture(name: string): Promise<string> {
  return Bun.file(join(import.meta.dir, "fixtures", name)).text();
}

describe("normalizeFeed", () => {
  test("normalizes RSS IDs, content, dates, and malformed-entry warnings", async () => {
    const result = normalizeFeed(await fixture("rss.xml"), "https://example.com/feed.xml");

    expect(result.format).toBe("rss");
    expect(result.title).toBe("Curio RSS");
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]?.item).toMatchObject({
      externalId: "rss-1",
      url: "https://example.com/newest",
      contentHtml: "<p>Newest content</p>",
      author: "Panda",
      metadata: { feedFormat: "rss", categories: ["curio"] },
    });
    expect(result.entries[1]?.item.externalId).toMatch(/^url-sha256:/);
    expect(result.entries[2]?.item).toMatchObject({
      externalId: expect.stringMatching(/^content-sha256:/),
      publishedAt: null,
    });
    expect(result.warnings).toContainEqual({
      code: "invalid_date",
      entryIndex: 2,
      message: "Entry 2 has an invalid published date",
    });
  });

  test("normalizes Atom entries", async () => {
    const result = normalizeFeed(await fixture("atom.xml"), "https://example.com/atom.xml");

    expect(result).toMatchObject({
      format: "atom",
      title: "Curio Atom",
      warnings: [],
      entries: [
        {
          item: {
            externalId: "atom-1",
            url: "https://example.com/atom-entry",
            contentHtml: "<p>Atom content</p>",
            author: "Panda",
            metadata: { feedFormat: "atom", categories: ["curio"] },
          },
        },
      ],
    });
  });

  test("normalizes RDF entries", async () => {
    const result = normalizeFeed(await fixture("rdf.xml"), "https://example.com/rdf.xml");

    expect(result).toMatchObject({
      format: "rdf",
      title: "Curio RDF",
      warnings: [],
      entries: [
        {
          item: {
            externalId: "rdf-1",
            url: "https://example.com/rdf-entry",
            contentHtml: "<p>RDF content</p>",
            metadata: { feedFormat: "rdf", categories: ["curio"] },
          },
        },
      ],
    });
  });

  test("rejects a malformed feed", async () => {
    const xml = await fixture("malformed.xml");
    expect(() => normalizeFeed(xml, "https://example.com/feed.xml")).toThrow();
  });
});
