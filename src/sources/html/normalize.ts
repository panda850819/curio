import type { NormalizedHtmlDocument } from "./types.ts";

const DROP_TAGS = new Set(["script", "style", "noscript", "template"]);
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "div",
  "dl",
  "dt",
  "dd",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

interface HtmlTextNode {
  kind: "text";
  value: string;
}

interface HtmlElementNode {
  kind: "element";
  tag: string;
  rawAttributes: Record<string, string>;
  children: HtmlNode[];
}

type HtmlNode = HtmlTextNode | HtmlElementNode;

export class HtmlSelectorError extends Error {
  constructor(selector: string) {
    super(`HTML selector did not match: ${selector}`);
    this.name = "HtmlSelectorError";
  }
}

export class HtmlContentTooLargeError extends Error {
  constructor() {
    super("Extracted HTML content exceeds the configured size limit");
    this.name = "HtmlContentTooLargeError";
  }
}

export class HtmlContentEmptyError extends Error {
  constructor() {
    super("Extracted HTML content is empty");
    this.name = "HtmlContentEmptyError";
  }
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  let match = pattern.exec(raw);
  while (match !== null) {
    const current = match;
    match = pattern.exec(raw);
    const name = current[1]?.toLowerCase();
    if (!name || name === "/" || name.startsWith("on") || name === "style") continue;
    attributes[name] = current[2] ?? current[3] ?? current[4] ?? "";
  }
  return attributes;
}

function appendChild(parent: HtmlElementNode, node: HtmlNode): void {
  parent.children.push(node);
}

function parseHtml(html: string): HtmlElementNode {
  const root: HtmlElementNode = { kind: "element", tag: "#root", rawAttributes: {}, children: [] };
  const stack: HtmlElementNode[] = [root];
  const tokens = /<!--[\s\S]*?-->|<![^>]*>|<\/?\s*[A-Za-z][^>]*>|[^<]+|</gu;
  let match = tokens.exec(html);
  while (match !== null) {
    const token = match[0] as string;
    match = tokens.exec(html);
    const parent = stack.at(-1) as HtmlElementNode;
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    if (token === "<") {
      appendChild(parent, { kind: "text", value: token });
      continue;
    }
    if (token.startsWith("</")) {
      const close = /^<\/\s*([A-Za-z][\w:-]*)/u.exec(token);
      const tag = close?.[1]?.toLowerCase();
      if (!tag) continue;
      const index = stack.findLastIndex((node) => node.tag === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    if (token.startsWith("<")) {
      const open = /^<\s*([A-Za-z][\w:-]*)([\s\S]*?)>$/u.exec(token);
      if (!open?.[1]) continue;
      const tag = open[1].toLowerCase();
      const node: HtmlElementNode = {
        kind: "element",
        tag,
        rawAttributes: parseAttributes(open[2] ?? ""),
        children: [],
      };
      appendChild(parent, node);
      if (!VOID_TAGS.has(tag) && !token.endsWith("/>") && !DROP_TAGS.has(tag)) stack.push(node);
      else if (DROP_TAGS.has(tag)) stack.push(node);
    } else {
      appendChild(parent, { kind: "text", value: token });
    }
  }
  return root;
}

function canonicalUrl(value: string, baseUrl: string): string {
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    const volatile = new Set(["fbclid", "gclid", "t", "timestamp", "_", "cacheBust"]);
    const params = [...url.searchParams.entries()]
      .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !volatile.has(key))
      .sort(([left], [right]) => left.localeCompare(right));
    url.search = "";
    for (const [key, parameter] of params) url.searchParams.append(key, parameter);
    return url.toString();
  } catch {
    return value.trim();
  }
}

function normalizedAttributeValue(name: string, value: string, baseUrl: string): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (name === "href" || name === "src" || name === "action" || name === "poster") {
    return canonicalUrl(collapsed, baseUrl);
  }
  return collapsed;
}

function canonicalAttributes(node: HtmlElementNode, baseUrl: string): string {
  const attributes = Object.entries(node.rawAttributes)
    .filter(([name]) => !name.startsWith("data-") && name !== "id" && name !== "class")
    .map(([name, value]) => [name, normalizedAttributeValue(name, value, baseUrl)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return attributes.map(([name, value]) => ` ${name}="${escapeCanonical(value)}"`).join("");
}

function escapeCanonical(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function isDropped(node: HtmlElementNode): boolean {
  return DROP_TAGS.has(node.tag);
}

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function serialize(node: HtmlNode, baseUrl: string): string {
  if (node.kind === "text") return normalizedText(node.value);
  if (isDropped(node)) return "";
  if (node.tag === "#root")
    return node.children
      .map((child) => serialize(child, baseUrl))
      .filter(Boolean)
      .join(" ");
  const children = node.children
    .map((child) => serialize(child, baseUrl))
    .filter(Boolean)
    .join(" ");
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${canonicalAttributes(node, baseUrl)}>`;
  return `<${node.tag}${canonicalAttributes(node, baseUrl)}>${children}</${node.tag}>`;
}

function textContent(node: HtmlNode): string {
  if (node.kind === "text") return node.value;
  if (isDropped(node)) return "";
  const separator = BLOCK_TAGS.has(node.tag) ? " " : "";
  return `${separator}${node.children.map(textContent).join("")}${separator}`;
}

function allElements(root: HtmlElementNode): HtmlElementNode[] {
  const result: HtmlElementNode[] = [];
  const visit = (node: HtmlNode) => {
    if (node.kind === "text") return;
    if (node.tag !== "#root") result.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return result;
}

function simpleSelectorMatches(node: HtmlElementNode, selector: string): boolean {
  if (!selector || node.tag === "#root") return false;
  const tag = /^([A-Za-z][\w-]*)/u.exec(selector)?.[1]?.toLowerCase();
  if (tag && node.tag !== tag) return false;
  const idMatches = [...selector.matchAll(/#([\w-]+)/gu)].map((match) => match[1]);
  if (idMatches.length > 0 && idMatches.some((id) => node.rawAttributes.id !== id)) return false;
  const classNames = (node.rawAttributes.class ?? "").split(/\s+/u).filter(Boolean);
  const classMatches = [...selector.matchAll(/\.([\w-]+)/gu)].map((match) => match[1]);
  if (classMatches.some((name) => !classNames.includes(name as string))) return false;
  const attributeMatches = [
    ...selector.matchAll(/\[([\w:-]+)(?:\s*=\s*["']?([^\]"']+)["']?)?\]/gu),
  ];
  for (const match of attributeMatches) {
    const name = match[1]?.toLowerCase();
    const expected = match[2];
    if (!name || node.rawAttributes[name] === undefined) return false;
    if (expected !== undefined && node.rawAttributes[name] !== expected) return false;
  }
  return Boolean(tag || idMatches.length || classMatches.length || attributeMatches.length);
}

function selectorParts(selector: string): Array<{ selector: string; combinator: " " | ">" }> {
  const tokens = selector.replace(/>/gu, " > ").trim().split(/\s+/u).filter(Boolean);
  const parts: Array<{ selector: string; combinator: " " | ">" }> = [];
  let combinator: " " | ">" = " ";
  for (const token of tokens) {
    if (token === ">") {
      combinator = ">";
      continue;
    }
    parts.push({ selector: token, combinator });
    combinator = " ";
  }
  return parts;
}

function parentMap(root: HtmlElementNode): Map<HtmlElementNode, HtmlElementNode | null> {
  const parents = new Map<HtmlElementNode, HtmlElementNode | null>();
  const visit = (node: HtmlElementNode, parent: HtmlElementNode | null) => {
    parents.set(node, parent);
    for (const child of node.children) if (child.kind === "element") visit(child, node);
  };
  visit(root, null);
  return parents;
}

function matchesSelector(
  node: HtmlElementNode,
  selector: string,
  parents: Map<HtmlElementNode, HtmlElementNode | null>,
): boolean {
  const parts = selectorParts(selector);
  if (parts.length === 0) return false;
  const matchAt = (current: HtmlElementNode | null, index: number): boolean => {
    if (!current || !simpleSelectorMatches(current, parts[index]?.selector ?? "")) return false;
    if (index === 0) return true;
    const relation = parts[index]?.combinator ?? " ";
    if (relation === ">") return matchAt(parents.get(current) ?? null, index - 1);
    let ancestor = parents.get(current) ?? null;
    while (ancestor) {
      if (matchAt(ancestor, index - 1)) return true;
      ancestor = parents.get(ancestor) ?? null;
    }
    return false;
  };
  return matchAt(node, parts.length - 1);
}

function selectedNodes(root: HtmlElementNode, selector?: string): HtmlElementNode[] {
  if (!selector?.trim()) {
    const body = allElements(root).find((node) => node.tag === "body");
    return body ? [body] : [root];
  }
  const parents = parentMap(root);
  const selectors = selector
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const matches = allElements(root).filter((node) =>
    selectors.some((value) => matchesSelector(node, value, parents)),
  );
  if (matches.length === 0) throw new HtmlSelectorError(selector);
  return matches;
}

function pageTitle(root: HtmlElementNode): string | null {
  const title = allElements(root).find((node) => node.tag === "title");
  if (!title) return null;
  const value = normalizedText(textContent(title));
  return value || null;
}

export function extractPageTitle(html: string): string | null {
  return pageTitle(parseHtml(html));
}

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.username = "";
  url.password = "";
  const volatile = new Set(["fbclid", "gclid", "t", "timestamp", "_", "cacheBust"]);
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !volatile.has(key))
    .sort(([left], [right]) => left.localeCompare(right));
  url.search = "";
  for (const [key, parameter] of params) url.searchParams.append(key, parameter);
  return url.toString();
}

export function normalizeHtmlDocument(
  html: string,
  baseUrl: string,
  selector?: string,
  maximumBytes = 256 * 1024,
): NormalizedHtmlDocument {
  const root = parseHtml(html);
  const selected = selectedNodes(root, selector);
  const titleNode = allElements(root).find((node) => node.tag === "title");
  const titleCanonical = !selector && titleNode ? serialize(titleNode, baseUrl) : "";
  const canonical = [titleCanonical, ...selected.map((node) => serialize(node, baseUrl))]
    .filter(Boolean)
    .join("\n");
  const text = normalizedText(
    [titleNode && !selector ? textContent(titleNode) : "", ...selected.map(textContent)].join(" "),
  );
  if (!canonical || !text) throw new HtmlContentEmptyError();
  if (
    new TextEncoder().encode(canonical).byteLength > maximumBytes ||
    new TextEncoder().encode(text).byteLength > maximumBytes
  ) {
    throw new HtmlContentTooLargeError();
  }
  return { canonical, text, title: pageTitle(root) };
}
