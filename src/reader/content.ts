import ipaddr from "ipaddr.js";

export type ReaderBlockKind =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "paragraph"
  | "list-item"
  | "quote"
  | "code"
  | "image"
  | "entry-metadata"
  | "entry-action"
  | "separator";

export interface ReaderBlock {
  kind: ReaderBlockKind;
  html: string;
  text: string;
  ordered?: boolean;
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
  entryHref?: string;
  inEntry?: boolean;
}

interface OpenFrame {
  rootId: number | null;
  kind: ReaderBlockKind;
  html: string;
  text: string;
  ordered?: boolean;
  entryHref?: string;
  inEntry?: boolean;
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

const STRUCTURAL_BOUNDARIES = new Set([
  "address",
  "article",
  "dd",
  "div",
  "dt",
  "figcaption",
  "footer",
  "header",
  "main",
  "section",
  "td",
  "th",
  "tr",
]);

export function decodeHtmlEntities(value: string): string {
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

function imageDimension(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 8_192 ? parsed : undefined;
}

export function readerImageBlock(
  source: string | null | undefined,
  alt = "",
  baseUrl?: string | null,
  width?: string | number | null,
  height?: string | number | null,
): ReaderBlock | null {
  const src = safeLink(source ?? null, baseUrl);
  if (!src || src.length > 4_096) return null;
  const url = new URL(src);
  if (url.protocol !== "https:") return null;
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    (ipaddr.isValid(hostname) && ipaddr.process(hostname).range() !== "unicast")
  ) {
    return null;
  }
  const boundedWidth = imageDimension(width);
  const boundedHeight = imageDimension(height);
  if (
    (boundedWidth !== undefined && boundedWidth <= 2) ||
    (boundedHeight !== undefined && boundedHeight <= 2)
  ) {
    return null;
  }
  return {
    kind: "image",
    html: "",
    text: "",
    src,
    alt: decodeHtmlEntities(alt).replace(/\s+/gu, " ").trim().slice(0, 500),
    ...(boundedWidth ? { width: boundedWidth } : {}),
    ...(boundedHeight ? { height: boundedHeight } : {}),
  };
}

function addBreak(frame: OpenFrame): void {
  if (!frame.text.trim()) return;
  frame.html += "<br><br>";
  frame.text += "\n\n";
}

export function parseReaderHtml(html: string, baseUrl?: string | null): ReaderBlock[] {
  if (!html.trim()) return [];

  const countableHtml = html
    .slice(0, MAX_READER_SOURCE_CHARACTERS)
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "");
  const articleCount = countableHtml.match(/<article(?:\s|>)/giu)?.length ?? 0;
  const blocks: ReaderBlock[] = [];
  const listStack: boolean[] = [];
  let frame: OpenFrame | null = null;
  let elementId = 0;
  let dangerousDepth = 0;
  let articleDepth = 0;
  let activeEntryHref: string | undefined;
  let inTopLevelArticle = false;
  let activeEntryCandidate:
    | { href: string; frame: OpenFrame; htmlStart: number; sawBoundary: boolean }
    | undefined;
  const topLevelArticles = new Set<number>();

  function flushFrame(): void {
    if (!frame) return;
    if (frame.text.trim()) {
      blocks.push({
        kind: frame.kind,
        html: frame.html,
        text: frame.text.trim(),
        ordered: frame.ordered,
        entryHref: frame.entryHref,
        inEntry: frame.inEntry,
      });
    }
    frame = null;
  }

  function ensureParagraph(): OpenFrame {
    if (!frame) {
      frame = {
        rootId: null,
        kind: "paragraph",
        html: "",
        text: "",
        entryHref: activeEntryHref,
        inEntry: inTopLevelArticle,
      };
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

        if (tag === "article" && articleCount > 1) {
          const topLevel = articleDepth === 0;
          if (topLevel) {
            topLevelArticles.add(id);
            activeEntryHref = undefined;
            activeEntryCandidate = undefined;
            inTopLevelArticle = true;
            if (frame && !frame.text.trim()) frame.inEntry = true;
          }
          articleDepth += 1;
        }

        if (
          activeEntryCandidate &&
          tag !== "a" &&
          (BLOCK_KINDS[tag] || STRUCTURAL_BOUNDARIES.has(tag) || tag === "img")
        ) {
          activeEntryCandidate.sawBoundary = true;
        }

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
              entryHref: activeEntryHref,
              inEntry: inTopLevelArticle,
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
              entryHref: activeEntryHref,
              inEntry: inTopLevelArticle,
            };
          } else if (tag === "p" && frame.kind === "quote") {
            addBreak(frame);
          }
          element.onEndTag(() => {
            if (frame?.rootId === id) flushFrame();
          });
          return;
        }

        if (STRUCTURAL_BOUNDARIES.has(tag)) {
          if (frame?.rootId === null && frame.text.trim()) flushFrame();
          if (topLevelArticles.has(id)) {
            blocks.push({ kind: "separator", html: "", text: "" });
          }
          element.onEndTag(() => {
            if (frame?.rootId === null && frame.text.trim()) flushFrame();
            if (tag === "article" && articleCount > 1) {
              articleDepth = Math.max(0, articleDepth - 1);
              if (topLevelArticles.has(id)) {
                activeEntryHref = undefined;
                activeEntryCandidate = undefined;
                inTopLevelArticle = false;
                if (frame && !frame.text.trim()) {
                  frame.entryHref = undefined;
                  frame.inEntry = false;
                }
              }
            }
          });
          return;
        }

        if (tag === "img") {
          const image = readerImageBlock(
            element.getAttribute("src"),
            element.getAttribute("alt") ?? "",
            baseUrl,
            element.getAttribute("width"),
            element.getAttribute("height"),
          );
          if (image) {
            if (frame?.text.trim()) flushFrame();
            blocks.push(image);
          }
          return;
        }

        if (tag === "br") {
          const active = ensureParagraph();
          active.html += "<br>";
          active.text += "\n";
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
          if (
            articleDepth > 0 &&
            !activeEntryHref &&
            (!frame || !frame.text.trim() || frame.kind.startsWith("heading-"))
          ) {
            const active = ensureParagraph();
            activeEntryHref = href;
            active.entryHref = href;
            const candidate = {
              href,
              frame: active,
              htmlStart: active.html.length,
              sawBoundary: false,
            };
            activeEntryCandidate = candidate;
            element.onEndTag(() => {
              if (!candidate.sawBoundary && frame === candidate.frame) {
                const before = frame.html.slice(0, candidate.htmlStart);
                const linked = frame.html.slice(candidate.htmlStart);
                frame.html = `${before}<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${linked}</a>`;
                frame.entryHref = undefined;
              }
              if (activeEntryHref === href) activeEntryHref = undefined;
              if (activeEntryCandidate === candidate) activeEntryCandidate = undefined;
            });
            return;
          }
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

  const topLevelArticleCount = blocks.filter((block) => block.kind === "separator").length;
  if (topLevelArticleCount <= 1) {
    return blocks
      .filter((block) => block.kind !== "separator")
      .map(({ entryHref: _entryHref, inEntry: _inEntry, ...block }) => block);
  }

  const formatted: ReaderBlock[] = [];
  let atEntryStart = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    if (block.kind === "separator") {
      formatted.push(block);
      atEntryStart = true;
      continue;
    }
    const monthDay = blocks[index]?.text.trim() ?? "";
    const year = blocks[index + 1]?.text.trim() ?? "";
    const category = blocks[index + 2]?.text.trim() ?? "";
    if (
      atEntryStart &&
      block.kind === "paragraph" &&
      /^\d{2}\.\d{2}$/u.test(monthDay) &&
      blocks[index + 1]?.kind === "paragraph" &&
      /^\d{4}$/u.test(year) &&
      blocks[index + 2]?.kind === "paragraph" &&
      category.length > 0 &&
      category.length <= 40 &&
      blocks[index + 3]?.kind.startsWith("heading-")
    ) {
      const text = `${monthDay} · ${year} · ${category}`;
      const metadataHtml = `${block.html.trim()} · ${(blocks[index + 1]?.html ?? "").trim()} · ${(blocks[index + 2]?.html ?? "").trim()}`;
      formatted.push({ kind: "entry-metadata", html: metadataHtml, text });
      index += 2;
      atEntryStart = false;
      continue;
    }
    atEntryStart = false;
    if (
      block.inEntry === true &&
      block.kind === "paragraph" &&
      /^(?:閱讀全文|阅读全文|read more)\s*→?$/iu.test(block.text.trim())
    ) {
      formatted.push({ ...block, kind: "entry-action" });
      continue;
    }
    formatted.push(block);
  }
  return formatted;
}

export function parseReaderText(text: string): ReaderBlock[] {
  return decodeHtmlEntities(text.slice(0, MAX_READER_SOURCE_CHARACTERS))
    .replaceAll("\r\n", "\n")
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({
      kind: "paragraph" as const,
      html: escapeHtml(paragraph).replaceAll("\n", "<br>"),
      text: paragraph,
    }));
}

interface InlineMarkdown {
  html: string;
  text: string;
}

function normalizeMarkdownParagraph(value: string): string {
  const lines = value.split("\n");
  return lines
    .map((line, index) => {
      if (index === lines.length - 1) return line;
      return line.endsWith("  ") ? `${line.slice(0, -2)}\n` : `${line.trimEnd()} `;
    })
    .join("");
}

function parseMarkdownInline(value: string, baseUrl?: string | null): InlineMarkdown {
  const normalized = normalizeMarkdownParagraph(value);
  const pattern =
    /(\[([^\]\n]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\n)/gu;
  let html = "";
  let text = "";
  let position = 0;
  let match = pattern.exec(normalized);
  while (match) {
    const plain = normalized.slice(position, match.index);
    html += escapeHtml(plain);
    text += plain;
    const token = match[0];
    if (token === "\n") {
      html += "<br>";
      text += "\n";
    } else if (match[2] !== undefined) {
      const label = match[2];
      const href = safeLink(match[3] ?? null, baseUrl);
      html += href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
        : escapeHtml(label);
      text += label;
    } else if (match[4] !== undefined) {
      html += `<code>${escapeHtml(match[4])}</code>`;
      text += match[4];
    } else {
      const strong = match[5] ?? match[6];
      const emphasis = match[7] ?? match[8];
      const visible = strong ?? emphasis ?? token;
      html +=
        strong !== undefined
          ? `<strong>${escapeHtml(visible)}</strong>`
          : `<em>${escapeHtml(visible)}</em>`;
      text += visible;
    }
    position = match.index + token.length;
    match = pattern.exec(normalized);
  }
  const tail = normalized.slice(position);
  return { html: html + escapeHtml(tail), text: text + tail };
}

export function parseReaderMarkdown(markdown: string, baseUrl?: string | null): ReaderBlock[] {
  const source = markdown
    .slice(0, MAX_READER_SOURCE_CHARACTERS)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const lines = source.split("\n");
  const blocks: ReaderBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;

  function flushParagraph(): void {
    if (paragraph.length === 0) return;
    const parsed = parseMarkdownInline(paragraph.join("\n"), baseUrl);
    if (parsed.text.trim()) blocks.push({ kind: "paragraph", ...parsed });
    paragraph = [];
  }

  for (const line of lines) {
    if (/^```/u.test(line)) {
      flushParagraph();
      if (code === null) code = [];
      else {
        const text = code.join("\n");
        blocks.push({ kind: "code", html: escapeHtml(text), text });
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const image = /^!\[([^\]\n]*)\]\(([^\s()]+)\)$/u.exec(line.trim());
    if (image) {
      flushParagraph();
      const block = readerImageBlock(image[2], image[1] ?? "", baseUrl);
      if (block) blocks.push(block);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading?.[1] && heading[2]) {
      flushParagraph();
      const parsed = parseMarkdownInline(heading[2], baseUrl);
      blocks.push({ kind: `heading-${heading[1].length}` as ReaderBlockKind, ...parsed });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/u.exec(line);
    if (quote) {
      flushParagraph();
      const parsed = parseMarkdownInline(quote[1] ?? "", baseUrl);
      if (parsed.text.trim()) blocks.push({ kind: "quote", ...parsed });
      continue;
    }
    const unordered = /^\s*[-+*]\s+(.+)$/u.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
    const item = unordered?.[1] ?? ordered?.[1];
    if (item) {
      flushParagraph();
      const parsed = parseMarkdownInline(item, baseUrl);
      blocks.push({ kind: "list-item", ordered: Boolean(ordered), ...parsed });
      continue;
    }
    paragraph.push(line);
  }
  if (code !== null) {
    const text = code.join("\n");
    if (text.trim()) blocks.push({ kind: "code", html: escapeHtml(text), text });
  }
  flushParagraph();
  return blocks;
}

export function parseReaderMessageText(text: string): ReaderBlock[] {
  return text
    .slice(0, MAX_READER_SOURCE_CHARACTERS)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split(/\n\s*\n/u)
    .flatMap((section): ReaderBlock[] => {
      const value = section.trim();
      if (!value) return [];
      const lines = value.split("\n");
      if (/^\s*>/u.test(lines[0] ?? "")) {
        const quote = lines.map((line) => line.replace(/^\s*>\s?/u, "")).join("\n");
        return [{ kind: "quote", html: escapeHtml(quote).replaceAll("\n", "<br>"), text: quote }];
      }
      return parseReaderText(value);
    });
}

export function readerBlocksText(blocks: ReaderBlock[]): string {
  const sections: string[] = [];
  let listItems: string[] = [];
  const flushList = () => {
    if (listItems.length > 0) sections.push(listItems.join("\n"));
    listItems = [];
  };
  for (const block of blocks) {
    const text = block.text.trim();
    if (!text) continue;
    if (block.kind === "list-item") {
      listItems.push(text);
      continue;
    }
    flushList();
    sections.push(text);
  }
  flushList();
  return sections.join("\n\n");
}

export function renderReaderBlocks(blocks: ReaderBlock[]): string {
  const output: string[] = [];
  const entryHtml = (block: ReaderBlock) =>
    block.entryHref
      ? `<a href="${escapeHtml(block.entryHref)}" target="_blank" rel="noopener noreferrer">${block.html}</a>`
      : block.html;
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
      output.push(`<h${level}>${entryHtml(block)}</h${level}>`);
    } else if (block.kind === "quote") {
      output.push(`<blockquote>${block.html}</blockquote>`);
    } else if (block.kind === "code") {
      output.push(`<pre><code>${block.html}</code></pre>`);
    } else if (block.kind === "separator") {
      output.push('<hr class="reader-entry-divider" aria-hidden="true">');
    } else if (block.kind === "entry-metadata") {
      output.push(`<p class="reader-entry-metadata">${block.html}</p>`);
    } else if (block.kind === "entry-action") {
      output.push(`<p class="reader-entry-action">${entryHtml(block)}</p>`);
    } else if (block.kind === "image" && block.src) {
      const dimensions = `${block.width ? ` width="${block.width}"` : ""}${block.height ? ` height="${block.height}"` : ""}`;
      const alt = block.alt?.trim() || "圖片無法載入";
      output.push(
        `<figure class="reader-image"><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt ?? "")}"${dimensions} loading="lazy" decoding="async" referrerpolicy="no-referrer"><figcaption class="reader-image-fallback" data-image-fallback hidden>${escapeHtml(alt)}</figcaption></figure>`,
      );
    } else {
      output.push(`<p>${block.html}</p>`);
    }
  }
  flushList();
  return output.join("");
}
