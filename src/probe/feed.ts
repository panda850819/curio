import { SaxesParser } from "saxes";
import { ProbeError } from "./errors.ts";
import type { FeedFormat } from "./types.ts";

const RDF_NAMESPACE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

const FEED_CONTENT_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/rdf+xml",
  "application/xml",
  "text/xml",
]);

export function normalizedContentType(value: string | null): string | null {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

export function isFeedContentType(value: string | null): boolean {
  const contentType = normalizedContentType(value);
  return contentType !== null && FEED_CONTENT_TYPES.has(contentType);
}

export function isHtmlContentType(value: string | null): boolean {
  const contentType = normalizedContentType(value);
  return contentType === "text/html" || contentType === "application/xhtml+xml";
}

export function detectFeedFormat(xml: string): FeedFormat {
  let format: FeedFormat | null = null;
  let rootSeen = false;
  const parser = new SaxesParser({ xmlns: true });

  parser.on("opentag", (tag) => {
    if (rootSeen) return;
    rootSeen = true;
    const local = tag.local.toLowerCase();
    if (local === "rss") format = "rss";
    else if (local === "feed") format = "atom";
    else if (local === "rdf" && tag.uri === RDF_NAMESPACE) format = "rdf";
    else throw new ProbeError("invalid_feed", `Unsupported XML root: ${tag.name}`);
  });

  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError("invalid_feed", "Response is not well-formed feed XML", error);
  }

  if (!format) throw new ProbeError("invalid_feed", "Response contains no feed XML root");
  return format;
}
