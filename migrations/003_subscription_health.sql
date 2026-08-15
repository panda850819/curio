ALTER TABLE subscriptions
  ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(consecutive_failures) = 'integer' AND consecutive_failures >= 0);

ALTER TABLE subscriptions
  ADD COLUMN last_error TEXT
  CHECK (last_error IS NULL OR length(last_error) <= 2048);

ALTER TABLE subscriptions
  ADD COLUMN last_failed_at INTEGER
  CHECK (last_failed_at IS NULL OR typeof(last_failed_at) = 'integer');
