import type { SourcePollResult } from "../../scheduler.ts";
import type { RssPollWarning } from "../rss/types.ts";

export interface YoutubeCursor {
  etag?: string;
  lastModified?: string;
}

export interface YoutubePollResult extends SourcePollResult {
  status: "fetched" | "not_modified";
  warnings: RssPollWarning[];
  cursor: YoutubeCursor;
}
