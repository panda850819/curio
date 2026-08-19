import { ProbeError } from "../../probe/errors.ts";
import type { ProbeHttpClient, ProbeResult } from "../../probe/types.ts";
import { parseGithubRepository } from "./url.ts";

const GITHUB_JSON_LIMIT = 5 * 1024 * 1024;

export const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
} as const;

export function githubApiHeaders(token?: string): Readonly<Record<string, string>> {
  return token ? { ...GITHUB_API_HEADERS, Authorization: `Bearer ${token}` } : GITHUB_API_HEADERS;
}

function isJsonContentType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType === "application/vnd.github+json";
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    throw new ProbeError("invalid_feed", "GitHub releases response is not valid JSON", error);
  }
}

export async function githubProbeResult(
  inputUrl: string,
  client: ProbeHttpClient,
  token?: string,
): Promise<ProbeResult | null> {
  const reference = parseGithubRepository(inputUrl);
  if (!reference) return null;

  const response = await client.get(
    reference.apiUrl,
    () => GITHUB_JSON_LIMIT,
    githubApiHeaders(token),
  );
  if (response.status < 200 || response.status >= 300) {
    throw new ProbeError(
      "http_status",
      `HTTP ${response.status} while probing GitHub releases for ${reference.sourceKey}`,
    );
  }
  if (!isJsonContentType(response.headers.get("content-type"))) {
    throw new ProbeError(
      "invalid_feed",
      "GitHub releases response has an unsupported Content-Type",
    );
  }
  const payload = parseJson(response.body);
  if (!Array.isArray(payload)) {
    throw new ProbeError("invalid_feed", "GitHub releases response must be an array");
  }

  return {
    inputUrl,
    finalUrl: reference.sourceUrl,
    candidates: [
      {
        adapter: "github",
        format: "github",
        sourceUrl: reference.sourceUrl,
        sourceKey: reference.sourceKey,
        title: `GitHub releases: ${reference.sourceKey}`,
        discoveredVia: "direct",
      },
    ],
    warnings: [],
  };
}
