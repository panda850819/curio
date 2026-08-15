CREATE TABLE destinations (
  id TEXT PRIMARY KEY,
  destination_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('telegram')),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer')
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  item_id TEXT,
  failure_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'retry_scheduled', 'delivered', 'uncertain', 'permanent_failure'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER CHECK (next_attempt_at IS NULL OR typeof(next_attempt_at) = 'integer'),
  telegram_message_id INTEGER,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 2048),
  claimed_at INTEGER CHECK (claimed_at IS NULL OR typeof(claimed_at) = 'integer'),
  delivered_at INTEGER CHECK (delivered_at IS NULL OR typeof(delivered_at) = 'integer'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
  CHECK ((item_id IS NOT NULL) != (failure_event_id IS NOT NULL)),
  UNIQUE (destination_id, item_id),
  UNIQUE (destination_id, failure_event_id),
  FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE RESTRICT,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT,
  FOREIGN KEY (failure_event_id) REFERENCES poll_failure_events(id) ON DELETE RESTRICT
);

CREATE INDEX deliveries_claim_idx ON deliveries (status, next_attempt_at, created_at);

CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'retry', 'uncertain', 'permanent_failure')),
  http_status INTEGER,
  error TEXT CHECK (error IS NULL OR length(error) <= 2048),
  started_at INTEGER NOT NULL CHECK (typeof(started_at) = 'integer'),
  finished_at INTEGER NOT NULL CHECK (typeof(finished_at) = 'integer'),
  UNIQUE (delivery_id, attempt),
  FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE RESTRICT
);
