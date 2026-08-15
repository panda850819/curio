CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  adapter TEXT NOT NULL CHECK (length(trim(adapter)) > 0),
  source_key TEXT NOT NULL CHECK (length(trim(source_key)) > 0),
  source_url TEXT NOT NULL CHECK (length(trim(source_url)) > 0),
  title TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  cursor_json TEXT CHECK (cursor_json IS NULL OR json_valid(cursor_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  last_polled_at INTEGER CHECK (last_polled_at IS NULL OR typeof(last_polled_at) = 'integer'),
  last_success_at INTEGER CHECK (last_success_at IS NULL OR typeof(last_success_at) = 'integer'),
  next_poll_at INTEGER CHECK (next_poll_at IS NULL OR typeof(next_poll_at) = 'integer'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR typeof(deleted_at) = 'integer'),
  UNIQUE (adapter, source_key)
);

CREATE INDEX subscriptions_due_idx
  ON subscriptions (enabled, deleted_at, next_poll_at);

CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL,
  subscription_id TEXT NOT NULL,
  external_id TEXT NOT NULL CHECK (length(trim(external_id)) > 0),
  url TEXT,
  title TEXT,
  summary TEXT,
  content_text TEXT,
  content_html TEXT,
  author TEXT,
  published_at INTEGER CHECK (published_at IS NULL OR typeof(published_at) = 'integer'),
  source_updated_at INTEGER CHECK (source_updated_at IS NULL OR typeof(source_updated_at) = 'integer'),
  discovered_at INTEGER NOT NULL CHECK (typeof(discovered_at) = 'integer'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE RESTRICT,
  UNIQUE (subscription_id, external_id)
);

CREATE INDEX items_subscription_published_idx
  ON items (subscription_id, published_at DESC, discovered_at DESC);
