CREATE TABLE item_reader_state (
  item_id TEXT PRIMARY KEY NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  read_at INTEGER CHECK (read_at IS NULL OR typeof(read_at) = 'integer'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
);

CREATE INDEX item_reader_state_read_idx
  ON item_reader_state (is_read, updated_at DESC);

CREATE INDEX item_reader_state_favorite_idx
  ON item_reader_state (is_favorite, updated_at DESC);

CREATE TABLE saved_quotes (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL,
  exact_text TEXT NOT NULL CHECK (length(trim(exact_text)) > 0 AND length(exact_text) <= 5000),
  prefix_context TEXT NOT NULL CHECK (length(prefix_context) <= 160),
  suffix_context TEXT NOT NULL CHECK (length(suffix_context) <= 160),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT,
  UNIQUE (item_id, exact_text, prefix_context, suffix_context)
);

CREATE INDEX saved_quotes_item_created_idx
  ON saved_quotes (item_id, created_at DESC, id DESC);
