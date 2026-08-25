import { parseFeed } from "feedsmith";
import type { CanonicalItem, JsonValue } from "../../domain/types.ts";
import { detectFeedFormat } from "../../probe/feed.ts";
import { deriveExternalId } from "../external-id.ts";
import type { NormalizedFeed, RssPollWarning } from "./types.ts";

type ParsedFeed = ReturnType<typeof parseFeed>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function feedTitle(value: unknown): string | null {
  const title = text(value);
  return title ? title.slice(0, 240) : null;
}

function person(value: unknown): string | null {
  if (typeof value === "string") return text(value);
  if (value && typeof value === "object" && "name" in value) return text(value.name);
  return null;
}

function looksLikeHtml(value: string | null): boolean {
  return value !== null && /<\/?[a-z][\s\S]*>/i.test(value);
}

function canonicalUrl(value: unknown, sourceUrl: string): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate, sourceUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function timestamp(
  value: unknown,
  field: string,
  entryIndex: number,
  warnings: RssPollWarning[],
): number | null {
  const candidate = text(value);
  if (!candidate) return null;
  const parsed = Date.parse(candidate);
  if (!Number.isSafeInteger(parsed)) {
    warnings.push({
      code: "invalid_date",
      entryIndex,
      message: `Entry ${entryIndex} has an invalid ${field}`,
    });
    return null;
  }
  return parsed;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function feedImageMedia(entry: unknown, sourceUrl: string): JsonValue[] {
  const source = recordValue(entry);
  if (!source) return [];
  const media = recordValue(source.media);
  const candidates: Array<{ value: unknown; thumbnail: boolean }> = [
    ...(Array.isArray(media?.thumbnails)
      ? media.thumbnails.map((value) => ({ value, thumbnail: true }))
      : []),
    ...(Array.isArray(media?.contents)
      ? media.contents.map((value) => ({ value, thumbnail: false }))
      : []),
    ...(Array.isArray(media?.groups)
      ? media.groups.flatMap((group) => {
          const current = recordValue(group);
          return [
            ...(Array.isArray(current?.thumbnails)
              ? current.thumbnails.map((value) => ({ value, thumbnail: true }))
              : []),
            ...(Array.isArray(current?.contents)
              ? current.contents.map((value) => ({ value, thumbnail: false }))
              : []),
          ];
        })
      : []),
    ...(Array.isArray(source.enclosures)
      ? source.enclosures.map((value) => ({ value, thumbnail: false }))
      : []),
  ];
  const seen = new Set<string>();
  return candidates
    .flatMap((candidate): JsonValue[] => {
      const current = recordValue(candidate.value);
      if (!current) return [];
      const type = typeof current.type === "string" ? current.type.toLowerCase() : "";
      const medium = typeof current.medium === "string" ? current.medium.toLowerCase() : "";
      const rawUrl = typeof current.url === "string" ? current.url : null;
      const url = canonicalUrl(rawUrl, sourceUrl);
      if (
        !url ||
        seen.has(url) ||
        (!candidate.thumbnail && !type.startsWith("image/") && medium !== "image")
      ) {
        return [];
      }
      seen.add(url);
      const description = recordValue(current.description);
      return [
        {
          type: "image",
          url,
          alt: typeof description?.value === "string" ? description.value.slice(0, 500) : null,
          width: typeof current.width === "number" ? current.width : null,
          height: typeof current.height === "number" ? current.height : null,
        },
      ];
    })
    .slice(0, 8);
}

function metadata(
  format: "rss" | "atom" | "rdf",
  sourceIdentifier: string | null,
  categories: string[],
  media: JsonValue[],
): JsonValue {
  return {
    feedFormat: format,
    sourceIdentifier,
    categories,
    ...(media.length > 0 ? { media } : {}),
  };
}

function normalizeRss(
  parsed: Extract<ParsedFeed, { format: "rss" }>,
  sourceUrl: string,
): NormalizedFeed {
  const warnings: RssPollWarning[] = [];
  const entries = (parsed.feed.items ?? []).flatMap((entry, sourceIndex) => {
    if (!entry) return [];
    const title = text(entry.title);
    const url = canonicalUrl(entry.link, sourceUrl);
    if (entry.link && !url) {
      warnings.push({
        code: "invalid_url",
        entryIndex: sourceIndex,
        message: `Entry ${sourceIndex} has an invalid link`,
      });
    }
    const summary = text(entry.description);
    const encoded = text(entry.content?.encoded);
    const publishedAt = timestamp(
      entry.pubDate ?? entry.dc?.dates?.[0] ?? entry.dcterms?.dates?.[0],
      "published date",
      sourceIndex,
      warnings,
    );
    const sourceIdentifier = text(entry.guid?.value);
    const author = person(entry.authors?.[0]) ?? text(entry.dc?.creators?.[0]);
    const categories = (entry.categories ?? []).flatMap((category) =>
      category?.name ? [category.name] : [],
    );

    try {
      const externalId = deriveExternalId({
        externalId: sourceIdentifier,
        canonicalUrl: url,
        title,
        author,
        publishedAt,
        contentText: !encoded && !looksLikeHtml(summary) ? summary : null,
        contentHtml: encoded ?? (looksLikeHtml(summary) ? summary : null),
      });
      const item: CanonicalItem = {
        externalId,
        url,
        title,
        summary,
        contentText: !encoded && !looksLikeHtml(summary) ? summary : null,
        contentHtml: encoded ?? (looksLikeHtml(summary) ? summary : null),
        author,
        publishedAt,
        sourceUpdatedAt: null,
        metadata: metadata("rss", sourceIdentifier, categories, feedImageMedia(entry, sourceUrl)),
      };
      return [{ item, sourceIndex }];
    } catch (error) {
      warnings.push({
        code: "entry_skipped",
        entryIndex: sourceIndex,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });
  return { format: "rss", title: feedTitle(parsed.feed.title), entries, warnings };
}

function normalizeAtom(
  parsed: Extract<ParsedFeed, { format: "atom" }>,
  sourceUrl: string,
): NormalizedFeed {
  const warnings: RssPollWarning[] = [];
  const entries = (parsed.feed.entries ?? []).flatMap((entry, sourceIndex) => {
    if (!entry) return [];
    const title = text(entry.title);
    const link = entry.links?.find((candidate) => {
      const rel = candidate?.rel?.toLowerCase();
      return candidate?.href && (!rel || rel === "alternate");
    })?.href;
    const url = canonicalUrl(link, sourceUrl);
    if (link && !url) {
      warnings.push({
        code: "invalid_url",
        entryIndex: sourceIndex,
        message: `Entry ${sourceIndex} has an invalid alternate link`,
      });
    }
    const summary = text(entry.summary);
    const content = text(entry.content);
    const publishedAt = timestamp(
      entry.published ?? entry.updated,
      "published date",
      sourceIndex,
      warnings,
    );
    const sourceUpdatedAt = timestamp(entry.updated, "updated date", sourceIndex, warnings);
    const sourceIdentifier = text(entry.id);
    const author = person(entry.authors?.[0]);
    const categories = (entry.categories ?? []).flatMap((category) =>
      category?.term ? [category.term] : [],
    );

    try {
      const externalId = deriveExternalId({
        externalId: sourceIdentifier,
        canonicalUrl: url,
        title,
        author,
        publishedAt,
        contentText: !looksLikeHtml(content) ? content : null,
        contentHtml: looksLikeHtml(content) ? content : null,
      });
      const item: CanonicalItem = {
        externalId,
        url,
        title,
        summary,
        contentText: !looksLikeHtml(content) ? content : null,
        contentHtml: looksLikeHtml(content) ? content : null,
        author,
        publishedAt,
        sourceUpdatedAt,
        metadata: metadata("atom", sourceIdentifier, categories, feedImageMedia(entry, sourceUrl)),
      };
      return [{ item, sourceIndex }];
    } catch (error) {
      warnings.push({
        code: "entry_skipped",
        entryIndex: sourceIndex,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });
  return { format: "atom", title: feedTitle(parsed.feed.title), entries, warnings };
}

function normalizeRdf(
  parsed: Extract<ParsedFeed, { format: "rdf" }>,
  sourceUrl: string,
): NormalizedFeed {
  const warnings: RssPollWarning[] = [];
  const entries = (parsed.feed.items ?? []).flatMap((entry, sourceIndex) => {
    if (!entry) return [];
    const title = text(entry.title);
    const url = canonicalUrl(entry.link, sourceUrl);
    if (entry.link && !url) {
      warnings.push({
        code: "invalid_url",
        entryIndex: sourceIndex,
        message: `Entry ${sourceIndex} has an invalid link`,
      });
    }
    const summary = text(entry.description);
    const encoded = text(entry.content?.encoded);
    const publishedAt = timestamp(
      entry.dc?.dates?.[0] ?? entry.dcterms?.dates?.[0],
      "published date",
      sourceIndex,
      warnings,
    );
    const sourceIdentifier = text(entry.rdf?.about) ?? text(entry.dc?.identifiers?.[0]);
    const author = text(entry.dc?.creators?.[0]);
    const categories =
      entry.dc?.subjects?.flatMap((category) => (category ? [category] : [])) ?? [];

    try {
      const externalId = deriveExternalId({
        externalId: sourceIdentifier,
        canonicalUrl: url,
        title,
        author,
        publishedAt,
        contentText: !encoded && !looksLikeHtml(summary) ? summary : null,
        contentHtml: encoded ?? (looksLikeHtml(summary) ? summary : null),
      });
      const item: CanonicalItem = {
        externalId,
        url,
        title,
        summary,
        contentText: !encoded && !looksLikeHtml(summary) ? summary : null,
        contentHtml: encoded ?? (looksLikeHtml(summary) ? summary : null),
        author,
        publishedAt,
        sourceUpdatedAt: null,
        metadata: metadata("rdf", sourceIdentifier, categories, feedImageMedia(entry, sourceUrl)),
      };
      return [{ item, sourceIndex }];
    } catch (error) {
      warnings.push({
        code: "entry_skipped",
        entryIndex: sourceIndex,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });
  return { format: "rdf", title: feedTitle(parsed.feed.title), entries, warnings };
}

export function normalizeFeed(xml: string, sourceUrl: string): NormalizedFeed {
  const verifiedFormat = detectFeedFormat(xml);
  const parsed = parseFeed(xml);
  if (parsed.format !== verifiedFormat) {
    throw new Error(`Feed parser format mismatch: ${verifiedFormat} != ${parsed.format}`);
  }
  if (parsed.format === "rss") return normalizeRss(parsed, sourceUrl);
  if (parsed.format === "atom") return normalizeAtom(parsed, sourceUrl);
  if (parsed.format === "rdf") return normalizeRdf(parsed, sourceUrl);
  throw new Error("Unsupported feed format");
}
