export interface ExternalIdInput {
  externalId?: string | null;
  canonicalUrl?: string | null;
  title?: string | null;
  author?: string | null;
  publishedAt?: number | null;
  contentText?: string | null;
  contentHtml?: string | null;
}

function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function normalized(value: string | null | undefined): string | null {
  const result = value?.trim();
  return result ? result : null;
}

function normalizeCanonicalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`canonicalUrl must be an absolute URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`canonicalUrl must use http or https: ${value}`);
  }

  url.hash = "";
  url.searchParams.sort();
  return url.toString();
}

export function deriveExternalId(input: ExternalIdInput): string {
  const externalId = normalized(input.externalId);
  if (externalId) return externalId;

  const canonicalUrl = normalized(input.canonicalUrl);
  if (canonicalUrl) {
    return `url-sha256:${digest(normalizeCanonicalUrl(canonicalUrl))}`;
  }

  if (
    input.publishedAt !== undefined &&
    input.publishedAt !== null &&
    !Number.isSafeInteger(input.publishedAt)
  ) {
    throw new Error("publishedAt must be a safe Unix millisecond integer");
  }

  const identity = {
    title: normalized(input.title),
    author: normalized(input.author),
    publishedAt: input.publishedAt ?? null,
    contentText: normalized(input.contentText),
    contentHtml: normalized(input.contentHtml),
  };
  if (
    identity.title === null &&
    identity.author === null &&
    identity.publishedAt === null &&
    identity.contentText === null &&
    identity.contentHtml === null
  ) {
    throw new Error("Cannot derive external ID without a source ID, canonical URL, or content");
  }

  return `content-sha256:${digest(JSON.stringify(identity))}`;
}
