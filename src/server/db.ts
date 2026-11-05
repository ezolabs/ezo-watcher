// SQLite storage on node:sqlite (built in, no native dependency). Stability 1.2 release candidate in the
// Node 24 line (nodejs.org/api/sqlite.html, retrieved 2026-10-14), so the Docker image is pinned by digest.
// One file under dataDir; WAL so the wall never waits on a write.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS alerts (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL,              -- firing | resolved
  incident_key TEXT NOT NULL,
  service TEXT NOT NULL,
  rule TEXT NOT NULL,
  host TEXT NOT NULL,
  severity TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  resolved_at TEXT,
  json TEXT NOT NULL,               -- the canonical Alert without raw
  raw_json TEXT NOT NULL            -- { [source]: raw payload } the deepest drill level
);
CREATE INDEX IF NOT EXISTS alerts_state ON alerts(state, incident_key);
CREATE TABLE IF NOT EXISTS presence (
  alert_key TEXT NOT NULL,
  source TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (alert_key, source)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  alert_key TEXT,
  incident_key TEXT,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_incident ON events(incident_key, id);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, at);
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attention (
  incident_key TEXT PRIMARY KEY,
  acked_by TEXT,
  acked_at TEXT,
  silenced_until TEXT,
  silenced_by TEXT
);
CREATE TABLE IF NOT EXISTS parks (
  incident_key TEXT PRIMARY KEY,   -- a park set by hand on a firing incident (Engine.park); one per incident, a second replaces the first
  state TEXT NOT NULL,             -- fixed_undeployed | deferred | awaiting_source
  until_at TEXT NOT NULL,          -- ISO UTC, at most 72 h after parked_at; an unpark rewrites it to the moment of the unpark
  parked_by TEXT NOT NULL,         -- "agent: <who>" through the MCP server, a name or "this browser" from the API
  parked_at TEXT NOT NULL,
  ref TEXT,                        -- a ticket, PR or commit, one line
  note TEXT NOT NULL,              -- why, at most 500 characters
  alert_keys TEXT                  -- JSON array of the alert keys firing when it was set: the park covers those; an alert that joins later ends it
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  last_ok TEXT,
  last_attempt TEXT,
  error TEXT,
  misses INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS nflog (
  key TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL,
  digest TEXT NOT NULL,
  ok INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at INTEGER
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  incident_key TEXT NOT NULL,
  route_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS results_incident ON results(incident_key, at);
CREATE INDEX IF NOT EXISTS results_channel ON results(channel_id, kind, at);
CREATE TABLE IF NOT EXISTS held (
  route_id TEXT PRIMARY KEY,
  keys TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS env_snapshots (
  pair TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  first_seen TEXT NOT NULL,        -- when this pair's first snapshot arrived
  collector TEXT NOT NULL,
  json TEXT NOT NULL               -- { left, right }: names, kinds, sources, fingerprints; never a secret value
);
CREATE TABLE IF NOT EXISTS env_history (
  pair TEXT NOT NULL,
  env TEXT NOT NULL,
  name TEXT NOT NULL,
  present INTEGER NOT NULL,
  is_set INTEGER NOT NULL,
  fingerprint TEXT,
  changed_at TEXT NOT NULL,        -- moves only when presence, set or the fingerprint changes
  PRIMARY KEY (pair, env, name)
);
CREATE TABLE IF NOT EXISTS deployments_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- one row: the latest snapshot of POST /ingest/deployments
  collected_at TEXT NOT NULL,      -- when the collector finished reading; an older snapshot never replaces a newer one
  received_at TEXT NOT NULL,
  collector TEXT NOT NULL,
  json TEXT NOT NULL               -- the validated DeploymentsSnapshot: shas, repo names, runs and fix commands; never a secret
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_key TEXT NOT NULL,
  author TEXT NOT NULL,            -- who wrote it: "agent: <who>" through the MCP server, a person's name from the wall
  text TEXT NOT NULL,              -- markdown, at most 4000 characters
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_incident ON comments(incident_key, id);
CREATE TABLE IF NOT EXISTS source_schedule (
  source TEXT PRIMARY KEY,
  next_report_at TEXT NOT NULL,    -- the last in-range nextReportAt a push carried, ISO; the latest push wins
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recheck_requests (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,            -- the pushing source that is asked
  alert_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  alertname TEXT NOT NULL,
  labels TEXT NOT NULL,            -- JSON { name: value }
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  via TEXT NOT NULL,               -- wall | mcp
  claimed_at TEXT,                 -- the first poll that returned it
  outcome TEXT,                    -- ran | dispatched | failed | unsupported, as the sender last said
  note TEXT,
  done_at TEXT                     -- set by ran, failed and unsupported; dispatched leaves it open
);
CREATE INDEX IF NOT EXISTS recheck_requests_open ON recheck_requests(source, done_at, requested_at);
CREATE INDEX IF NOT EXISTS recheck_requests_alert ON recheck_requests(alert_key, source, requested_at);
CREATE TABLE IF NOT EXISTS releases (
  product TEXT NOT NULL,
  tag TEXT NOT NULL,
  kind TEXT NOT NULL,              -- dev | beta | stable
  version TEXT NOT NULL,
  date TEXT NOT NULL,              -- YYYY-MM-DD
  built_at TEXT,                   -- ISO as the sender wrote it, or NULL
  built_ms INTEGER,                -- built_at as epoch milliseconds, for the ordering
  heading TEXT NOT NULL,
  lede TEXT NOT NULL,
  notes_md TEXT NOT NULL,
  bullet_count INTEGER NOT NULL,
  changelog_url TEXT NOT NULL,
  changelog_sha TEXT,
  received_at TEXT NOT NULL,       -- the first ingest; a repeat does not move it
  announced_at TEXT,               -- the last time the chat panel message was posted, NULL when never
  PRIMARY KEY (product, tag)
);
CREATE INDEX IF NOT EXISTS releases_newest ON releases(date DESC, built_ms DESC, received_at DESC);
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,       -- Stripe's evt_..., the dedupe key of POST /ingest/stripe
  type TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  received_at TEXT NOT NULL,       -- the first delivery that reached the post
  posted_at TEXT                   -- when the chat panel message landed; NULL while it has not (Stripe's retry posts it)
);
CREATE INDEX IF NOT EXISTS stripe_events_received ON stripe_events(received_at);
CREATE TABLE IF NOT EXISTS crypto_events (
  event_id TEXT PRIMARY KEY,       -- the router's stable id (crypto:settled:<invoice>, ...), the dedupe key of POST /ingest/crypto
  type TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  received_at TEXT NOT NULL,       -- the first delivery that reached the post
  posted_at TEXT                   -- when the chat panel message landed; NULL while it has not (the router's re-send posts it)
);
CREATE INDEX IF NOT EXISTS crypto_events_received ON crypto_events(received_at);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  ua TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS heartbeat_state (
  source TEXT PRIMARY KEY,          -- the heartbeat source id; its ping history outlives the process
  registered_at TEXT NOT NULL,      -- the first time this Watcher ever constructed the source: the deadline anchor when it has never pinged
  last_ping_at TEXT,                -- the last accepted ping, of any kind
  last_kind TEXT,                   -- ok | start | fail | exit
  last_start_at TEXT,               -- the last /start punch
  last_fail_at TEXT,                -- the first failing ping of the open streak, NULL while healthy
  exit_code INTEGER                 -- the status that opened the failure, when a /<code> did
);
`

/**
 * Columns added after a table first shipped. A column is only ever added, nullable, so the release before it still reads and writes the table (rollback is a symlink swap).
 * `parks.alert_keys` (2026-10-16): a park written before it covers the alerts that are firing when this runs.
 * `nflog.first_failed_at` and `nflog.closed` (2026-10-20): the retry cap by age counts from the first failure, and a retry that was given up on or is no longer owed says why. A row written before them has neither, which reads as "no age known, not closed".
 */
export function migrate(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(parks)').all() as unknown as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'alert_keys')) db.exec('ALTER TABLE parks ADD COLUMN alert_keys TEXT')
  const logCols = db.prepare('PRAGMA table_info(nflog)').all() as unknown as Array<{ name: string }>
  if (!logCols.some((c) => c.name === 'first_failed_at')) db.exec('ALTER TABLE nflog ADD COLUMN first_failed_at INTEGER')
  if (!logCols.some((c) => c.name === 'closed')) db.exec('ALTER TABLE nflog ADD COLUMN closed TEXT')
  // heartbeat_state shipped after the first heartbeat release: the CREATE above makes it, and a database written before it simply has no
  // rows, which reads as "this process started the job now" exactly as it did then.
  db.exec(
    "UPDATE parks SET alert_keys = (SELECT json_group_array(alerts.key) FROM alerts WHERE alerts.incident_key = parks.incident_key AND alerts.state = 'firing') WHERE alert_keys IS NULL"
  )
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
