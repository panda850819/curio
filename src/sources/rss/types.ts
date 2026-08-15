import type { CanonicalItem, JsonValue } from "../../domain/types.ts";

export interface RssCursor {
  etag?: string;
  lastModified?: string;
}

export interface RssPollWarning {
  code: "invalid_date" | "invalid_url" | "entry_skipped" | "invalid_cursor_header";
  entryIndex?: number;
  message: string;
}

export interface NormalizedFeedEntry {
  item: CanonicalItem;
  sourceIndex: number;
}

export interface NormalizedFeed {
  format: "rss" | "atom" | "rdf";
  entries: NormalizedFeedEntry[];
  warnings: RssPollWarning[];
}

export interface RssPollResult {
  status: "fetched" | "not_modified";
  insertedItems: number;
  duplicateItems: number;
  warnings: RssPollWarning[];
  cursor: RssCursor;
}

export function isJsonObject(value: JsonValue | null): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
