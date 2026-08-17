export type FeedFormat = "rss" | "atom" | "rdf" | "x" | "html" | "youtube";
export type DiscoveryMethod = "direct" | "html-link";

export interface SubscriptionCandidate {
  adapter: "rss" | "x" | "html" | "youtube";
  format: FeedFormat;
  sourceUrl: string;
  sourceKey: string;
  title: string | null;
  discoveredVia: DiscoveryMethod;
}

export interface ProbeWarning {
  code: "candidate_failed" | "candidate_limit";
  url?: string;
  message: string;
}

export interface ProbeResult {
  inputUrl: string;
  finalUrl: string;
  candidates: SubscriptionCandidate[];
  warnings: ProbeWarning[];
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface ProbeResolver {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
}

export interface HttpHeaders {
  get(name: string): string | null;
}

export interface HttpResponse {
  url: string;
  status: number;
  headers: HttpHeaders;
  body: Uint8Array;
}

export interface ProbeHttpClient {
  get(
    url: string,
    maximumBytes: (contentType: string | null) => number,
    requestHeaders?: Readonly<Record<string, string>>,
  ): Promise<HttpResponse>;
}
