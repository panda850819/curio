import { parseGithubRepository } from "./url.ts";

const GITHUB_WEB_HOSTS = new Set(["github.com", "www.github.com"]);
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/u;

export type GithubAtomKind = "releases" | "commits";

export interface GithubAtomReference {
  kind: GithubAtomKind;
  repository: string;
  branch: string | null;
  sourceKey: string;
  sourceUrl: string;
}

function validBranch(value: string): string | null {
  const branch = value.trim();
  if (
    !branch ||
    !BRANCH_PATTERN.test(branch) ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..")
  ) {
    return null;
  }
  return branch;
}

function encodeBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function releaseReference(repository: string): GithubAtomReference {
  return {
    kind: "releases",
    repository,
    branch: null,
    sourceKey: `${repository}:releases`,
    sourceUrl: `https://github.com/${repository}/releases.atom`,
  };
}

function commitReference(repository: string, branchInput: string): GithubAtomReference | null {
  const branch = validBranch(branchInput);
  if (!branch) return null;
  return {
    kind: "commits",
    repository,
    branch,
    sourceKey: `${repository}:commits:${branch}`,
    sourceUrl: `https://github.com/${repository}/commits/${encodeBranch(branch)}.atom`,
  };
}

function decodedSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

export function parseGithubAtomInput(input: string): GithubAtomReference | null {
  const value = input.trim();
  if (!value) return null;

  if (!value.includes("://")) {
    const repository = parseGithubRepository(value);
    return repository ? releaseReference(repository.sourceKey) : null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !/^https?:$/u.test(url.protocol) ||
    !GITHUB_WEB_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  const segments = decodedSegments(url.pathname);
  if (!segments || segments.length < 2) return null;
  const repository = parseGithubRepository(`https://github.com/${segments[0]}/${segments[1]}`);
  if (!repository) return null;
  if (segments.length === 2) return releaseReference(repository.sourceKey);
  if (segments.length === 3 && segments[2]?.toLowerCase() === "releases.atom") {
    return releaseReference(repository.sourceKey);
  }
  if (segments[2]?.toLowerCase() !== "commits.atom" && segments[2]?.toLowerCase() !== "commits") {
    return null;
  }

  const branchSegments = segments.slice(3);
  const last = branchSegments.at(-1);
  if (!last?.toLowerCase().endsWith(".atom")) return null;
  branchSegments[branchSegments.length - 1] = last.slice(0, -5);
  return commitReference(repository.sourceKey, branchSegments.join("/"));
}
