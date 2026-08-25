CREATE TABLE item_enrichments (
  item_id TEXT PRIMARY KEY NOT NULL,
  source_url TEXT NOT NULL CHECK (length(trim(source_url)) > 0),
  fetched_url TEXT,
  content_text TEXT,
  content_html TEXT,
  fetched_at INTEGER CHECK (fetched_at IS NULL OR typeof(fetched_at) = 'integer'),
  last_attempted_at INTEGER NOT NULL CHECK (typeof(last_attempted_at) = 'integer'),
  last_error TEXT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
  CHECK (
    (content_text IS NULL AND content_html IS NULL AND fetched_at IS NULL)
    OR
    (length(trim(content_text)) > 0 AND length(trim(content_html)) > 0 AND fetched_at IS NOT NULL)
  ),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
);

CREATE INDEX item_enrichments_attempted_idx
  ON item_enrichments (last_attempted_at DESC);
