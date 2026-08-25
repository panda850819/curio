import type { Item, JsonValue } from "../domain/types.ts";
import {
  parseReaderHtml,
  parseReaderMarkdown,
  parseReaderMessageText,
  parseReaderText,
  type ReaderBlock,
  readerBlocksText,
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
  return /^(?: {0,3}#{1,3}\s| {0,3}(?:[-+*]|\d+\.)\s| {0,3}>\s?|```)/mu.test(value);
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
  if (profile === "github" || (profile === "feed" && looksLikeMarkdown(value))) {
    return parseReaderMarkdown(value, baseUrl);
  }
  if (profile === "email") return parseReaderMessageText(value);
  return parseReaderText(value);
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
  let blocks = input.contentHtml ? parseReaderHtml(input.contentHtml, input.item.url) : [];
  if (blocks.length === 0 && input.contentText?.trim()) {
    blocks = textBlocks(profile, input.contentText, input.item.url);
  }
  if (blocks.length === 0 && input.item.summary?.trim()) {
    blocks = textBlocks(profile, input.item.summary, input.item.url);
  }
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
