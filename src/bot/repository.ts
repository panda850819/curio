import type { Database } from "bun:sqlite";
import type { JsonValue } from "../domain/types.ts";

const UPDATE_LEASE_MS = 5 * 60_000;

type UpdateClaim = "claimed" | "completed" | "in_progress";

interface ConversationRow {
  conversation_key: string;
  user_id: string;
  chat_id: string;
  state_json: string;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

export interface TelegramConversation {
  conversationKey: string;
  userId: string;
  chatId: string;
  state: JsonValue;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

function serialize(value: JsonValue): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Conversation state is not JSON serializable");
  return encoded;
}

function mapConversation(row: ConversationRow): TelegramConversation {
  return {
    conversationKey: row.conversation_key,
    userId: row.user_id,
    chatId: row.chat_id,
    state: JSON.parse(row.state_json) as JsonValue,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TelegramBotRepository {
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now,
  ) {}

  beginUpdate(updateId: number, timestamp = this.now()): UpdateClaim {
    const result = this.database
      .query<never, [number, number, number, number]>(
        `INSERT INTO telegram_bot_processed_updates (
           update_id, processed_at, status, lease_until
         ) VALUES (?, ?, 'processing', ?)
         ON CONFLICT (update_id) DO UPDATE SET
           processed_at = excluded.processed_at,
           status = 'processing',
           lease_until = excluded.lease_until
         WHERE telegram_bot_processed_updates.status = 'processing'
           AND telegram_bot_processed_updates.lease_until <= ?`,
      )
      .run(updateId, timestamp, timestamp + UPDATE_LEASE_MS, timestamp);
    if (result.changes === 1) return "claimed";
    const row = this.database
      .query<{ status: "processing" | "completed" }, [number]>(
        "SELECT status FROM telegram_bot_processed_updates WHERE update_id = ?",
      )
      .get(updateId);
    return row?.status === "completed" ? "completed" : "in_progress";
  }

  claimUpdate(updateId: number, timestamp = this.now()): boolean {
    return this.beginUpdate(updateId, timestamp) === "claimed";
  }

  completeUpdate(updateId: number, timestamp = this.now()): boolean {
    const result = this.database
      .query<never, [number, number, number]>(
        `UPDATE telegram_bot_processed_updates
         SET processed_at = ?, status = 'completed', lease_until = ?
         WHERE update_id = ? AND status = 'processing'`,
      )
      .run(timestamp, timestamp, updateId);
    return result.changes === 1;
  }

  releaseUpdate(updateId: number): boolean {
    const result = this.database
      .query<never, [number]>(
        "DELETE FROM telegram_bot_processed_updates WHERE update_id = ? AND status = 'processing'",
      )
      .run(updateId);
    return result.changes === 1;
  }

  getConversation(conversationKey: string, timestamp = this.now()): TelegramConversation | null {
    const row = this.database
      .query<ConversationRow, [string]>(
        "SELECT * FROM telegram_bot_conversations WHERE conversation_key = ?",
      )
      .get(conversationKey);
    if (!row) return null;
    if (row.expires_at <= timestamp) {
      this.clearConversation(conversationKey);
      return null;
    }
    return mapConversation(row);
  }

  setConversation(
    conversationKey: string,
    userId: string,
    chatId: string,
    state: JsonValue,
    expiresAt: number,
    timestamp = this.now(),
  ): TelegramConversation {
    const row = this.database
      .query<ConversationRow, [string, string, string, string, number, number, number]>(
        `INSERT INTO telegram_bot_conversations (
           conversation_key, user_id, chat_id, state_json, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_key) DO UPDATE SET
           user_id = excluded.user_id,
           chat_id = excluded.chat_id,
           state_json = excluded.state_json,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(conversationKey, userId, chatId, serialize(state), expiresAt, timestamp, timestamp);
    if (!row) throw new Error("Failed to save Telegram conversation");
    return mapConversation(row);
  }

  clearConversation(conversationKey: string): boolean {
    const result = this.database
      .query<never, [string]>("DELETE FROM telegram_bot_conversations WHERE conversation_key = ?")
      .run(conversationKey);
    return result.changes === 1;
  }

  purgeExpired(timestamp = this.now()): number {
    return this.database
      .query<never, [number]>("DELETE FROM telegram_bot_conversations WHERE expires_at <= ?")
      .run(timestamp).changes;
  }
}
