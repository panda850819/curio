import { describe, expect, test } from "bun:test";
import {
  extractPageTitle,
  HtmlContentTooLargeError,
  HtmlSelectorError,
  normalizeHtmlDocument,
  normalizeUrl,
} from "../../../src/sources/html/normalize.ts";

describe("normalizeHtmlDocument", () => {
  test("removes executable and volatile markup while canonicalizing text and URLs", () => {
    const first = normalizeHtmlDocument(
      `<!doctype html><html><head><title>Example page</title><script>window.time=1</script></head><body><main id="main-1" data-updated="100"><article class="card updated-100"><a href="/item?utm_source=news&b=2&a=1#top">  Hello   world </a></article></main><style>.card{}</style></body></html>`,
      "https://example.com/page?utm_campaign=old",
      "main article",
    );
    const second = normalizeHtmlDocument(
      `<html><head><title>Example page</title><script>window.time=2</script></head><body><main id="main-2" data-updated="200"><article class="card updated-200"><a href="https://example.com/item?a=1&b=2&utm_source=other#changed">Hello world</a></article></main><style>.card{color:red}</style></body></html>`,
      "https://example.com/page?utm_campaign=new",
      "main article",
    );
    expect(first.canonical).toBe(second.canonical);
    expect(first.text).toBe("Hello world");
    expect(first.canonical).not.toContain("script");
    expect(first.canonical).not.toContain("data-updated");
    expect(first.title).toBe("Example page");
  });

  test("supports descendant selectors, malformed HTML, and selector failures", () => {
    const result = normalizeHtmlDocument(
      "<html><body><section><div class='content'><p>First<br>second</p></div></section>",
      "https://example.com/page",
      "section > .content",
    );
    expect(result.text).toBe("First second");
    expect(() =>
      normalizeHtmlDocument("<main>text</main>", "https://example.com", ".missing"),
    ).toThrow(HtmlSelectorError);
    expect(extractPageTitle("<title>  A title </title>")).toBe("A title");
  });

  test("enforces extracted content byte limits and stable source keys", () => {
    expect(() =>
      normalizeHtmlDocument("<main>abcdef</main>", "https://example.com", undefined, 2),
    ).toThrow(HtmlContentTooLargeError);
    expect(normalizeUrl("https://example.com/page?utm_source=x&b=2&a=1#fragment")).toBe(
      "https://example.com/page?a=1&b=2",
    );
  });
});
