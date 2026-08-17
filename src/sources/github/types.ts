import type { CanonicalItem } from "../../domain/types.ts";

export interface GithubAtomEntry {
  item: CanonicalItem;
  updatedAt: number;
  sortAt: number;
}

export interface GithubCursor {
  etag?: string;
  lastUpdatedAt?: number;
}

export interface GithubNormalizedRelease {
  item: CanonicalItem;
  updatedAt: number;
  sortAt: number;
}

export interface GithubAtomCursor {
  etag?: string;
  lastModified?: string;
  lastUpdatedAt?: number;
}

export interface GithubAtomPollResult {
  status: "fetched" | "not_modified";
  insertedItems: number;
  duplicateItems: number;
  cursor: GithubAtomCursor;
}

export interface GithubPollResult {
  status: "fetched" | "not_modified";
  insertedItems: number;
  duplicateItems: number;
  cursor: GithubCursor;
}
