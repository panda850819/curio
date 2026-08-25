import { describe, expect, test } from "bun:test";
import {
  parseReaderHtml,
  parseReaderMarkdown,
  parseReaderText,
  readerBlocksText,
  renderReaderBlocks,
} from "../../src/reader/content.ts";

describe("Reader content", () => {
  test("turns supported article HTML into typed blocks", () => {
    const blocks = parseReaderHtml(
      `<article>
        <script>const fake = "<article></article>";</script>
        <h2>段落標題</h2>
        <p>正文有 <strong>重點</strong> 和 <a href="/notes?q=reader">安全連結</a>。</p>
        <ul><li>第一點</li><li>第二點</li></ul>
        <blockquote><p>第一段引文</p><p>第二段引文</p></blockquote>
        <pre><code>const answer = 42 &lt; 50;</code></pre>
      </article>`,
      "https://example.com/posts/one",
    );

    expect(blocks.map((block) => block.kind)).toEqual([
      "heading-2",
      "paragraph",
      "list-item",
      "list-item",
      "quote",
      "code",
    ]);
    expect(renderReaderBlocks(blocks)).toContain(
      '<a href="https://example.com/notes?q=reader" target="_blank" rel="noopener noreferrer">安全連結</a>',
    );
    expect(renderReaderBlocks(blocks)).toContain(
      "<blockquote>第一段引文<br><br>第二段引文</blockquote>",
    );
    expect(readerBlocksText(blocks)).toContain("第一段引文\n\n第二段引文");
    expect(renderReaderBlocks(blocks)).toContain("<ul><li>第一點</li><li>第二點</li></ul>");
    expect(readerBlocksText(blocks)).toContain("第一點\n第二點");
    expect(renderReaderBlocks(blocks)).toContain(
      "<pre><code>const answer = 42 &lt; 50;</code></pre>",
    );
  });

  test("groups repeated HTML article cards into readable entries", () => {
    const blocks = parseReaderHtml(
      `<main>
        <article><a href="/one"><div><div>08.24</div><div>2026</div></div><div><span>AI 教程</span><h2>第一篇</h2><p>第一篇摘要。</p><div><span>閱讀全文</span><span>→</span></div></div></a></article>
        <article><a href="/two"><div><div>08.19</div><div>2026</div></div><div><span>AI 工具</span><h2>第二篇</h2><p>第二篇摘要。</p><div><span>閱讀全文</span><span>→</span></div></div></a></article>
      </main>`,
      "https://example.com/",
    );

    expect(blocks.map((block) => block.kind)).toEqual([
      "separator",
      "entry-metadata",
      "heading-2",
      "paragraph",
      "entry-action",
      "separator",
      "entry-metadata",
      "heading-2",
      "paragraph",
      "entry-action",
    ]);
    expect(readerBlocksText(blocks)).toBe(
      "08.24 · 2026 · AI 教程\n\n第一篇\n\n第一篇摘要。\n\n閱讀全文→\n\n08.19 · 2026 · AI 工具\n\n第二篇\n\n第二篇摘要。\n\n閱讀全文→",
    );
    const rendered = renderReaderBlocks(blocks);
    expect(rendered).toContain('<hr class="reader-entry-divider" aria-hidden="true">');
    expect(rendered).toContain('<p class="reader-entry-metadata">08.24 · 2026 · AI 教程</p>');
    expect(rendered).toContain(
      '<h2><a href="https://example.com/one" target="_blank" rel="noopener noreferrer">第一篇</a></h2>',
    );
    expect(rendered).toContain(
      '<p class="reader-entry-action"><a href="https://example.com/one" target="_blank" rel="noopener noreferrer">閱讀全文→</a></p>',
    );
  });

  test("keeps entry links scoped when listing metadata has its own link", () => {
    const rendered = renderReaderBlocks(
      parseReaderHtml(
        `<article><div>08.24</div><div>2026</div><a href="/category">AI</a><h2><a href="/one">第一篇</a></h2><a href="/one">閱讀全文</a></article>
         <article><div>08.19</div><div>2026</div><span>AI</span><h2><a href="/two">第二篇</a></h2><a href="/two">閱讀全文</a></article>`,
        "https://example.com/",
      ),
    );

    expect(rendered).toContain(
      '<h2><a href="https://example.com/one" target="_blank" rel="noopener noreferrer">第一篇</a></h2>',
    );
    expect(rendered).toContain(
      '<p class="reader-entry-action"><a href="https://example.com/one" target="_blank" rel="noopener noreferrer">閱讀全文</a></p>',
    );
    expect(rendered).toContain(
      '<a href="https://example.com/category" target="_blank" rel="noopener noreferrer">AI</a>',
    );
    expect(rendered).not.toContain('<h2><a href="https://example.com/category"');
  });

  test("limits listing metadata and separators to article boundaries", () => {
    const rendered = renderReaderBlocks(
      parseReaderHtml(
        `<article><a href="/outer"><h2>前標題</h2><article>巢狀內容</article><h2>後標題</h2></a><p>前言</p><div>08.24</div><div>2026</div><div>分類</div><h2>內文標題</h2></article><article>第二篇</article>`,
        "https://example.com/",
      ),
    );

    expect(rendered.match(/reader-entry-divider/gu)).toHaveLength(2);
    expect(rendered).toContain(
      '<h2><a href="https://example.com/outer" target="_blank" rel="noopener noreferrer">後標題</a></h2>',
    );
    expect(rendered).not.toContain("reader-entry-metadata");
    expect(rendered).toContain("<p>08.24</p><p>2026</p><p>分類</p><h2>內文標題</h2>");
  });

  test("does not treat nested or outside content as listing entries", () => {
    const single = renderReaderBlocks(
      parseReaderHtml("<article><h2>A</h2><article>N</article><h2>B</h2></article>"),
    );
    expect(single).toBe("<h2>A</h2><p>N</p><h2>B</h2>");

    const repeated = renderReaderBlocks(
      parseReaderHtml("<p>Read more</p><article>A</article><article>B</article>"),
    );
    expect(repeated).toStartWith("<p>Read more</p>");
    expect(repeated).not.toStartWith('<p class="reader-entry-action">');

    const afterEmpty = renderReaderBlocks(
      parseReaderHtml(" \n<article></article>\n<p>Read more</p><article>B</article>"),
    );
    expect(afterEmpty).toContain("<p>Read more</p>");
    expect(afterEmpty).not.toContain('<p class="reader-entry-action">Read more</p>');
  });

  test("drops executable elements, attributes, embeds, forms, and unsafe links", () => {
    const rendered = renderReaderBlocks(
      parseReaderHtml(
        `<div onclick="steal()">
          <script>secret()</script>
          <style>body { display: none }</style>
          <iframe src="https://tracker.example"></iframe>
          <form action="https://tracker.example"><input name="secret"></form>
          <p class="payload" style="background:url(x)" onmouseover="steal()">
            保留文字
            <a href="javascript:steal()" onclick="steal()">危險連結</a>
            <a href="data:text/html,steal">資料連結</a>
            <a href="javascript&#58;steal()">編碼危險連結</a>
            <a href="https://name:password@example.com/private">含帳密連結</a>
          </p>
          <svg><a href="https://tracker.example">SVG payload</a></svg>
        </div>`,
        "https://example.com/article",
      ),
    );

    expect(rendered).toBe(
      "<p>\n            保留文字\n            危險連結\n            資料連結\n            編碼危險連結\n            含帳密連結\n          </p>",
    );
    expect(rendered).not.toContain("script");
    expect(rendered).not.toContain("style=");
    expect(rendered).not.toContain("onclick");
    expect(rendered).not.toContain("iframe");
    expect(rendered).not.toContain("form");
    expect(rendered).not.toContain("javascript:");
    expect(rendered).not.toContain("data:");
    expect(rendered).not.toContain("password");
    expect(rendered).not.toContain("SVG payload");
  });

  test("renders only safe responsive images from HTML and standalone Markdown", () => {
    const htmlBlocks = parseReaderHtml(
      `<p>Before</p>
       <img src="/cover.jpg" alt="Cover &amp; notes" width="1200" height="800" onerror="steal()" srcset="https://tracker.example/2x 2x">
       <img src="http://insecure.example/image.jpg" alt="insecure">
       <img src="javascript:steal()" alt="unsafe">
       <img src="data:image/png;base64,abc" alt="data">
       <img src="https://127.0.0.1/private" alt="private">
       <img src="https://service.local/private" alt="local">
       <img src="https://tracker.example/pixel.gif" width="1" height="1">`,
      "https://example.com/article",
    );
    const rendered = renderReaderBlocks(htmlBlocks);
    expect(htmlBlocks.map((block) => block.kind)).toEqual(["paragraph", "image"]);
    expect(rendered).toContain(
      '<figure class="reader-image"><img src="https://example.com/cover.jpg" alt="Cover &amp; notes" width="1200" height="800" loading="lazy" decoding="async" referrerpolicy="no-referrer"><figcaption class="reader-image-fallback" data-image-fallback hidden>Cover &amp; notes</figcaption></figure>',
    );
    expect(rendered).not.toContain("srcset");
    expect(rendered).not.toContain("onerror");
    expect(rendered).not.toContain("insecure.example");
    expect(rendered).not.toContain("tracker.example");
    expect(rendered).not.toContain("127.0.0.1");
    expect(rendered).not.toContain("service.local");

    const markdown = renderReaderBlocks(
      parseReaderMarkdown("![Diagram](https://images.example/diagram.png)"),
    );
    expect(markdown).toContain('src="https://images.example/diagram.png"');
    expect(markdown).toContain('alt="Diagram"');
    expect(readerBlocksText(parseReaderMarkdown("![Diagram](https://images.example/a.png)"))).toBe(
      "",
    );
  });

  test("decodes common and numeric HTML entities once", () => {
    expect(
      renderReaderBlocks(parseReaderHtml("<p>&lt; &amp; &ldquo;Curio&rdquo; &#x2014;</p>")),
    ).toBe("<p>&lt; &amp; “Curio” —</p>");
  });

  test("escapes plain text and keeps paragraph boundaries", () => {
    expect(renderReaderBlocks(parseReaderText("第一段 <script>\n仍是文字\n\n第二段 & more"))).toBe(
      "<p>第一段 &lt;script&gt;<br>仍是文字</p><p>第二段 &amp; more</p>",
    );
  });

  test("keeps HTML line breaks aligned with canonical quote text", () => {
    const blocks = parseReaderHtml("<div>第一行<br>第二行</div><div>第三段</div>");
    expect(renderReaderBlocks(blocks)).toBe("<p>第一行<br>第二行</p><p>第三段</p>");
    expect(readerBlocksText(blocks)).toBe("第一行\n第二行\n\n第三段");
  });

  test("parses a bounded Markdown subset without trusting raw HTML or unsafe links", () => {
    const blocks = parseReaderMarkdown(
      "## 小節\n\n段落 **重點**  [安全](https://example.com)\n仍是同一段\n\n1. 一\n2. 二\n\n```\n<script>code</script>\n```\n\n[危險](javascript:run())",
    );
    const rendered = renderReaderBlocks(blocks);
    expect(rendered).toContain("<h2>小節</h2>");
    expect(rendered).toContain('段落 <strong>重點</strong>  <a href="https://example.com/"');
    expect(rendered).toContain("<ol><li>一</li><li>二</li></ol>");
    expect(rendered).toContain("<pre><code>&lt;script&gt;code&lt;/script&gt;</code></pre>");
    expect(rendered).toContain("<p>危險</p>");
    expect(rendered).not.toContain("javascript:");
  });
});
