import type { Database } from "bun:sqlite";
import type { ItemEnrichment } from "../domain/types.ts";
import { sanitizeErrorMessage } from "../security/redaction.ts";

interface ItemEnrichmentRow {
  item_id: string;
  source_url: string;
  fetched_url: string | null;
  content_text: string | null;
  content_html: string | null;
  fetched_at: number | null;
  last_attempted_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function mapEnrichment(row: ItemEnrichmentRow): ItemEnrichment {
  return {
    itemId: row.item_id,
    sourceUrl: row.source_url,
    fetchedUrl: row.fetched_url,
    contentText: row.content_text,
    contentHtml: row.content_html,
    fetchedAt: row.fetched_at,
    lastAttemptedAt: row.last_attempted_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ItemEnrichmentRepository {
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now,
  ) {}

  findByItemId(itemId: string): ItemEnrichment | null {
    const row = this.database
      .query<ItemEnrichmentRow, [string]>("SELECT * FROM item_enrichments WHERE item_id = ?")
      .get(itemId);
    return row ? mapEnrichment(row) : null;
  }

  recordSuccess(input: {
    itemId: string;
    sourceUrl: string;
    fetchedUrl: string;
    contentText: string;
    contentHtml: string;
  }): ItemEnrichment {
    const timestamp = this.now();
    this.database
      .query<never, [string, string, string, string, string, number, number, number, number]>(
        `INSERT INTO item_enrichments (
           item_id, source_url, fetched_url, content_text, content_html, fetched_at,
           last_attempted_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (item_id) DO UPDATE SET
           source_url = excluded.source_url,
           fetched_url = excluded.fetched_url,
           content_text = excluded.content_text,
           content_html = excluded.content_html,
           fetched_at = excluded.fetched_at,
           last_attempted_at = excluded.last_attempted_at,
           last_error = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.itemId,
        input.sourceUrl,
        input.fetchedUrl,
        input.contentText,
        input.contentHtml,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      );
    return this.findByItemId(input.itemId) as ItemEnrichment;
  }

  recordFailure(input: { itemId: string; sourceUrl: string; error: unknown }): ItemEnrichment {
    const timestamp = this.now();
    const error = sanitizeErrorMessage(input.error);
    this.database
      .query<never, [string, string, number, string, number, number]>(
        `INSERT INTO item_enrichments (
           item_id, source_url, last_attempted_at, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (item_id) DO UPDATE SET
           source_url = excluded.source_url,
           last_attempted_at = excluded.last_attempted_at,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
      .run(input.itemId, input.sourceUrl, timestamp, error, timestamp, timestamp);
    return this.findByItemId(input.itemId) as ItemEnrichment;
  }
}
