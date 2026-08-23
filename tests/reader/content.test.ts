import { describe, expect, test } from "bun:test";
import { parseReaderHtml, parseReaderText, renderReaderBlocks } from "../../src/reader/content.ts";

describe("Reader content", () => {
  test("turns supported article HTML into typed blocks", () => {
    const blocks = parseReaderHtml(
      `<article>
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
    expect(renderReaderBlocks(blocks)).toContain("<ul><li>第一點</li><li>第二點</li></ul>");
    expect(renderReaderBlocks(blocks)).toContain(
      "<pre><code>const answer = 42 &lt; 50;</code></pre>",
    );
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
});
