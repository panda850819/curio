const GITHUB_WEB_HOSTS = new Set(["github.com", "www.github.com"]);
const GITHUB_API_HOST = "api.github.com";
const COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface GithubRepositoryReference {
  owner: string;
  repository: string;
  sourceKey: string;
  sourceUrl: string;
  apiUrl: string;
}

function component(value: string): string | null {
  const normalized = value.trim().replace(/\.git$/u, "");
  if (!COMPONENT_PATTERN.test(normalized) || normalized === "." || normalized === "..") {
    return null;
  }
  return normalized.toLowerCase();
}

function reference(ownerInput: string, repositoryInput: string): GithubRepositoryReference | null {
  const owner = component(ownerInput);
  const repository = component(repositoryInput);
  if (!owner || !repository) return null;
  const sourceKey = `${owner}/${repository}`;
  return {
    owner,
    repository,
    sourceKey,
    sourceUrl: `https://github.com/${owner}/${repository}`,
    apiUrl: `https://api.github.com/repos/${owner}/${repository}/releases?per_page=100`,
  };
}

export function parseGithubRepository(input: string): GithubRepositoryReference | null {
  const value = input.trim();
  if (!value) return null;

  if (!value.includes("://")) {
    const segments = value.split("/");
    if (segments.length !== 2) return null;
    return reference(segments[0] ?? "", segments[1] ?? "");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.hash) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const hostname = url.hostname.toLowerCase();
  if (GITHUB_WEB_HOSTS.has(hostname)) {
    if (segments.length !== 2 || url.search) return null;
    return reference(segments[0] ?? "", segments[1] ?? "");
  }
  if (hostname === GITHUB_API_HOST) {
    if (
      (segments.length !== 3 && segments.length !== 4) ||
      segments[0]?.toLowerCase() !== "repos" ||
      (segments.length === 4 && segments[3]?.toLowerCase() !== "releases")
    ) {
      return null;
    }
    return reference(segments[1] ?? "", segments[2] ?? "");
  }
  return null;
}

export function githubRepositoryUrl(sourceKey: string): string {
  const parsed = parseGithubRepository(sourceKey);
  if (!parsed) throw new Error(`Invalid GitHub repository: ${sourceKey}`);
  return parsed.sourceUrl;
}

export function githubReleasesApiUrl(sourceKey: string): string {
  const parsed = parseGithubRepository(sourceKey);
  if (!parsed) throw new Error(`Invalid GitHub repository: ${sourceKey}`);
  return parsed.apiUrl;
}
