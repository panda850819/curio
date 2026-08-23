export type ReaderBlockKind =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "paragraph"
  | "list-item"
  | "quote"
  | "code";

export interface ReaderBlock {
  kind: ReaderBlockKind;
  html: string;
  ordered?: boolean;
}

interface OpenFrame {
  rootId: number | null;
  kind: ReaderBlockKind;
  html: string;
  text: string;
  ordered?: boolean;
}

const MAX_READER_SOURCE_CHARACTERS = 1_000_000;

const DANGEROUS_ELEMENTS = new Set([
  "applet",
  "audio",
  "button",
  "canvas",
  "embed",
  "form",
  "frame",
  "frameset",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "video",
]);

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
};

const BLOCK_KINDS: Partial<Record<string, ReaderBlockKind>> = {
  h1: "heading-1",
  h2: "heading-2",
  h3: "heading-3",
  p: "paragraph",
  li: "list-item",
  blockquote: "quote",
  pre: "code",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/giu, (entity, token: string) => {
    if (token.startsWith("#")) {
      const hexadecimal = token[1]?.toLowerCase() === "x";
      const digits = token.slice(hexadecimal ? 2 : 1);
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return "";
      }
      return String.fromCodePoint(codePoint);
    }
    return HTML_ENTITIES[token.toLowerCase()] ?? entity;
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeLink(value: string | null, baseUrl?: string | null): string | null {
  if (!value) return null;
  try {
    const decoded = decodeHtmlEntities(value);
    const url = baseUrl ? new URL(decoded, baseUrl) : new URL(decoded);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function addBreak(frame: OpenFrame): void {
  if (frame.text.trim()) frame.html += "<br><br>";
}

export function parseReaderHtml(html: string, baseUrl?: string | null): ReaderBlock[] {
  if (!html.trim()) return [];

  const blocks: ReaderBlock[] = [];
  const listStack: boolean[] = [];
  let frame: OpenFrame | null = null;
  let elementId = 0;
  let dangerousDepth = 0;

  function flushFrame(): void {
    if (!frame) return;
    if (frame.text.trim()) {
      blocks.push({ kind: frame.kind, html: frame.html, ordered: frame.ordered });
    }
    frame = null;
  }

  function ensureParagraph(): OpenFrame {
    if (!frame) {
      frame = { rootId: null, kind: "paragraph", html: "", text: "" };
    }
    return frame;
  }

  new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();
        const id = ++elementId;

        if (DANGEROUS_ELEMENTS.has(tag)) {
          if (element.canHaveContent) {
            dangerousDepth += 1;
            element.onEndTag(() => {
              dangerousDepth = Math.max(0, dangerousDepth - 1);
            });
          }
          return;
        }
        if (dangerousDepth > 0) return;

        if (tag === "ul" || tag === "ol") {
          listStack.push(tag === "ol");
          element.onEndTag(() => {
            listStack.pop();
          });
          return;
        }

        const blockKind = BLOCK_KINDS[tag];
        if (blockKind) {
          if (!frame) {
            frame = {
              rootId: id,
              kind: blockKind,
              html: "",
              text: "",
              ...(blockKind === "list-item"
                ? { ordered: listStack[listStack.length - 1] ?? false }
                : {}),
            };
          } else if (frame.rootId === null) {
            flushFrame();
            frame = {
              rootId: id,
              kind: blockKind,
              html: "",
              text: "",
              ...(blockKind === "list-item"
                ? { ordered: listStack[listStack.length - 1] ?? false }
                : {}),
            };
          } else if (tag === "p" && frame.kind === "quote") {
            addBreak(frame);
          }
          element.onEndTag(() => {
            if (frame?.rootId === id) flushFrame();
          });
          return;
        }

        if (tag === "br") {
          ensureParagraph().html += "<br>";
          return;
        }

        if (tag === "strong" || tag === "b" || tag === "em" || tag === "i") {
          const normalized = tag === "b" ? "strong" : tag === "i" ? "em" : tag;
          ensureParagraph().html += `<${normalized}>`;
          element.onEndTag(() => {
            if (frame) frame.html += `</${normalized}>`;
          });
          return;
        }

        if (tag === "code" && frame?.kind !== "code") {
          ensureParagraph().html += "<code>";
          element.onEndTag(() => {
            if (frame) frame.html += "</code>";
          });
          return;
        }

        if (tag === "a") {
          const href = safeLink(element.getAttribute("href"), baseUrl);
          if (!href) return;
          ensureParagraph().html += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`;
          element.onEndTag(() => {
            if (frame) frame.html += "</a>";
          });
        }
      },
    })
    .onDocument({
      text(text) {
        if (dangerousDepth > 0 || !text.text) return;
        const active = ensureParagraph();
        const decoded = decodeHtmlEntities(text.text);
        active.text += decoded;
        active.html += escapeHtml(decoded);
      },
      end() {
        flushFrame();
      },
    })
    .transform(html.slice(0, MAX_READER_SOURCE_CHARACTERS));

  return blocks;
}

export function parseReaderText(text: string): ReaderBlock[] {
  return text
    .slice(0, MAX_READER_SOURCE_CHARACTERS)
    .replaceAll("\r\n", "\n")
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({
      kind: "paragraph" as const,
      html: escapeHtml(paragraph).replaceAll("\n", "<br>"),
    }));
}

export function renderReaderBlocks(blocks: ReaderBlock[]): string {
  const output: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  function flushList(): void {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    output.push(`<${tag}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
    list = null;
  }

  for (const block of blocks) {
    if (block.kind === "list-item") {
      const ordered = block.ordered === true;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(block.html);
      continue;
    }
    flushList();
    if (block.kind.startsWith("heading-")) {
      const level = block.kind.slice(-1);
      output.push(`<h${level}>${block.html}</h${level}>`);
    } else if (block.kind === "quote") {
      output.push(`<blockquote>${block.html}</blockquote>`);
    } else if (block.kind === "code") {
      output.push(`<pre><code>${block.html}</code></pre>`);
    } else {
      output.push(`<p>${block.html}</p>`);
    }
  }
  flushList();
  return output.join("");
}
