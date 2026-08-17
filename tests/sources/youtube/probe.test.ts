import { describe, expect, test } from "bun:test";
import type { ProbeHttpClient } from "../../../src/probe/types.ts";
import { youtubeProbeResult, youtubeUrlInfo } from "../../../src/sources/youtube/probe.ts";

const channelId = "UC1234567890abcdefghi";
const page = "https://www.youtube.com/@curio";

function client(body: string): ProbeHttpClient {
  return {
    get: async (url) => ({
      url,
      status: 200,
      headers: {
        get: (name: string) => (name === "content-type" ? "text/html; charset=utf-8" : null),
      },
      body: new TextEncoder().encode(body),
    }),
  };
}

describe("youtube probe", () => {
  test("normalizes known channel and direct Atom feed URLs to a stable channel key", async () => {
    const channel = await youtubeProbeResult(
      `https://www.youtube.com/channel/${channelId}`,
      client(""),
    );
    expect(channel?.candidates[0]).toMatchObject({
      adapter: "youtube",
      format: "youtube",
      sourceKey: channelId,
      sourceUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    });
    const feed = await youtubeProbeResult(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
      client(""),
    );
    expect(feed?.candidates[0]?.sourceKey).toBe(channelId);
    expect(youtubeUrlInfo(`https://youtube.com/channel/${channelId}`)?.kind).toBe("channel");
    expect(youtubeUrlInfo("https://example.com/article")).toBeNull();
  });

  test("resolves handle and video pages through the restricted HTTP client", async () => {
    const html = `<html><head><title>Curio Channel - YouTube</title><meta itemprop="channelId" content="${channelId}"></head></html>`;
    const handle = await youtubeProbeResult(page, client(html));
    expect(handle?.candidates[0]).toMatchObject({
      sourceKey: channelId,
      title: "Curio Channel",
    });
    const video = await youtubeProbeResult(
      "https://www.youtube.com/watch?v=video-123",
      client(`{"externalId":"${channelId}"}`),
    );
    expect(video?.candidates[0]?.sourceKey).toBe(channelId);
  });

  test("rejects a recognized page when no channel ID can be resolved", async () => {
    await expect(youtubeProbeResult(page, client("<html>no channel</html>"))).rejects.toMatchObject(
      {
        code: "youtube_channel_unresolved",
      },
    );
  });
});
