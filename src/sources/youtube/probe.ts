import { ProbeError } from "../../probe/errors.ts";
import { isHtmlContentType } from "../../probe/feed.ts";
import type {
  HttpResponse,
  ProbeHttpClient,
  ProbeResult,
  SubscriptionCandidate,
} from "../../probe/types.ts";

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{3,64}$/u;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const HTML_LIMIT = 1 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface YoutubeUrlInfo {
  kind: "channel" | "handle" | "video" | "feed";
  channelId?: string;
}

function channelCandidate(
  channelId: string,
  title: string | null,
  discoveredVia: "direct" | "html-link" = "direct",
): SubscriptionCandidate {
  return {
    adapter: "youtube",
    format: "youtube",
    sourceUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
    sourceKey: channelId,
    title: title || channelId,
    discoveredVia,
  };
}

function parseUrl(input: string): { url: URL; info: YoutubeUrlInfo } | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!/^https?:$/u.test(url.protocol) || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be") {
    const videoId = url.pathname.split("/").filter(Boolean)[0];
    return videoId ? { url, info: { kind: "video" } } : null;
  }
  const channel = /^\/channel\/(UC[A-Za-z0-9_-]{3,64})\/?$/u.exec(url.pathname);
  if (channel?.[1] && CHANNEL_ID.test(channel[1])) {
    return { url, info: { kind: "channel", channelId: channel[1] } };
  }
  const feed = /^\/feeds\/videos\.xml$/u.test(url.pathname);
  if (feed) {
    const channelId = url.searchParams.get("channel_id") ?? "";
    if (CHANNEL_ID.test(channelId)) return { url, info: { kind: "feed", channelId } };
  }
  if (/^\/@[A-Za-z0-9._-]{1,100}\/?$/u.test(url.pathname)) {
    return { url, info: { kind: "handle" } };
  }
  if (/^\/watch$/u.test(url.pathname) && url.searchParams.get("v")) {
    return { url, info: { kind: "video" } };
  }
  if (/^\/(?:shorts|live)\/[A-Za-z0-9_-]{3,100}\/?$/u.test(url.pathname)) {
    return { url, info: { kind: "video" } };
  }
  return null;
}

function extractChannelId(html: string): string | null {
  const patterns = [
    /<meta[^>]+itemprop=["']channelId["'][^>]+content=["'](UC[A-Za-z0-9_-]{3,64})["']/iu,
    /<meta[^>]+content=["'](UC[A-Za-z0-9_-]{3,64})["'][^>]+itemprop=["']channelId["']/iu,
    /["'](?:channelId|externalId)["']\s*:\s*["'](UC[A-Za-z0-9_-]{3,64})["']/u,
    /channel_id(?:=|%3D)(UC[A-Za-z0-9_-]{3,64})/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1] && CHANNEL_ID.test(match[1])) return match[1];
  }
  return null;
}

function extractTitle(html: string): string | null {
  const value = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1];
  if (!value) return null;
  const title = value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\s+-\s+YouTube$/iu, "");
  return title || null;
}

export function youtubeUrlInfo(input: string): YoutubeUrlInfo | null {
  return parseUrl(input)?.info ?? null;
}

export function youtubeChannelIdFromFeedUrl(input: string): string | null {
  const info = parseUrl(input)?.info;
  return info?.kind === "feed" ? (info.channelId ?? null) : null;
}

export async function youtubeProbeResult(
  inputUrl: string,
  client: ProbeHttpClient,
): Promise<ProbeResult | null> {
  const parsed = parseUrl(inputUrl);
  if (!parsed) return null;
  if (parsed.info.channelId) {
    const candidate = channelCandidate(parsed.info.channelId, null);
    return { inputUrl, finalUrl: candidate.sourceUrl, candidates: [candidate], warnings: [] };
  }

  let response: HttpResponse;
  try {
    response = await client.get(inputUrl, () => HTML_LIMIT);
  } catch (error) {
    throw new ProbeError("youtube_channel_unresolved", "Unable to resolve YouTube channel", error);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ProbeError(
      "youtube_channel_unresolved",
      `YouTube page returned HTTP ${response.status}`,
    );
  }
  if (!isHtmlContentType(response.headers.get("content-type"))) {
    throw new ProbeError("youtube_channel_unresolved", "YouTube page did not return HTML");
  }
  let html: string;
  try {
    html = decoder.decode(response.body);
  } catch (error) {
    throw new ProbeError("youtube_channel_unresolved", "YouTube page is not valid UTF-8", error);
  }
  const channelId = extractChannelId(html);
  if (!channelId) {
    throw new ProbeError("youtube_channel_unresolved", "YouTube channel ID was not found");
  }
  const candidate = channelCandidate(channelId, extractTitle(html));
  return { inputUrl, finalUrl: response.url, candidates: [candidate], warnings: [] };
}

export { channelCandidate, extractChannelId, extractTitle };
