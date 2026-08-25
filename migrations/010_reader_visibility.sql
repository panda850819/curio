ALTER TABLE items ADD COLUMN reader_hidden_at INTEGER
  CHECK (reader_hidden_at IS NULL OR typeof(reader_hidden_at) = 'integer');

CREATE TEMP TABLE legacy_x_repair (
  legacy_id TEXT PRIMARY KEY NOT NULL,
  legacy_enabled INTEGER NOT NULL,
  path TEXT NOT NULL,
  handle TEXT,
  canonical_id TEXT
);

INSERT INTO legacy_x_repair (legacy_id, legacy_enabled, path)
SELECT
  id,
  enabled,
  CASE
    WHEN lower(source_url) LIKE 'https://x.com/%' THEN substr(source_url, length('https://x.com/') + 1)
    WHEN lower(source_url) LIKE 'https://www.x.com/%' THEN substr(source_url, length('https://www.x.com/') + 1)
    WHEN lower(source_url) LIKE 'https://twitter.com/%' THEN substr(source_url, length('https://twitter.com/') + 1)
    WHEN lower(source_url) LIKE 'https://www.twitter.com/%' THEN substr(source_url, length('https://www.twitter.com/') + 1)
  END
FROM subscriptions
WHERE adapter = 'html'
  AND deleted_at IS NULL
  AND (
    lower(source_url) LIKE 'https://x.com/%'
    OR lower(source_url) LIKE 'https://www.x.com/%'
    OR lower(source_url) LIKE 'https://twitter.com/%'
    OR lower(source_url) LIKE 'https://www.twitter.com/%'
  );

UPDATE legacy_x_repair
SET path = CASE
  WHEN instr(path, '?') > 0 THEN substr(path, 1, instr(path, '?') - 1)
  ELSE path
END;

UPDATE legacy_x_repair
SET path = rtrim(path, '/'),
    handle = lower(ltrim(rtrim(path, '/'), '@'));

DELETE FROM legacy_x_repair
WHERE handle IS NULL
  OR length(handle) < 1
  OR length(handle) > 15
  OR handle GLOB '*[^a-z0-9_]*'
  OR path LIKE '%/%'
  OR (length(path) - length(replace(path, '@', ''))) > 1
  OR (instr(path, '@') > 1);

UPDATE legacy_x_repair
SET canonical_id = (
  SELECT id
  FROM subscriptions
  WHERE adapter = 'x'
    AND source_key = legacy_x_repair.handle
  LIMIT 1
);

-- If duplicate legacy rows target one handle, elect one row for in-place conversion.
UPDATE legacy_x_repair
SET canonical_id = (
  SELECT min(candidate.legacy_id)
  FROM legacy_x_repair AS candidate
  WHERE candidate.handle = legacy_x_repair.handle
)
WHERE canonical_id IS NULL
  AND legacy_id != (
    SELECT min(candidate.legacy_id)
    FROM legacy_x_repair AS candidate
    WHERE candidate.handle = legacy_x_repair.handle
  );

UPDATE items
SET reader_hidden_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE reader_hidden_at IS NULL
  AND subscription_id IN (SELECT legacy_id FROM legacy_x_repair);

-- Reuse an existing canonical X subscription, including a previously soft-deleted one.
UPDATE subscriptions
SET enabled = CASE
      WHEN deleted_at IS NOT NULL THEN (
        SELECT max(legacy_enabled) FROM legacy_x_repair WHERE canonical_id = subscriptions.id
      )
      ELSE enabled
    END,
    next_poll_at = CASE
      WHEN deleted_at IS NOT NULL THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ELSE next_poll_at
    END,
    deleted_at = NULL,
    updated_at = CASE
      WHEN deleted_at IS NOT NULL THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ELSE updated_at
    END
WHERE id IN (
  SELECT canonical_id FROM legacy_x_repair WHERE canonical_id IS NOT NULL
);

-- Preserve delivery destinations when a canonical X subscription already exists.
INSERT INTO routes (
  id, subscription_id, destination_id, enabled, config_json, created_at, updated_at
)
SELECT
  'migration-010:' || repair.legacy_id || ':' || routes.destination_id,
  repair.canonical_id,
  routes.destination_id,
  routes.enabled,
  routes.config_json,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM legacy_x_repair AS repair
JOIN routes ON routes.subscription_id = repair.legacy_id
WHERE repair.canonical_id IS NOT NULL
ON CONFLICT (subscription_id, destination_id) DO NOTHING;

-- Without a collision, convert the existing row so item and route history stays attached.
UPDATE subscriptions
SET enabled = (
      SELECT max(candidate.legacy_enabled)
      FROM legacy_x_repair AS candidate
      WHERE candidate.handle = (
        SELECT survivor.handle
        FROM legacy_x_repair AS survivor
        WHERE survivor.legacy_id = subscriptions.id
      )
    ),
    adapter = 'x',
    source_key = (
      SELECT handle FROM legacy_x_repair WHERE legacy_id = subscriptions.id
    ),
    source_url = 'https://x.com/' || (
      SELECT handle FROM legacy_x_repair WHERE legacy_id = subscriptions.id
    ),
    title = '@' || (
      SELECT handle FROM legacy_x_repair WHERE legacy_id = subscriptions.id
    ),
    cursor_json = NULL,
    metadata_json = '{}',
    last_polled_at = NULL,
    last_success_at = NULL,
    next_poll_at = CASE
      WHEN (
        SELECT max(candidate.legacy_enabled)
        FROM legacy_x_repair AS candidate
        WHERE candidate.handle = (
          SELECT survivor.handle
          FROM legacy_x_repair AS survivor
          WHERE survivor.legacy_id = subscriptions.id
        )
      ) = 1 THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ELSE NULL
    END,
    consecutive_failures = 0,
    last_error = NULL,
    last_failed_at = NULL,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id IN (
  SELECT legacy_id FROM legacy_x_repair WHERE canonical_id IS NULL
);

-- On collision, retain the old HTML row and its item history as a disabled audit record.
UPDATE subscriptions
SET enabled = 0,
    next_poll_at = NULL,
    deleted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id IN (
  SELECT legacy_id FROM legacy_x_repair WHERE canonical_id IS NOT NULL
);

DROP TABLE legacy_x_repair;

CREATE INDEX items_reader_timeline_idx
  ON items (reader_hidden_at, COALESCE(published_at, discovered_at) DESC, id DESC);
