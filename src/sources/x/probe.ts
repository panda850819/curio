import type { ProbeResult, SubscriptionCandidate } from "../../probe/types.ts";

const X_PROFILE = /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(@?[A-Za-z0-9_]{1,15})\/?$/i;

export function xCandidate(url: string): SubscriptionCandidate | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  const match = X_PROFILE.exec(parsed.toString());
  if (!match?.[1]) return null;
  const handle = match[1].replace(/^@/, "");
  const sourceUrl = `https://x.com/${handle}`;
  return {
    adapter: "x",
    format: "x",
    sourceUrl,
    sourceKey: handle.toLowerCase(),
    title: `@${handle}`,
    discoveredVia: "direct",
  };
}

export function xProbeResult(inputUrl: string): ProbeResult | null {
  const candidate = xCandidate(inputUrl);
  if (!candidate) return null;
  return { inputUrl, finalUrl: candidate.sourceUrl, candidates: [candidate], warnings: [] };
}
