// Re-check for a sender that pushes. A polled source is asked now; a pusher (the regression sweep, a LaunchAgent on the operator's Mac)
// cannot be, so Watch leaves it a REQUEST and the sender comes and gets it.
//
// Three facts live here, all in SQLite so a restart forgets none of them:
// - `source_schedule`: when the sender said it reports next (`nextReportAt` on its push, the latest push wins). Ignored when it does not
//   parse, is earlier than 5 min ago or later than 7 d ahead, and a push without one leaves what was stored.
// - `recheck_requests`: one row per request. An alert's Re-check (the wall's POST /api/recheck/:alertKey, the incident's, the MCP `recheck`
//   tool) opens one for each FIRING alert whose pushing source has `recheckRequests` in the config, and an alert that already has an open one
//   reuses it. The sender reads the open ones with GET /ingest/<source>/recheck-requests (the first read claims them; they come back until
//   closed or expired, so a crashed poller retries) and answers each with POST /ingest/<source>/recheck-requests/<id>: `ran`, `failed` and
//   `unsupported` close it, `dispatched` keeps it open with a note (the sender waits on a CI run and will post again). An open request
//   expires 30 min after it was made.
// - the wire the sheet reads: `PushedSender` (src/shared/recheck.ts), with the schedule and the latest request of the alert.

import { randomBytes } from 'node:crypto'
import type { WatchConfig, WebhookSourceConfig } from './config.ts'
import type { Db } from './db.ts'
import { WEBHOOK_PRESENCE_TTL_MS } from './engine.ts'
import { RECHECK_OUTCOMES, RECHECK_REQUEST_TTL_SEC } from '../shared/recheck.ts'
import type { PushedRequest, PushedSender, RecheckOutcome, RecheckRequest, RecheckVia } from '../shared/recheck.ts'
import type { Alert } from '../shared/types.ts'

const MIN_MS = 60_000
/** A nextReportAt earlier than this long ago is a stale schedule, not a promise. */
export const NEXT_REPORT_PAST_MS = 5 * MIN_MS
/** A nextReportAt later than this far ahead is not believed: a sender that reports weekly says so in `staleAfterSec`. */
export const NEXT_REPORT_AHEAD_MS = 7 * 24 * 60 * MIN_MS
export const REQUEST_TTL_MS = RECHECK_REQUEST_TTL_SEC * 1000
/** At most this many open requests in one answer, oldest first. */
export const REQUESTS_PER_POLL = 20
/** A closed or expired request is still the alert's latest request for this long. */
export const REQUEST_SHOWN_MS = 24 * 60 * MIN_MS
export const NOTE_MAX = 300

/** The sender's `nextReportAt` as an ISO time, or null when it must be ignored: not text, not a date, too far back or too far ahead. */
export function parseNextReportAt(raw: unknown, nowMs: number): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  // an ISO date and time, so a stray word or a bare number never reads as a date
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return null
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return null
  if (ms < nowMs - NEXT_REPORT_PAST_MS || ms > nowMs + NEXT_REPORT_AHEAD_MS) return null
  return new Date(ms).toISOString()
}

/** Who is asking, as it is stored: the wall names its person (or "wall"), an MCP call its agent. */
export interface Asker {
  via: RecheckVia
  by: string
}

export const WALL_ASKER: Asker = { via: 'wall', by: 'wall' }

/** The sender's answer to a request, checked: null for anything that is not an outcome (and an optional note of text). */
export function parseOutcome(body: unknown): { outcome: RecheckOutcome; note: string | null } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const { outcome, note } = body as { outcome?: unknown; note?: unknown }
  if (typeof outcome !== 'string' || !(RECHECK_OUTCOMES as readonly string[]).includes(outcome)) return null
  if (note !== undefined && note !== null && typeof note !== 'string') return null
  // trimmed, and cut on a whole character to the limit: a long note from the sender is shortened, never a reason to leave the request open
  const text = typeof note === 'string' ? [...note.replace(/\s+/g, ' ').trim()].slice(0, NOTE_MAX).join('').trim() : ''
  return { outcome: outcome as RecheckOutcome, note: text === '' ? null : text }
}

interface RequestRow {
  id: string
  source: string
  alert_key: string
  fingerprint: string
  alertname: string
  labels: string
  requested_at: string
  requested_by: string
  via: RecheckVia
  claimed_at: string | null
  outcome: RecheckOutcome | null
  note: string | null
  done_at: string | null
}

const wireOf = (r: RequestRow): RecheckRequest => ({
  id: r.id,
  alertKey: r.alert_key,
  fingerprint: r.fingerprint,
  alertname: r.alertname,
  labels: JSON.parse(r.labels) as Record<string, string>,
  requestedAt: r.requested_at,
  requestedBy: r.requested_by,
  via: r.via,
  claimedAt: r.claimed_at
})

/** The webhook source with this id when it takes re-check requests. */
export function requestable(cfg: Pick<WatchConfig, 'sources'>, id: string): (WebhookSourceConfig & { recheckRequests: { pickupWithinSec: number } }) | null {
  const s = cfg.sources.find((x) => x.id === id)
  return s && s.type === 'webhook' && s.recheckRequests ? (s as WebhookSourceConfig & { recheckRequests: { pickupWithinSec: number } }) : null
}

/** The storage behind it all. Holds no state of its own beyond the database, so any number of instances over one database agree. */
export class RecheckStore {
  private readonly db: Db
  private readonly cfg: Pick<WatchConfig, 'sources'>
  private readonly nowMs: () => number

  constructor(db: Db, cfg: Pick<WatchConfig, 'sources'>, nowMs: () => number) {
    this.db = db
    this.cfg = cfg
    this.nowMs = nowMs
  }

  private iso(ms: number = this.nowMs()): string {
    return new Date(ms).toISOString()
  }

  // ---- the schedule ----------------------------------------------------------------------------------

  /** Keep the sender's `nextReportAt` when it is in range. Returns whether it was kept. */
  setNextReportAt(source: string, raw: unknown): boolean {
    const next = parseNextReportAt(raw, this.nowMs())
    if (next === null) return false
    this.db
      .prepare('INSERT INTO source_schedule (source, next_report_at, received_at) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET next_report_at = excluded.next_report_at, received_at = excluded.received_at')
      .run(source, next, this.iso())
    return true
  }

  nextReportAt(source: string): string | null {
    const r = this.db.prepare('SELECT next_report_at FROM source_schedule WHERE source = ?').get(source) as { next_report_at: string } | undefined
    return r?.next_report_at ?? null
  }

  // ---- requests --------------------------------------------------------------------------------------

  private expiredAt(requestedAt: string): number {
    return Date.parse(requestedAt) + REQUEST_TTL_MS
  }

  private openRow(source: string, alertKey: string): RequestRow | undefined {
    const since = this.iso(this.nowMs() - REQUEST_TTL_MS)
    return this.db
      .prepare('SELECT * FROM recheck_requests WHERE source = ? AND alert_key = ? AND done_at IS NULL AND requested_at > ? ORDER BY requested_at DESC, rowid DESC LIMIT 1')
      .get(source, alertKey, since) as RequestRow | undefined
  }

  /**
   * Ask `source` to run the check behind this alert again. An alert that already has an open request reuses it (no second request for a second press);
   * a resolved alert, or a source that takes no requests, gets none (null).
   */
  open(source: string, alert: Pick<Alert, 'key' | 'fingerprint' | 'labels' | 'rule' | 'resolvedAt'>, asker: Asker): RecheckRequest | null {
    if (!requestable(this.cfg, source) || alert.resolvedAt) return null
    const existing = this.openRow(source, alert.key)
    if (existing) return wireOf(existing)
    const row: RequestRow = {
      id: `rr_${randomBytes(9).toString('hex')}`,
      source,
      alert_key: alert.key,
      fingerprint: alert.fingerprint,
      alertname: alert.labels.alertname ?? alert.rule,
      labels: JSON.stringify(alert.labels),
      requested_at: this.iso(),
      requested_by: asker.by,
      via: asker.via,
      claimed_at: null,
      outcome: null,
      note: null,
      done_at: null
    }
    this.db
      .prepare('INSERT INTO recheck_requests (id, source, alert_key, fingerprint, alertname, labels, requested_at, requested_by, via, claimed_at, outcome, note, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.source, row.alert_key, row.fingerprint, row.alertname, row.labels, row.requested_at, row.requested_by, row.via, null, null, null, null)
    return wireOf(row)
  }

  /** The open requests of a source, oldest first, at most REQUESTS_PER_POLL. The first read of a request claims it; it stays until closed or expired. */
  poll(source: string): RecheckRequest[] {
    const since = this.iso(this.nowMs() - REQUEST_TTL_MS)
    const rows = this.db
      .prepare('SELECT * FROM recheck_requests WHERE source = ? AND done_at IS NULL AND requested_at > ? ORDER BY requested_at ASC, rowid ASC LIMIT ?')
      .all(source, since, REQUESTS_PER_POLL) as unknown as RequestRow[]
    const at = this.iso()
    const claim = this.db.prepare('UPDATE recheck_requests SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL')
    return rows.map((r) => {
      if (r.claimed_at === null) {
        claim.run(at, r.id)
        r.claimed_at = at
      }
      return wireOf(r)
    })
  }

  /**
   * The sender's answer to one request. `ran`, `failed` and `unsupported` close it; `dispatched` keeps it open with the note. False for an id this
   * source does not hold. A request already closed is left as it was (a retry after a lost answer changes nothing). A late answer to an expired
   * request is still taken: the sender did its part.
   */
  answer(source: string, id: string, outcome: RecheckOutcome, note: string | null): boolean {
    const row = this.db.prepare('SELECT * FROM recheck_requests WHERE id = ? AND source = ?').get(id, source) as RequestRow | undefined
    if (!row) return false
    if (row.done_at !== null) return true
    const at = this.iso()
    const done = outcome === 'dispatched' ? null : at
    this.db
      .prepare('UPDATE recheck_requests SET outcome = ?, note = ?, done_at = ?, claimed_at = COALESCE(claimed_at, ?) WHERE id = ?')
      .run(outcome, note, done, at, id)
    return true
  }

  /** The latest request for this alert from this source: open, or closed or expired within the last 24 h. */
  latest(source: string, alertKey: string): PushedRequest | null {
    const conf = requestable(this.cfg, source)
    if (!conf) return null
    const row = this.db
      .prepare('SELECT * FROM recheck_requests WHERE source = ? AND alert_key = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1')
      .get(source, alertKey) as RequestRow | undefined
    const none: PushedRequest = { pickupWithinSec: conf.recheckRequests.pickupWithinSec, id: null, requestedAt: null, claimedAt: null, doneAt: null, expired: false, outcome: null, note: null }
    if (!row) return none
    const now = this.nowMs()
    const shown = row.done_at !== null ? now - Date.parse(row.done_at) <= REQUEST_SHOWN_MS : now - Date.parse(row.requested_at) <= REQUEST_SHOWN_MS
    if (!shown) return none
    return {
      pickupWithinSec: conf.recheckRequests.pickupWithinSec,
      id: row.id,
      requestedAt: row.requested_at,
      claimedAt: row.claimed_at,
      doneAt: row.done_at,
      expired: row.done_at === null && now >= this.expiredAt(row.requested_at),
      outcome: row.outcome,
      note: row.note
    }
  }
}

// ---- the wire ------------------------------------------------------------------------------------------

/**
 * One pushing source's side of an alert: who it is, when it last reported the alert, what it promised, when it reports next and when the alert clears
 * if it stops, and where the latest request stands. Null for a source that is not a webhook (a polled source can be asked now; Watch itself and a retired
 * source have no one to ask).
 */
export function pushedSenderOf(d: { cfg: Pick<WatchConfig, 'sources'>; store: RecheckStore }, id: string, alert: Pick<Alert, 'key' | 'origin' | 'via'>): PushedSender | null {
  const conf = d.cfg.sources.find((s) => s.id === id)
  if (!conf || conf.type !== 'webhook') return null
  const lastReportedAt = alert.via.find((v) => v.source === id)?.lastSeen ?? null
  const clearsAfterSec = conf.presenceTtlSec ?? WEBHOOK_PRESENCE_TTL_MS / 1000
  return {
    source: id,
    sender: alert.origin && alert.origin !== id ? `${alert.origin} through ${id}` : id,
    lastReportedAt,
    atLeastEverySec: conf.staleAfterSec ?? null,
    clearsAfterSec,
    nextReportAt: d.store.nextReportAt(id),
    clearsAt: lastReportedAt ? new Date(Date.parse(lastReportedAt) + clearsAfterSec * 1000).toISOString() : null,
    request: d.store.latest(id, alert.key)
  }
}

/** Every pushing sender of an alert, by the sources that report it, for the incident sheet's `pushed`. Firing or not: a cleared alert keeps its last request. */
export function pushedSendersOf(d: { cfg: Pick<WatchConfig, 'sources'>; store: RecheckStore }, alert: Pick<Alert, 'key' | 'origin' | 'via'>): PushedSender[] {
  const ids = [...new Set(alert.via.map((v) => v.source))]
  return ids.map((id) => pushedSenderOf(d, id, alert)).filter((p): p is PushedSender => p !== null)
}
