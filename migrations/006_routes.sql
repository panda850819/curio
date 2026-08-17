CREATE TABLE routes (
  id TEXT PRIMARY KEY NOT NULL,
  subscription_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
  UNIQUE (subscription_id, destination_id),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE RESTRICT,
  FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE RESTRICT
);

CREATE INDEX routes_subscription_enabled_idx
  ON routes (subscription_id, enabled, destination_id);

CREATE TABLE route_compatibility_runs (
  destination_id TEXT PRIMARY KEY NOT NULL,
  initialized_at INTEGER NOT NULL CHECK (typeof(initialized_at) = 'integer'),
  FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE RESTRICT
);

INSERT INTO routes (
  id, subscription_id, destination_id, enabled, config_json, created_at, updated_at
)
SELECT
  'compatibility:' || subscriptions.id || ':' || destinations.id,
  subscriptions.id,
  destinations.id,
  1,
  '{}',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM subscriptions
JOIN destinations ON destinations.destination_key = 'telegram-primary'
WHERE subscriptions.deleted_at IS NULL
ON CONFLICT (subscription_id, destination_id) DO NOTHING;

INSERT INTO route_compatibility_runs (destination_id, initialized_at)
SELECT destinations.id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM destinations
WHERE destinations.destination_key = 'telegram-primary'
ON CONFLICT (destination_id) DO NOTHING;
