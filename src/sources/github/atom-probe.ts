import { ProbeError } from "../../probe/errors.ts";
import type { ProbeHttpClient, ProbeResult } from "../../probe/types.ts";
import { normalizeGithubAtomFeed } from "./atom-normalize.ts";
import { parseGithubAtomInput } from "./atom-url.ts";

const GITHUB_ATOM_LIMIT = 5 * 1024 * 1024;

export const GITHUB_ATOM_HEADERS = {
  Accept: "application/atom+xml",
} as const;

function isAtomContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/atom+xml";
}

export async function githubAtomProbeResult(
  inputUrl: string,
  client: ProbeHttpClient,
): Promise<ProbeResult | null> {
  const reference = parseGithubAtomInput(inputUrl);
  if (!reference) return null;

  const response = await client.get(
    reference.sourceUrl,
    () => GITHUB_ATOM_LIMIT,
    GITHUB_ATOM_HEADERS,
  );
  if (response.status < 200 || response.status >= 300) {
    throw new ProbeError(
      "http_status",
      `HTTP ${response.status} while probing GitHub Atom ${reference.sourceKey}`,
    );
  }
  if (!isAtomContentType(response.headers.get("content-type"))) {
    throw new ProbeError("invalid_feed", "GitHub Atom response has an unsupported Content-Type");
  }
  try {
    normalizeGithubAtomFeed(
      new TextDecoder("utf-8", { fatal: true }).decode(response.body),
      response.url,
      reference.repository,
      reference.branch,
      reference.kind,
    );
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError(
      "invalid_feed",
      error instanceof Error ? error.message : "GitHub Atom response is invalid",
      error,
    );
  }

  const title =
    reference.kind === "releases"
      ? `GitHub releases (Atom): ${reference.repository}`
      : `GitHub commits (Atom): ${reference.repository}@${reference.branch}`;
  return {
    inputUrl,
    finalUrl: response.url,
    candidates: [
      {
        adapter: "github_atom",
        format: "atom",
        sourceUrl: reference.sourceUrl,
        sourceKey: reference.sourceKey,
        title,
        discoveredVia: "direct",
      },
    ],
    warnings: [],
  };
}
