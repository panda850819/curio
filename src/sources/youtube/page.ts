import type { CanonicalItem } from "../../domain/types.ts";
import type { NormalizedFeedEntry } from "../rss/types.ts";

const VIDEO_ID = /^[A-Za-z0-9_-]{3,100}$/u;
const INITIAL_DATA_MARKER = /\bvar\s+ytInitialData\s*=\s*/u;

type JsonObject = Record<string, unknown>;

export interface YoutubePage {
  entries: NormalizedFeedEntry[];
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textValue(value: unknown): string | null {
  const direct = stringValue(value);
  if (direct) return direct;
  const object = asObject(value);
  if (!object) return null;

  for (const key of ["content", "simpleText"] as const) {
    const text = stringValue(object[key]);
    if (text) return text;
  }

  const runs = Array.isArray(object.runs) ? object.runs : [];
  const combined = runs
    .map((run) => stringValue(asObject(run)?.text))
    .filter((text): text is string => text !== null)
    .join("")
    .trim();
  return combined || null;
}

function titleForNode(object: JsonObject): string | null {
  const metadata = asObject(object.metadata);
  const lockupMetadata = asObject(metadata?.lockupMetadataViewModel);
  return textValue(lockupMetadata?.title) ?? textValue(object.title);
}

function itemForNode(object: JsonObject, channelId: string, author: string): CanonicalItem | null {
  const videoId = stringValue(object.contentId) ?? stringValue(object.videoId);
  const title = titleForNode(object);
  if (!videoId || !VIDEO_ID.test(videoId) || !title) return null;

  return {
    externalId: videoId,
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    title,
    summary: null,
    contentText: null,
    author,
    publishedAt: null,
    metadata: {
      source: "youtube",
      channelId,
      videoId,
    },
  };
}

function initialData(html: string): unknown {
  const marker = INITIAL_DATA_MARKER.exec(html);
  if (!marker) throw new Error("YouTube channel page did not contain initial data");
  const start = marker.index + marker[0].length;
  const end = html.indexOf("</script>", start);
  if (end === -1) throw new Error("YouTube channel page initial data was incomplete");
  const source = html.slice(start, end).trim().replace(/;$/u, "");
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("YouTube channel page initial data was invalid", { cause: error });
  }
}

function collectEntries(
  value: unknown,
  channelId: string,
  author: string,
  entries: NormalizedFeedEntry[],
  seen: Set<string>,
): void {
  if (entries.length >= 500) return;
  if (Array.isArray(value)) {
    for (const child of value) collectEntries(child, channelId, author, entries, seen);
    return;
  }

  const object = asObject(value);
  if (!object) return;
  const item = itemForNode(object, channelId, author);
  if (item && !seen.has(item.externalId)) {
    seen.add(item.externalId);
    entries.push({ item, sourceIndex: entries.length });
  }
  for (const child of Object.values(object)) {
    collectEntries(child, channelId, author, entries, seen);
  }
}

export function normalizeYoutubeChannelPage(
  html: string,
  channelId: string,
  author: string,
): YoutubePage {
  const entries: NormalizedFeedEntry[] = [];
  collectEntries(initialData(html), channelId, author, entries, new Set());
  if (entries.length === 0) {
    throw new Error("YouTube channel page contained no video entries");
  }
  return { entries };
}
