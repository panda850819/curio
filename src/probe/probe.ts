import { ProbeError } from "./errors.ts";
import {
  detectFeedFormat,
  isFeedContentType,
  isHtmlContentType,
  normalizedContentType,
} from "./feed.ts";
import { discoverFeedLinks } from "./html.ts";
import type { ProbeHttpClient, ProbeResult, ProbeWarning, SubscriptionCandidate } from "./types.ts";

const HTML_LIMIT = 2 * 1024 * 1024;
const FEED_LIMIT = 5 * 1024 * 1024;
const CANDIDATE_LIMIT = 20;
const CANDIDATE_CONCURRENCY = 4;
const decoder = new TextDecoder("utf-8", { fatal: true });

function responseLimit(contentType: string | null): number {
  return isHtmlContentType(contentType) ? HTML_LIMIT : FEED_LIMIT;
}

function requireSuccess(status: number, url: string): void {
  if (status < 200 || status >= 300) {
    throw new ProbeError("http_status", `HTTP ${status} while probing ${url}`);
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export async function probe(inputUrl: string, client: ProbeHttpClient): Promise<ProbeResult> {
  const initial = await client.get(inputUrl, responseLimit);
  requireSuccess(initial.status, initial.url);
  const contentType = initial.headers.get("content-type");

  if (isFeedContentType(contentType)) {
    const format = detectFeedFormat(decoder.decode(initial.body));
    return {
      inputUrl,
      finalUrl: initial.url,
      candidates: [
        {
          adapter: "rss",
          format,
          sourceUrl: initial.url,
          sourceKey: initial.url,
          title: null,
          discoveredVia: "direct",
        },
      ],
      warnings: [],
    };
  }

  if (!isHtmlContentType(contentType)) {
    throw new ProbeError(
      "invalid_feed",
      `Unsupported response Content-Type: ${normalizedContentType(contentType) ?? "missing"}`,
    );
  }

  const discovered = await discoverFeedLinks(decoder.decode(initial.body), initial.url);
  const unique = new Map<string, (typeof discovered)[number]>();
  for (const candidate of discovered) {
    if (!unique.has(candidate.url)) unique.set(candidate.url, candidate);
  }

  const warnings: ProbeWarning[] = [];
  const candidatesToCheck = [...unique.values()].slice(0, CANDIDATE_LIMIT);
  if (unique.size > CANDIDATE_LIMIT) {
    warnings.push({
      code: "candidate_limit",
      message: `Only the first ${CANDIDATE_LIMIT} unique feed candidates were checked`,
    });
  }

  const checked = await mapConcurrent(
    candidatesToCheck,
    CANDIDATE_CONCURRENCY,
    async (candidate) => {
      try {
        const response = await client.get(candidate.url, () => FEED_LIMIT);
        requireSuccess(response.status, response.url);
        if (!isFeedContentType(response.headers.get("content-type"))) {
          throw new ProbeError("invalid_feed", "Candidate does not return a feed Content-Type");
        }
        const format = detectFeedFormat(decoder.decode(response.body));
        return {
          candidate: {
            adapter: "rss",
            format,
            sourceUrl: response.url,
            sourceKey: response.url,
            title: candidate.title,
            discoveredVia: "html-link",
          } satisfies SubscriptionCandidate,
        };
      } catch (error) {
        return {
          warning: {
            code: "candidate_failed",
            url: candidate.url,
            message: error instanceof Error ? error.message : String(error),
          } satisfies ProbeWarning,
        };
      }
    },
  );

  const candidates: SubscriptionCandidate[] = [];
  const finalUrls = new Set<string>();
  for (const result of checked) {
    if (result.warning) warnings.push(result.warning);
    if (result.candidate && !finalUrls.has(result.candidate.sourceUrl)) {
      finalUrls.add(result.candidate.sourceUrl);
      candidates.push(result.candidate);
    }
  }

  return { inputUrl, finalUrl: initial.url, candidates, warnings };
}
