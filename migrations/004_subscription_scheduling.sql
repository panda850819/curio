ALTER TABLE subscriptions
  ADD COLUMN poll_interval_minutes INTEGER NOT NULL DEFAULT 60
  CHECK (
    typeof(poll_interval_minutes) = 'integer'
    AND poll_interval_minutes BETWEEN 5 AND 10080
  );

CREATE TABLE poll_failure_events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  error TEXT NOT NULL CHECK (length(error) BETWEEN 1 AND 2048),
  failed_at INTEGER NOT NULL CHECK (typeof(failed_at) = 'integer'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  delivered_at INTEGER CHECK (delivered_at IS NULL OR typeof(delivered_at) = 'integer'),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE RESTRICT
);

CREATE INDEX poll_failure_events_pending_idx
  ON poll_failure_events (delivered_at, failed_at);
