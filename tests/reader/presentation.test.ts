import { describe, expect, test } from "bun:test";
import type { Item, JsonValue } from "../../src/domain/types.ts";
import { renderReaderBlocks } from "../../src/reader/content.ts";
import {
  presentReaderContent,
  type ReaderSourceProfile,
  readerSourceProfile,
} from "../../src/reader/presentation.ts";

function item(metadata: JsonValue, overrides: Partial<Item> = {}): Item {
  return {
    id: "item",
    subscriptionId: "subscription",
    externalId: "external",
    url: "https://example.com/article",
    title: "Stored title",
    summary: null,
    contentText: null,
    contentHtml: null,
    author: "Stored author",
    publishedAt: 1_000,
    sourceUpdatedAt: null,
    discoveredAt: 2_000,
    createdAt: 2_000,
    updatedAt: 2_000,
    readerHiddenAt: null,
    metadata,
    ...overrides,
  };
}

const profiles: Array<{ metadata: JsonValue; profile: ReaderSourceProfile }> = [
  { metadata: { feedFormat: "rss" }, profile: "feed" },
  { metadata: { feedFormat: "atom" }, profile: "feed" },
  { metadata: { feedFormat: "rdf" }, profile: "feed" },
  { metadata: { contentHash: "hash" }, profile: "html" },
  { metadata: { github: { kind: "release" } }, profile: "github" },
  { metadata: { telegram: { messageId: 3 } }, profile: "social" },
  { metadata: { platform: "x" }, profile: "social" },
  { metadata: { source: "youtube", feedFormat: "atom" }, profile: "youtube" },
  { metadata: { email: { from: "reader@example.com" } }, profile: "email" },
  { metadata: {}, profile: "generic" },
];

describe("Reader source presentation", () => {
  test("selects every current source family with YouTube taking precedence over Atom", () => {
    for (const fixture of profiles) {
      expect(readerSourceProfile(item(fixture.metadata))).toBe(fixture.profile);
    }
  });

  test("keeps a bounded fallback for missing title, author, and publication time", () => {
    for (const fixture of profiles) {
      const current = item(fixture.metadata, {
        title: null,
        author: null,
        publishedAt: null,
        contentText: "第一行\n第二行",
      });
      const presentation = presentReaderContent({
        item: current,
        contentHtml: fixture.profile === "html" ? "<p>第一行<br>第二行</p>" : null,
        contentText: current.contentText ?? null,
      });
      expect(presentation.profile).toBe(fixture.profile);
      expect(presentation.readableText).toBe(
        fixture.profile === "github" ? "第一行 第二行" : "第一行\n第二行",
      );
      expect(presentation.blocks).not.toHaveLength(0);
    }
  });

  test("parses strongly Markdown-shaped feed text without guessing ordinary prose", () => {
    const markdown = presentReaderContent({
      item: item({ feedFormat: "atom" }, { contentText: "## Feed section\n\n- one\n- two" }),
      contentHtml: null,
      contentText: "## Feed section\n\n- one\n- two",
    });
    const prose = presentReaderContent({
      item: item({ feedFormat: "rss" }, { contentText: "First line\nsecond line" }),
      contentHtml: null,
      contentText: "First line\nsecond line",
    });

    expect(markdown.blocks.map((block) => block.kind)).toEqual([
      "heading-2",
      "list-item",
      "list-item",
    ]);
    expect(prose.blocks).toEqual([
      { kind: "paragraph", html: "First line<br>second line", text: "First line\nsecond line" },
    ]);
  });

  test("uses bounded Markdown for strong generic structure but not one incidental bullet", () => {
    const markdownSource = "## Section\n\n- one\n- two\n\n![Map](https://images.example/map.png)";
    const markdown = presentReaderContent({
      item: item({}, { contentText: markdownSource }),
      contentHtml: null,
      contentText: markdownSource,
    });
    const proseSource = "A normal introduction\n- one incidental line\ncontinuation";
    const prose = presentReaderContent({
      item: item({}, { contentText: proseSource }),
      contentHtml: null,
      contentText: proseSource,
    });

    expect(markdown.blocks.map((block) => block.kind)).toEqual([
      "heading-2",
      "list-item",
      "list-item",
      "image",
    ]);
    expect(prose.blocks).toEqual([
      {
        kind: "paragraph",
        html: "A normal introduction<br>- one incidental line<br>continuation",
        text: proseSource,
      },
    ]);
  });

  test("never renders captured X login or profile chrome as article content", () => {
    const chrome = "Log in or sign up for X\n\nRui\n4,592 posts\nFollowing\nFollowers";
    const presentation = presentReaderContent({
      item: item(
        { contentHash: "legacy-x-html" },
        { url: "https://x.com/yeruizhang?s=11", contentText: chrome },
      ),
      contentHtml: null,
      contentText: chrome,
    });

    expect(presentation.profile).toBe("html");
    expect(presentation.blocks).toEqual([]);
    expect(presentation.readableText).toBe("");
  });

  test("renders GitHub Markdown into escaped typed blocks", () => {
    const source = `# Stored title\n\n第一段有 **重點** 與 [安全連結](https://example.com/release)。\n\n- 第一點\n- 第二點\n\n> 引用內容\n\n\`\`\`ts\nconst answer = 42 < 50;\n\`\`\`\n\n<script>unsafe()</script> [危險連結](javascript:unsafe())`;
    const presentation = presentReaderContent({
      item: item({ github: { kind: "release" } }, { contentText: source }),
      contentHtml: null,
      contentText: source,
    });
    const rendered = renderReaderBlocks(presentation.blocks);

    expect(presentation.profile).toBe("github");
    expect(presentation.displayTitle).toBe("Stored title");
    expect(presentation.blocks[0]?.kind).toBe("paragraph");
    expect(rendered).toContain("<strong>重點</strong>");
    expect(rendered).toContain("<ul><li>第一點</li><li>第二點</li></ul>");
    expect(rendered).toContain("<blockquote>引用內容</blockquote>");
    expect(rendered).toContain("<pre><code>const answer = 42 &lt; 50;</code></pre>");
    expect(rendered).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
    expect(rendered).not.toContain("javascript:");
    expect(presentation.readableText).not.toStartWith("Stored title");
    expect(presentation.language).toBe("zh");
  });

  test("removes only exact duplicated feed title and author blocks", () => {
    const current = item({ feedFormat: "rss" });
    const presentation = presentReaderContent({
      item: current,
      contentHtml:
        "<h1>Stored title</h1><p>Stored author</p><p>正文標題不是 Stored title 的完整重複。</p>",
      contentText: null,
    });

    expect(presentation.blocks.map((block) => block.text)).toEqual([
      "正文標題不是 Stored title 的完整重複。",
    ]);
  });

  test("preserves social line breaks without inventing headings", () => {
    const presentation = presentReaderContent({
      item: item({ platform: "x" }, { title: "第一行", contentText: "第一行\n第二行" }),
      contentHtml: null,
      contentText: "第一行\n第二行",
    });

    expect(presentation.displayTitle).toBeNull();
    expect(presentation.blocks).toEqual([
      { kind: "paragraph", html: "第一行<br>第二行", text: "第一行\n第二行" },
    ]);
    expect(presentation.readableText).toBe("第一行\n第二行");
  });

  test("adds safe X media without changing canonical quote text", () => {
    const presentation = presentReaderContent({
      item: item(
        {
          platform: "x",
          media: [
            {
              type: "photo",
              url: "https://pbs.twimg.com/media/example.jpg",
              width: 1200,
              height: 800,
            },
            { type: "video", previewUrl: "https://pbs.twimg.com/media/preview.jpg" },
            { type: "photo", url: "http://insecure.example/image.jpg" },
          ],
        },
        { title: "Post", contentText: "Post", author: "Rui (@YeRuiZhang)" },
      ),
      contentHtml: null,
      contentText: "Post",
    });

    expect(presentation.blocks.map((block) => block.kind)).toEqual(["paragraph", "image", "image"]);
    expect(renderReaderBlocks(presentation.blocks)).toContain("pbs.twimg.com/media/example.jpg");
    expect(renderReaderBlocks(presentation.blocks)).not.toContain("insecure.example");
    expect(presentation.readableText).toBe("Post");
  });

  test("does not turn a Telegram owner name into an article heading", () => {
    const presentation = presentReaderContent({
      item: item(
        { telegram: { messageId: 3 } },
        { title: "Channel owner", contentText: "Post body", author: "Channel owner" },
      ),
      contentHtml: null,
      contentText: "Post body",
    });
    expect(presentation.displayTitle).toBeNull();
  });

  test("uses available YouTube description without fabricating missing metadata", () => {
    const current = item(
      { source: "youtube", feedFormat: "atom", videoId: "video" },
      { title: "Video title", author: null, publishedAt: null, summary: "第一行\n第二行" },
    );
    const presentation = presentReaderContent({
      item: current,
      contentHtml: null,
      contentText: null,
    });

    expect(presentation.profile).toBe("youtube");
    expect(presentation.readableText).toBe("第一行\n第二行");
  });

  test("escapes generic plain-text markup instead of treating it as HTML", () => {
    const source = "<script>unsafe()</script>\nsecond line";
    const presentation = presentReaderContent({
      item: item({}, { contentText: source }),
      contentHtml: null,
      contentText: source,
    });
    expect(renderReaderBlocks(presentation.blocks)).toBe(
      "<p>&lt;script&gt;unsafe()&lt;/script&gt;<br>second line</p>",
    );
  });

  test("keeps email quoted sections and handles missing metadata without fabrication", () => {
    const presentation = presentReaderContent({
      item: item(
        { email: { from: "sender@example.com" } },
        {
          title: null,
          author: null,
          publishedAt: null,
          contentText: "正文\n\n> 原信第一行\n原信第二行",
        },
      ),
      contentHtml: null,
      contentText: "正文\n\n> 原信第一行\n原信第二行",
    });

    expect(presentation.blocks.map((block) => block.kind)).toEqual(["paragraph", "quote"]);
    expect(renderReaderBlocks(presentation.blocks)).toContain(
      "<blockquote>原信第一行<br>原信第二行</blockquote>",
    );
    expect(presentation.language).toBe("zh");
  });
});
