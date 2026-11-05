// SQLite-backed stores the notifier and the channels read: the notification log (Alertmanager's nflog), the result log,
// held incidents for quiet hours and push subscriptions.

import type { Db } from './db.ts'
import type { LogRow, NotifyStore, ResultRow } from './notify/types.ts'
import type { PushSub, PushSubscriptionStore } from './notify/channels/webpush.ts'
import type { HeartbeatPingKind, HeartbeatStateRecord, HeartbeatStateStore } from './sources/types.ts'

interface NflogRow {
  key: string
  sent_at: number
  digest: string
  ok: number
  attempts: number
  next_attempt_at: number | null
  first_failed_at?: number | null
  closed?: string | null
}

function toLogRow(r: NflogRow): LogRow {
  return {
    key: r.key,
    sentAt: r.sent_at,
    digest: r.digest,
    ok: r.ok === 1,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    ...(r.first_failed_at != null ? { firstFailedAt: r.first_failed_at } : {}),
    ...(r.closed != null ? { closed: r.closed } : {})
  }
}

export class SqliteNotifyStore implements NotifyStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  getLog(key: string): LogRow | null {
    const r = this.db.prepare('SELECT * FROM nflog WHERE key = ?').get(key) as NflogRow | undefined
    return r ? toLogRow(r) : null
  }

  putLog(row: LogRow): void {
    this.db
      .prepare(
        `INSERT INTO nflog (key, sent_at, digest, ok, attempts, next_attempt_at, first_failed_at, closed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET sent_at = excluded.sent_at, digest = excluded.digest, ok = excluded.ok,
           attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at,
           first_failed_at = excluded.first_failed_at, closed = excluded.closed`
      )
      .run(row.key, row.sentAt, row.digest, row.ok ? 1 : 0, row.attempts, row.nextAttemptAt, row.firstFailedAt ?? null, row.closed ?? null)
  }

  /** Rows waiting on a retry: a failure is recorded with its next attempt, and a closed row (given up, no longer owed) has none that counts. */
  listPending(): LogRow[] {
    return (this.db.prepare('SELECT * FROM nflog WHERE closed IS NULL AND next_attempt_at IS NOT NULL').all() as unknown as NflogRow[]).map(toLogRow)
  }

  addResult(row: ResultRow): void {
    this.db
      .prepare('INSERT INTO results (at, incident_key, route_id, channel_id, kind, ok, status, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.at, row.incidentKey, row.routeId, row.channelId, row.kind, row.ok ? 1 : 0, row.status, row.latencyMs)
  }

  getHeld(routeId: string): string[] {
    const r = this.db.prepare('SELECT keys FROM held WHERE route_id = ?').get(routeId) as { keys: string } | undefined
    return r ? (JSON.parse(r.keys) as string[]) : []
  }

  putHeld(routeId: string, incidentKeys: string[]): void {
    this.db
      .prepare('INSERT INTO held (route_id, keys) VALUES (?, ?) ON CONFLICT(route_id) DO UPDATE SET keys = excluded.keys')
      .run(routeId, JSON.stringify(incidentKeys))
  }
}

export class SqlitePushStore implements PushSubscriptionStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  list(): PushSub[] {
    const rows = this.db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all() as Array<{ endpoint: string; p256dh: string; auth: string }>
    return rows.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }))
  }

  remove(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
  }

  add(sub: PushSub, ua: string, nowIso: string): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, ua, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua`
      )
      .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, ua, nowIso)
  }
}

interface HeartbeatRow {
  source: string
  registered_at: string
  last_ping_at: string | null
  last_kind: string | null
  last_start_at: string | null
  last_fail_at: string | null
  exit_code: number | null
}

const isoOrNull = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())
const msOrNull = (iso: string | null): number | null => {
  if (iso === null || iso === '') return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** The heartbeat ping history in SQLite: one row per source, read when the source is constructed and written on every ping. */
export class SqliteHeartbeatStore implements HeartbeatStateStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  load(source: string): HeartbeatStateRecord | null {
    const row = this.db.prepare('SELECT * FROM heartbeat_state WHERE source = ?').get(source) as HeartbeatRow | undefined
    if (!row) return null
    const registeredMs = msOrNull(row.registered_at)
    if (registeredMs === null) return null
    const kind = row.last_kind === 'ok' || row.last_kind === 'start' || row.last_kind === 'fail' || row.last_kind === 'exit' ? (row.last_kind as HeartbeatPingKind) : null
    return {
      source: row.source,
      registeredMs,
      lastPingMs: msOrNull(row.last_ping_at),
      lastKind: kind,
      lastStartMs: msOrNull(row.last_start_at),
      lastFailMs: msOrNull(row.last_fail_at),
      exitCode: row.exit_code
    }
  }

  save(state: HeartbeatStateRecord): void {
    this.db
      .prepare(
        `INSERT INTO heartbeat_state (source, registered_at, last_ping_at, last_kind, last_start_at, last_fail_at, exit_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET registered_at = excluded.registered_at, last_ping_at = excluded.last_ping_at,
           last_kind = excluded.last_kind, last_start_at = excluded.last_start_at, last_fail_at = excluded.last_fail_at,
           exit_code = excluded.exit_code`
      )
      .run(
        state.source,
        new Date(state.registeredMs).toISOString(),
        isoOrNull(state.lastPingMs),
        state.lastKind,
        isoOrNull(state.lastStartMs ?? null),
        isoOrNull(state.lastFailMs),
        state.exitCode
      )
  }
}
