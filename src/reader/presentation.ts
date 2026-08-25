import type { Item, JsonValue } from "../domain/types.ts";
import {
  parseReaderHtml,
  parseReaderMarkdown,
  parseReaderMessageText,
  parseReaderText,
  type ReaderBlock,
  readerBlocksText,
  readerImageBlock,
} from "./content.ts";

export type ReaderSourceProfile =
  | "feed"
  | "html"
  | "github"
  | "social"
  | "youtube"
  | "email"
  | "generic";

export interface ReaderContentPresentation {
  profile: ReaderSourceProfile;
  displayTitle: string | null;
  blocks: ReaderBlock[];
  readableText: string;
  language: "en" | "zh" | "ja" | "ko" | null;
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function readerSourceProfile(item: Item): ReaderSourceProfile {
  const metadata = objectValue(item.metadata);
  if (!metadata) return "generic";
  if (objectValue(metadata.github)) return "github";
  if (objectValue(metadata.telegram) || metadata.platform === "x") return "social";
  if (metadata.source === "youtube" || typeof metadata.videoId === "string") return "youtube";
  if (objectValue(metadata.email)) return "email";
  if (typeof metadata.contentHash === "string") return "html";
  if (
    metadata.feedFormat === "rss" ||
    metadata.feedFormat === "atom" ||
    metadata.feedFormat === "rdf"
  ) {
    return "feed";
  }
  return "generic";
}

function looksLikeMarkdown(value: string): boolean {
  if (/^```/mu.test(value)) return true;
  const markers = value
    .split(/\r?\n/u)
    .map((line) => {
      if (/^ {0,3}#{1,3}\s/u.test(line)) return "heading";
      if (/^ {0,3}(?:[-+*]|\d+[.)])\s/u.test(line)) return "list";
      if (/^ {0,3}>\s?/u.test(line)) return "quote";
      return null;
    })
    .filter((marker) => marker !== null);
  return markers.length >= 2;
}

function normalizedMetadataText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  return normalized || null;
}

function removeDuplicatedLead(
  blocks: ReaderBlock[],
  item: Item,
  profile: ReaderSourceProfile,
): ReaderBlock[] {
  if (profile === "social" || profile === "youtube" || profile === "email") return blocks;
  const metadata = new Set(
    [normalizedMetadataText(item.title), normalizedMetadataText(item.author)].filter(
      (value): value is string => value !== null,
    ),
  );
  let start = 0;
  while (start < Math.min(blocks.length, 2)) {
    const block = blocks[start];
    if (!block || (block.kind !== "paragraph" && !block.kind.startsWith("heading-"))) break;
    if (!metadata.has(normalizedMetadataText(block.text) ?? "")) break;
    start += 1;
  }
  return blocks.slice(start);
}

function textBlocks(
  profile: ReaderSourceProfile,
  value: string,
  baseUrl?: string | null,
): ReaderBlock[] {
  if (
    profile === "github" ||
    (profile !== "social" && profile !== "email" && looksLikeMarkdown(value))
  ) {
    return parseReaderMarkdown(value, baseUrl);
  }
  if (profile === "email") return parseReaderMessageText(value);
  return parseReaderText(value);
}

function metadataImageBlocks(item: Item, existing: ReaderBlock[]): ReaderBlock[] {
  const metadata = objectValue(item.metadata);
  if (!Array.isArray(metadata?.media)) return [];
  const seen = new Set(existing.flatMap((block) => (block.src ? [block.src] : [])));
  return metadata.media.flatMap((value): ReaderBlock[] => {
    const media = objectValue(value);
    if (!media) return [];
    const type = typeof media.type === "string" ? media.type : null;
    const source =
      (type === "photo" || type === "image") && typeof media.url === "string"
        ? media.url
        : typeof media.previewUrl === "string"
          ? media.previewUrl
          : null;
    const alt =
      typeof media.alt === "string"
        ? media.alt
        : item.author
          ? `${item.author} 的媒體`
          : "文章圖片";
    const block = readerImageBlock(
      source,
      alt,
      item.url,
      typeof media.width === "number" ? media.width : null,
      typeof media.height === "number" ? media.height : null,
    );
    if (!block?.src || seen.has(block.src)) return [];
    seen.add(block.src);
    return [block];
  });
}

function isXHtmlChrome(item: Item, profile: ReaderSourceProfile): boolean {
  if (profile !== "html" || !item.url) return false;
  try {
    const host = new URL(item.url).hostname.toLowerCase();
    return (
      host === "x.com" ||
      host === "www.x.com" ||
      host === "twitter.com" ||
      host === "www.twitter.com"
    );
  } catch {
    return false;
  }
}

function displayTitle(item: Item, profile: ReaderSourceProfile): string | null {
  const title = item.title?.trim() || null;
  if (!title || profile !== "social") return title;
  const metadata = objectValue(item.metadata);
  if (objectValue(metadata?.telegram)) return null;
  const firstLine = item.contentText?.split(/\r?\n/u, 1)[0]?.trim() || null;
  return firstLine === title ? null : title;
}

function contentLanguage(value: string): ReaderContentPresentation["language"] {
  if (!value.trim()) return null;
  if (/[\u3040-\u30ff]/u.test(value)) return "ja";
  if (/[\uac00-\ud7af]/u.test(value)) return "ko";
  if (/\p{Script=Han}/u.test(value)) return "zh";
  return /[A-Za-z]/u.test(value) ? "en" : null;
}

export function presentReaderContent(input: {
  item: Item;
  contentHtml: string | null;
  contentText: string | null;
}): ReaderContentPresentation {
  const profile = readerSourceProfile(input.item);
  const blockedTransportChrome = isXHtmlChrome(input.item, profile);
  let blocks =
    !blockedTransportChrome && input.contentHtml
      ? parseReaderHtml(input.contentHtml, input.item.url)
      : [];
  if (!blockedTransportChrome && blocks.length === 0 && input.contentText?.trim()) {
    blocks = textBlocks(profile, input.contentText, input.item.url);
  }
  if (!blockedTransportChrome && blocks.length === 0 && input.item.summary?.trim()) {
    blocks = textBlocks(profile, input.item.summary, input.item.url);
  }
  blocks.push(...metadataImageBlocks(input.item, blocks));
  blocks = removeDuplicatedLead(blocks, input.item, profile);
  const readableText = readerBlocksText(blocks);
  return {
    profile,
    displayTitle: displayTitle(input.item, profile),
    blocks,
    readableText,
    language: contentLanguage(`${input.item.title ?? ""}\n${readableText}`),
  };
}
