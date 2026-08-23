import type { Database } from "bun:sqlite";
import type { ItemReaderState, SavedQuote } from "../domain/types.ts";

interface ItemReaderStateRow {
  item_id: string;
  is_read: number;
  is_favorite: number;
  read_at: number | null;
  created_at: number;
  updated_at: number;
}

interface SavedQuoteRow {
  id: string;
  item_id: string;
  exact_text: string;
  prefix_context: string;
  suffix_context: string;
  note: string | null;
  created_at: number;
  updated_at: number;
}

function mapState(row: ItemReaderStateRow): ItemReaderState {
  return {
    itemId: row.item_id,
    isRead: row.is_read === 1,
    isFavorite: row.is_favorite === 1,
    readAt: row.read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapQuote(row: SavedQuoteRow): SavedQuote {
  return {
    id: row.id,
    itemId: row.item_id,
    exactText: row.exact_text,
    prefixContext: row.prefix_context,
    suffixContext: row.suffix_context,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ReaderStateRepository {
  constructor(
    private readonly database: Database,
    private readonly generateId: () => string = () => Bun.randomUUIDv7(),
    private readonly now: () => number = Date.now,
  ) {}

  findState(itemId: string): ItemReaderState | null {
    const row = this.database
      .query<ItemReaderStateRow, [string]>("SELECT * FROM item_reader_state WHERE item_id = ?")
      .get(itemId);
    return row ? mapState(row) : null;
  }

  updateState(itemId: string, update: { isRead?: boolean; isFavorite?: boolean }): ItemReaderState {
    const timestamp = this.now();
    const existing = this.findState(itemId);
    const isRead = update.isRead ?? existing?.isRead ?? false;
    const isFavorite = update.isFavorite ?? existing?.isFavorite ?? false;
    const readAt =
      update.isRead === false
        ? null
        : update.isRead === true && !existing?.isRead
          ? timestamp
          : (existing?.readAt ?? null);
    this.database
      .query<never, [string, number, number, number | null, number, number]>(
        `INSERT INTO item_reader_state (
           item_id, is_read, is_favorite, read_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (item_id) DO UPDATE SET
           is_read = excluded.is_read,
           is_favorite = excluded.is_favorite,
           read_at = excluded.read_at,
           updated_at = excluded.updated_at`,
      )
      .run(itemId, isRead ? 1 : 0, isFavorite ? 1 : 0, readAt, timestamp, timestamp);
    return this.findState(itemId) as ItemReaderState;
  }

  findQuote(id: string): SavedQuote | null {
    const row = this.database
      .query<SavedQuoteRow, [string]>("SELECT * FROM saved_quotes WHERE id = ?")
      .get(id);
    return row ? mapQuote(row) : null;
  }

  findDuplicateQuote(input: {
    itemId: string;
    exactText: string;
    prefixContext: string;
    suffixContext: string;
  }): SavedQuote | null {
    const row = this.database
      .query<SavedQuoteRow, [string, string, string, string]>(
        `SELECT * FROM saved_quotes
         WHERE item_id = ? AND exact_text = ? AND prefix_context = ? AND suffix_context = ?`,
      )
      .get(input.itemId, input.exactText, input.prefixContext, input.suffixContext);
    return row ? mapQuote(row) : null;
  }

  createQuote(input: {
    itemId: string;
    exactText: string;
    prefixContext: string;
    suffixContext: string;
    note: string | null;
  }): SavedQuote {
    const timestamp = this.now();
    const id = this.generateId();
    this.database
      .query<never, [string, string, string, string, string, string | null, number, number]>(
        `INSERT INTO saved_quotes (
           id, item_id, exact_text, prefix_context, suffix_context, note, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.itemId,
        input.exactText,
        input.prefixContext,
        input.suffixContext,
        input.note,
        timestamp,
        timestamp,
      );
    return this.findQuote(id) as SavedQuote;
  }

  listQuotes(itemId?: string, limit = 500): SavedQuote[] {
    const rows = itemId
      ? this.database
          .query<SavedQuoteRow, [string, number]>(
            `SELECT * FROM saved_quotes WHERE item_id = ?
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(itemId, limit)
      : this.database
          .query<SavedQuoteRow, [number]>(
            "SELECT * FROM saved_quotes ORDER BY created_at DESC, id DESC LIMIT ?",
          )
          .all(limit);
    return rows.map(mapQuote);
  }

  deleteQuote(id: string): boolean {
    return (
      this.database.query<never, [string]>("DELETE FROM saved_quotes WHERE id = ?").run(id)
        .changes === 1
    );
  }
}
