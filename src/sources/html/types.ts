import type { CanonicalItem } from "../../domain/types.ts";

export interface HtmlCursor {
  etag?: string;
  lastModified?: string;
  lastHash?: string;
}

export interface HtmlPollWarning {
  code: "invalid_cursor_header";
  message: string;
}

export interface NormalizedHtmlDocument {
  canonical: string;
  text: string;
  title: string | null;
}

export interface HtmlPollResult {
  status: "baseline" | "changed" | "not_modified";
  insertedItems: number;
  duplicateItems: number;
  warnings: HtmlPollWarning[];
  cursor: HtmlCursor;
}

export interface HtmlItem extends CanonicalItem {
  metadata: { contentHash: string; selector?: string };
}
