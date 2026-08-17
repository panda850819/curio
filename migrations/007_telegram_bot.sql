CREATE TABLE telegram_bot_conversations (
  conversation_key TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer')
);

CREATE INDEX telegram_bot_conversations_expiry_idx
  ON telegram_bot_conversations (expires_at);

CREATE TABLE telegram_bot_processed_updates (
  update_id INTEGER PRIMARY KEY NOT NULL,
  processed_at INTEGER NOT NULL CHECK (typeof(processed_at) = 'integer'),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  lease_until INTEGER NOT NULL DEFAULT 0 CHECK (typeof(lease_until) = 'integer')
);

CREATE INDEX telegram_bot_processed_updates_lease_idx
  ON telegram_bot_processed_updates (status, lease_until);
