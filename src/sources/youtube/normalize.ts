import type { JsonValue } from "../../domain/types.ts";
import { normalizeFeed } from "../rss/normalize.ts";
import type { NormalizedFeed } from "../rss/types.ts";

function videoIdFromItem(item: NormalizedFeed["entries"][number]["item"]): string | null {
  const metadata = item.metadata;
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const sourceIdentifier = metadata.sourceIdentifier;
    if (typeof sourceIdentifier === "string") {
      const match = /^yt:video:([A-Za-z0-9_-]{3,100})$/u.exec(sourceIdentifier);
      if (match?.[1]) return match[1];
    }
  }
  if (item.url) {
    try {
      const url = new URL(item.url);
      const id = url.searchParams.get("v");
      if (id && /^[A-Za-z0-9_-]{3,100}$/u.test(id)) return id;
    } catch {
      // The generic feed normalizer already handled invalid links.
    }
  }
  return null;
}

export function normalizeYoutubeFeed(
  xml: string,
  sourceUrl: string,
  channelId?: string,
): NormalizedFeed {
  const normalized = normalizeFeed(xml, sourceUrl);
  if (normalized.format !== "atom") throw new Error("YouTube channel feed must be Atom");
  return {
    ...normalized,
    entries: normalized.entries.flatMap((entry) => {
      const videoId = videoIdFromItem(entry.item);
      if (!videoId) return [];
      const metadata =
        entry.item.metadata !== null &&
        typeof entry.item.metadata === "object" &&
        !Array.isArray(entry.item.metadata)
          ? entry.item.metadata
          : {};
      return [
        {
          ...entry,
          item: {
            ...entry.item,
            externalId: videoId,
            metadata: {
              ...(metadata as Record<string, JsonValue>),
              source: "youtube",
              ...(channelId ? { channelId } : {}),
              videoId,
            },
          },
        },
      ];
    }),
  };
}
