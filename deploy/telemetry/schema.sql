-- The telemetry collector's one table (D1 database `ezo-watcher-telemetry`). One row per event; the batch's shared fields
-- (src/shared/telemetry-schema.ts, TelemetryContext) are copied onto each row so every question is a single-table query.
-- No column holds an IP address, a header, a path or free text: the Worker (src/index.ts) writes only what parseBatch
-- accepted, plus the two-letter country Cloudflare derives from the connection.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL,      -- the collector's clock, ISO 8601 UTC
  sent_at TEXT NOT NULL,          -- the event's own `at` (a crash event is sent by the next run, so it can be older)
  schema INTEGER NOT NULL,        -- TELEMETRY_SCHEMA
  name TEXT NOT NULL,             -- cli.command | doctor.result | error | server.heartbeat
  install_id TEXT NOT NULL,       -- the anonymous random id (a v4 UUID made on first run)
  version TEXT NOT NULL,          -- the ezo-watcher version
  node TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  ci INTEGER NOT NULL,            -- 1 when a CI env var was set
  install TEXT NOT NULL,          -- npm | checkout | docker | unknown
  country TEXT,                   -- cf.country, two letters, or NULL
  props TEXT NOT NULL             -- the event's own fields as JSON (everything but name and at)
);

CREATE INDEX IF NOT EXISTS events_name_version ON events (name, version);
CREATE INDEX IF NOT EXISTS events_received ON events (received_at);
