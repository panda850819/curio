import type { JsonValue } from "../../domain/types.ts";
import type { GithubNormalizedRelease } from "./types.ts";

interface GithubReleasePayload {
  id: unknown;
  node_id: unknown;
  tag_name: unknown;
  name: unknown;
  html_url: unknown;
  published_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  draft: unknown;
  prerelease: unknown;
  body?: unknown;
  author?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`GitHub release field ${field} must be a non-empty string`);
  }
  return value.trim();
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`GitHub release field ${field} must be a string`);
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`GitHub release field ${field} must be a boolean`);
  }
  return value;
}

function requiredId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("GitHub release field id must be a positive integer");
  }
  return value;
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`GitHub release field ${field} has an invalid date`);
  return parsed;
}

function releaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitHub release field html_url has an invalid URL");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("GitHub release field html_url must be a GitHub HTTPS URL");
  }
  return url.toString();
}

function authorLogin(value: unknown): string | null {
  if (!isObject(value) || typeof value.login !== "string" || !value.login.trim()) return null;
  return value.login.trim();
}

function normalizeRelease(
  value: GithubReleasePayload,
  repository: string,
): GithubNormalizedRelease {
  const id = requiredId(value.id);
  const nodeId = requiredString(value.node_id, "node_id");
  const tagName = requiredString(value.tag_name, "tag_name");
  const name = nullableString(value.name, "name");
  const htmlUrl = releaseUrl(requiredString(value.html_url, "html_url"));
  const publishedAtText = nullableString(value.published_at, "published_at");
  const createdAtText = requiredString(value.created_at, "created_at");
  const updatedAtText = requiredString(value.updated_at, "updated_at");
  const draft = requiredBoolean(value.draft, "draft");
  const prerelease = requiredBoolean(value.prerelease, "prerelease");
  const body = nullableString(value.body, "body");
  const publishedAt = publishedAtText === null ? null : timestamp(publishedAtText, "published_at");
  const createdAt = timestamp(createdAtText, "created_at");
  const updatedAt = timestamp(updatedAtText, "updated_at");
  const author = authorLogin(value.author);
  const displayTitle = name?.trim() || tagName;
  const summary = body?.trim().slice(0, 320) || tagName;

  return {
    updatedAt,
    sortAt: publishedAt ?? createdAt,
    item: {
      externalId: String(id),
      url: htmlUrl,
      title: displayTitle,
      summary,
      contentText: body?.trim() || null,
      author,
      publishedAt,
      sourceUpdatedAt: updatedAt,
      metadata: {
        github: {
          repository,
          kind: "release",
          id,
          nodeId,
          tagName,
          name,
          htmlUrl,
          publishedAt: publishedAtText,
          createdAt: createdAtText,
          updatedAt: updatedAtText,
          draft,
          prerelease,
        } satisfies JsonValue,
      },
    },
  };
}

export function normalizeGithubReleases(
  value: unknown,
  repository: string,
): GithubNormalizedRelease[] {
  if (!Array.isArray(value)) throw new Error("GitHub releases response must be an array");
  const byId = new Map<string, GithubNormalizedRelease>();
  for (const entry of value) {
    if (!isObject(entry)) throw new Error("GitHub release entry must be an object");
    const normalized = normalizeRelease(entry as unknown as GithubReleasePayload, repository);
    byId.set(normalized.item.externalId, normalized);
  }
  return [...byId.values()].sort(
    (left, right) => right.sortAt - left.sortAt || right.updatedAt - left.updatedAt,
  );
}
