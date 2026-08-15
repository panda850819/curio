import { isFeedContentType } from "./feed.ts";

export interface DiscoveredFeedLink {
  url: string;
  title: string | null;
}

export async function discoverFeedLinks(
  html: string,
  baseUrl: string,
): Promise<DiscoveredFeedLink[]> {
  const links: DiscoveredFeedLink[] = [];
  const rewriter = new HTMLRewriter().on("link", {
    element(element) {
      const rel = element.getAttribute("rel")?.toLowerCase().split(/\s+/) ?? [];
      const href = element.getAttribute("href")?.trim();
      const type = element.getAttribute("type");
      if (!rel.includes("alternate") || !href || !isFeedContentType(type)) return;

      try {
        const url = new URL(href, baseUrl);
        url.hash = "";
        links.push({
          url: url.toString(),
          title: element.getAttribute("title")?.trim() || null,
        });
      } catch {
        // Invalid candidate URLs are ignored here and cannot reach the network.
      }
    },
  });

  await rewriter.transform(new Response(html)).text();
  return links;
}
