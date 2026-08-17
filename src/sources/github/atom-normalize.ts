import type { CanonicalItem, JsonValue } from "../../domain/types.ts";
import { normalizeFeed } from "../rss/normalize.ts";
import type { GithubAtomKind } from "./atom-url.ts";
import type { GithubAtomEntry } from "./types.ts";

function isJsonObject(value: JsonValue | null | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceIdentifier(item: CanonicalItem): string {
  if (!isJsonObject(item.metadata) || typeof item.metadata.sourceIdentifier !== "string") {
    throw new Error("GitHub Atom entry has no stable identity");
  }
  const identifier = item.metadata.sourceIdentifier.trim();
  if (!identifier) throw new Error("GitHub Atom entry has no stable identity");
  return identifier;
}

function commitSha(identifier: string, url: string | null): string {
  for (const candidate of [identifier, url ?? ""]) {
    const match = /(?:^|[/#:])commit[/=:]([0-9a-f]{7,64})(?:$|[/?#])/iu.exec(candidate);
    if (match?.[1]) return match[1].toLowerCase();
    if (/^[0-9a-f]{7,64}$/iu.test(candidate)) return candidate.toLowerCase();
  }
  throw new Error("GitHub Atom commit entry has no commit SHA");
}

function metadata(
  repository: string,
  branch: string | null,
  kind: GithubAtomKind,
  atomId: string,
  sha: string | null,
): JsonValue {
  return {
    github: {
      repository,
      branch,
      kind: kind === "releases" ? "release" : "commit",
      atomId,
      ...(sha ? { commitSha: sha } : {}),
    },
  };
}

export function normalizeGithubAtomFeed(
  xml: string,
  sourceUrl: string,
  repository: string,
  branch: string | null,
  kind: GithubAtomKind,
): GithubAtomEntry[] {
  const normalized = normalizeFeed(xml, sourceUrl);
  if (normalized.format !== "atom") throw new Error("GitHub Atom response is not an Atom feed");

  return normalized.entries.map(({ item }) => {
    const atomId = sourceIdentifier(item);
    const sha = kind === "commits" ? commitSha(atomId, item.url ?? null) : null;
    const externalId = sha ?? atomId;
    return {
      item: {
        ...item,
        externalId,
        metadata: metadata(repository, branch, kind, atomId, sha),
      },
      updatedAt: item.sourceUpdatedAt ?? item.publishedAt ?? 0,
      sortAt: item.publishedAt ?? item.sourceUpdatedAt ?? 0,
    };
  });
}
