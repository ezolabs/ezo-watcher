// The engine reconciles observations from every source into one set of alerts, and answers the questions the
// wall and the pager ask of it. It owns no clock and no network: time is injected, sources are adapters.
//
// Identity and lifecycle:
// - An alert is keyed `${origin}:${fp8}`. The same alert seen by the Grafana poll and by a
//   webhook is ONE alert with several `via` entries. Presence rows say which channels currently report it
//   firing. It resolves when no channel reports it (a complete poll that omits it, or a resolved webhook).
//   Alerta issue 1911 ("It's gonna deduplicate based on event-environment-resource ... My alert is already
//   deduplicated on the alertmanager side") is why identity is the source fingerprint and never a second
//   dedup key of our own.
// - An incident is the wall tile: firing alerts grouped by (service, rule).
// - Resolved alerts stay in the store (history) but leave the wall. karma's maintainers closed "Can the karma
//   dashboard show all alert histories including resolved status?" as not planned (karma issue 5083), so
//   history is first-class here.

import type { Db } from './db.ts'
import { tx } from './db.ts'
import { setHeartbeatStore } from './sources/heartbeat.ts'
import { SqliteHeartbeatStore } from './stores.ts'
import { capSeverity, humanize, severityCapOf } from './derive.ts'
import type { RouteConfig, WatchConfig, WebhookSourceConfig } from './config.ts'
import { pushUnconfigured } from './notify/channels/webpush.ts'
import type {
  Alert,
  AlertEvent,
  AlertLinks,
  ChannelProof,
  ChecksPush,
  DoctorCheck,
  DoctorReport,
  EventKind,
  HistoryRow,
  Incident,
  IncidentComment,
  Observation,
  Park,
  ParkedState,
  ProbeObservation,
  Receipt,
  RuleCell,
  ServiceHealth,
  Severity,
  SourceStatus,
  WallHeader,
  WallState
} from '../shared/types.ts'
import { instanceLabels, rankOf, worstFirst } from '../shared/evidence-links.ts'
import { incidentState, incidentTitle, isParked, PARK_KEYS, unattendedSecOf } from '../shared/incident.ts'
import type { NoteKind } from '../shared/agent.ts'
import { quietState } from './notify/quiet.ts'
import type { NotifyView, ResolvedView } from './notify/types.ts'
import { DEFAULT_ASSERTION, assertsBeyondDefault } from './sources/checks.ts'
import { isSelfProbe, probeAssertions, proveProbe } from './sources/http-probe.ts'

/** The kinds whose config carries `discovered` (config.ts `checkDiscovered`): the provenance check speaks for these and no other. */
const DISCOVERABLE: ReadonlySet<string> = new Set(['http-probe', 'tcp-probe', 'heartbeat', 'domain-expiry'])

interface AlertRow {
  key: string
  state: 'firing' | 'resolved'
  incident_key: string
  service: string
  rule: string
  host: string
  severity: Severity
  starts_at: string
  first_seen: string
  last_seen: string
  resolved_at: string | null
  json: string
  raw_json: string
}

/** A row of `parks` (a park set by hand): one per incident. */
interface ParkRow {
  incident_key?: string
  state: string
  until_at: string
  parked_by: string
  parked_at: string
  ref: string | null
  note: string
  /** JSON array of the alert keys firing when the park was set; null on a row written before they were recorded. */
  alert_keys: string | null
}

/** The keys a park row covers, or null for a row that predates them (it covers whatever fires). */
function parkKeysOf(raw: string | null): string[] | null {
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : null
  } catch {
    return null
  }
}

const SEVERITY_RANK: Record<Severity, number> = { page: 3, warning: 2, info: 1 }
/** A webhook source never sends "complete" state, so presence expires if no resend arrives (Alertmanager resends at its repeat_interval, 4 h by default). A source can set its own with `presenceTtlSec`. */
export const WEBHOOK_PRESENCE_TTL_MS = 6 * 3600_000
const FLAP_WINDOW_MS = 30 * 60_000
const FLAP_EDGES = 3
const RETENTION_MS = 30 * 24 * 3600_000

/** The wall tile an alert belongs to: its service and rule, and its instance when the config splits that rule per instance. */
export const incidentKeyOf = (service: string, rule: string, instance?: string | null): string => (instance ? `${service}|${rule}|${instance}` : `${service}|${rule}`)

/** Two views of one episode may disagree by the seconds a poll takes; an overlap this small is not a second episode. */
const EPISODE_SLACK_MS = 0

/**
 * Cells needing a look come first, then the quiet ones, each by name. A tile's strip is clipped to its box (a tile on a 1440 px wall shows
 * about 55 of the router's 70 cells), so the order decides which cells can never be the hidden ones: an error or a stale cell is always shown.
 */
const CELL_ATTENTION: Record<RuleCell['state'], number> = { error: 0, stale: 1, nodata: 2, pending: 3, firing: 4, ok: 5, inferred: 6 }
const byAttention = (a: RuleCell, b: RuleCell): number => CELL_ATTENTION[a.state] - CELL_ATTENTION[b.state] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** A span in a sentence: seconds under a minute and a half (a test's schedule, a very fast job), then the shared hours-or-minutes words. */
const spanText = (sec: number): string => (sec < 90 ? `${Math.max(1, Math.round(sec))}\u00a0s` : hoursText(sec))

/** A non-breaking space joins the number to its unit: the Sources page prints this and a phone wraps it. */
const hoursText = (sec: number): string => (sec < 5400 ? `${Math.round(sec / 60)}\u00a0min` : `${Math.round(sec / 360) / 10}\u00a0h`)

/** A stored cell's assertions, or none for a row that cannot be read as a cell: `SourceStatus.asserted` counts what a cell asserts. */
function cellAsserts(json: string): string[] | undefined {
  try {
    return (JSON.parse(json) as RuleCell | null)?.asserts
  } catch {
    return undefined
  }
}

export class Engine {
  /** Channels whose credential is missing on this host: listed, never sent to. Set by main. */
  readonly disabledChannels = new Set<string>()
  /**
   * Sources main did not start because an optional source's credential is missing on this host, by id, with the
   * reason to show (`missing SENTRY_TOKEN`). Set by main. A skipped source reads `idle` with `SourceStatus.skipped`
   * set, never the stale or error state of a row an earlier run left behind, and raises no source-stale alert.
   */
  readonly skippedSources = new Map<string, string>()

  /**
   * Where the engine's own notes go (main writes them to the operator log): a source that still reports an incident someone marked
   * resolved reopens it, and the reopen is noted. The engine owns no network, so a note is queued while the ingest transaction runs and
   * handed over after it commits. A callback that throws never fails an ingest.
   */
  onNote: ((incidentKey: string, kind: NoteKind, by: string, text: string) => void) | null = null
  private pendingNotes: Array<{ incidentKey: string; kind: NoteKind; by: string; text: string }> = []

  readonly db: Db
  readonly cfg: WatchConfig
  readonly nowMs: () => number
  /**
   * The last good answer of each probe source's targets, by source id. In memory only, never written to the database: the body a target answered is
   * not state the wall keeps, and `GET /api/doctor` is where it leaves the process (for `doctor --prove`).
   */
  private readonly lastProbes = new Map<string, ProbeObservation[]>()

  constructor(db: Db, cfg: WatchConfig, nowMs: () => number = Date.now) {
    this.db = db
    this.cfg = cfg
    this.nowMs = nowMs
    // Every process opens its engine before it builds any source (src/server/main.ts), so this is where a heartbeat's ping history
    // is attached to the one database. A heartbeat built with this engine then loads its last ping on construction, and a restart
    // cannot resolve a live HeartbeatDown.
    setHeartbeatStore(new SqliteHeartbeatStore(db))
  }

  private iso(ms: number = this.nowMs()): string {
    return new Date(ms).toISOString()
  }

  /**
   * The alert as the config's severity caps leave it (`capSeverity`, src/server/derive.ts: a dev page is a warning). Applied where an alert comes in, so
   * the stored row, its events and the history carry the capped severity, and again where a stored alert is read, so a cap added or removed since a row
   * was written holds on the wall, in the counts and for the pager from the first read after a restart, not from the source's next push.
   */
  private capped(a: Alert): Alert {
    return capSeverity(a, this.cfg.severityCaps ?? [])
  }

  /** True for an alert a severity cap covers (a dev one: dev, a dev namespace or backend), whether or not the cap had to lower it: a dev ticket is a warning already. */
  private isDev(a: Alert): boolean {
    const caps = this.cfg.severityCaps ?? []
    return caps.length > 0 && severityCapOf(a, caps) !== null
  }

  /**
   * The order an incident's alerts choose its route in: the most severe first and, at one severity, every alert no severity cap covers (prod) before any
   * a cap does (dev), each kept in the order it came in. The router's dev and prod receivers post one rule's alerts into one incident (ApiBackendDraining
   * holds tickets from web-2-dev and web-2 at one severity), and the route is matched on one alert's origin: were a dev alert first, `dev-wall-only` would
   * take the prod alerts with it and they would never be posted. An incident with no prod alert at its severity is routed by its dev alert, as before.
   */
  private routingOrder(alerts: readonly Alert[]): Alert[] {
    return alerts
      .map((a, i) => ({ a, i, rank: SEVERITY_RANK[a.severity], dev: this.isDev(a) ? 1 : 0 }))
      .sort((x, y) => y.rank - x.rank || x.dev - y.dev || x.i - y.i)
      .map((x) => x.a)
  }

  // ---- ingest ---------------------------------------------------------------------------------------

  ingest(obs: Observation): void {
    this.pendingNotes = []
    tx(this.db, () => {
      const seen = new Set<string>()
      for (const a of obs.firing) {
        seen.add(a.key)
        this.upsertFiring(a, obs)
      }
      for (const a of obs.resolved) this.dropPresence(a.key, obs.source, a.endsAt ?? obs.at)
      if (obs.complete) {
        const rows = this.db.prepare('SELECT alert_key FROM presence WHERE source = ?').all(obs.source) as Array<{ alert_key: string }>
        for (const r of rows) if (!seen.has(r.alert_key)) this.dropPresence(r.alert_key, obs.source, obs.at)
      }
      if (obs.rules) this.replaceRules(obs.source, obs.rules)
      if (obs.checks) this.replaceChecks(obs.checks)
      if (obs.probes) this.lastProbes.set(obs.source, obs.probes)
      if (obs.resolvedHistory) for (const a of obs.resolvedHistory) this.importHistory(a)
    })
    this.flushNotes()
  }

  private flushNotes(): void {
    const notes = this.pendingNotes
    this.pendingNotes = []
    // A parked incident is not announced: a reopen note into its thread is the engine's own word, so it waits like a page does (a person's comment is theirs, and still goes).
    const parked = notes.some((n) => n.kind === 'reopened') ? new Set(this.firingIncidents().filter(isParked).map((i) => i.key)) : null
    for (const n of notes) {
      if (n.kind === 'reopened' && parked?.has(n.incidentKey)) continue
      try {
        this.onNote?.(n.incidentKey, n.kind, n.by, n.text)
      } catch {
        // a note that cannot be posted is lost, never an ingest that fails
      }
    }
  }

  /**
   * Called once at start, after the config is read. A source taken out of the config (the Zulip bridge poll was) can no longer say its
   * alerts resolved, and nothing expires its presence rows (only a webhook source has a TTL), so each row would hold its alert firing for
   * good. Drop them: an alert no other source reports resolves now, with the resolved event the wall and the notifier read, and one another
   * source still reports stays firing on that source's word. The source's entry is also taken out of a firing alert's `via`, so the sheet
   * no longer says "Seen by" a source that is gone. Resolved alerts keep their `via` and their history. `self` is the engine's own
   * source (source-stale), never in the config.
   */
  dropRemovedSources(): { presenceRows: number; resolved: number; firingEdited: number } {
    const known = new Set<string>(['self', ...this.cfg.sources.map((s) => s.id)])
    const at = this.iso()
    // the last good answers of a source no longer configured are gone with it (they are memory only, never rows)
    for (const id of [...this.lastProbes.keys()]) if (!known.has(id)) this.lastProbes.delete(id)
    return tx(this.db, () => {
      // A heartbeat's ping history belongs to a source that is still configured: a job re-added after being removed starts from
      // its fresh registration, not from the run it missed a month ago.
      this.db.prepare(`DELETE FROM heartbeat_state WHERE source NOT IN (${[...known].map(() => '?').join(',')})`).run(...known)
      const rows = this.db.prepare('SELECT alert_key, source FROM presence').all() as Array<{ alert_key: string; source: string }>
      const gone = rows.filter((r) => !known.has(r.source))
      let resolved = 0
      for (const r of gone) {
        const before = this.db.prepare("SELECT state FROM alerts WHERE key = ?").get(r.alert_key) as { state: string } | undefined
        this.dropPresence(r.alert_key, r.source, at)
        const after = this.db.prepare("SELECT state FROM alerts WHERE key = ?").get(r.alert_key) as { state: string } | undefined
        if (before?.state === 'firing' && after?.state === 'resolved') resolved += 1
      }
      let firingEdited = 0
      const firing = this.db.prepare("SELECT * FROM alerts WHERE state = 'firing'").all() as unknown as AlertRow[]
      for (const row of firing) {
        const a = JSON.parse(row.json) as Alert
        const via = a.via.filter((v) => known.has(v.source))
        if (via.length === a.via.length) continue
        this.updateAlert({ ...a, via }, row.incident_key, JSON.parse(row.raw_json))
        firingEdited += 1
      }
      this.db.prepare(`DELETE FROM sources WHERE id NOT IN (${[...known].map(() => '?').join(',')})`).run(...known)
      return { presenceRows: gone.length, resolved, firingEdited }
    })
  }

  /** Called on every tick: expire webhook presence, prune old rows. */
  sweep(): void {
    const now = this.nowMs()
    tx(this.db, () => {
      const ttls = new Map<string, number>()
      for (const s of this.cfg.sources) if (s.type === 'webhook') ttls.set(s.id, s.presenceTtlSec ? s.presenceTtlSec * 1000 : WEBHOOK_PRESENCE_TTL_MS)
      const rows = this.db.prepare('SELECT alert_key, source, last_seen FROM presence').all() as Array<{
        alert_key: string
        source: string
        last_seen: string
      }>
      for (const r of rows) {
        const ttl = ttls.get(r.source)
        if (ttl !== undefined && now - Date.parse(r.last_seen) > ttl) this.dropPresence(r.alert_key, r.source, this.iso(now))
      }
    })
  }

  prune(): void {
    const cutoff = this.iso(this.nowMs() - RETENTION_MS)
    this.db.prepare("DELETE FROM alerts WHERE state = 'resolved' AND resolved_at < ?").run(cutoff)
    this.db.prepare('DELETE FROM events WHERE at < ?').run(cutoff)
    this.db.prepare('DELETE FROM comments WHERE created_at < ?').run(cutoff)
    this.db.prepare('DELETE FROM results WHERE at < ?').run(this.nowMs() - RETENTION_MS)
    this.db.prepare('DELETE FROM recheck_requests WHERE requested_at < ?').run(cutoff)
    // a park whose incident has no firing alert any more (a re-key left it behind) holds nothing
    this.db.prepare("DELETE FROM parks WHERE incident_key NOT IN (SELECT incident_key FROM alerts WHERE state = 'firing')").run()
  }

  private upsertFiring(observed: Alert, obs: Observation): void {
    const incoming = this.capped(observed)
    const via = incoming.via[0]
    // An alert someone marked resolved by hand keeps its presence rows (the sources that reported it), so a resolved alert that still has a
    // presence row before this observation is one whose source never said it cleared: this observation reopens it.
    const heldByHand = (this.db.prepare('SELECT COUNT(*) AS n FROM presence WHERE alert_key = ?').get(incoming.key) as { n: number }).n > 0
    this.db
      .prepare('INSERT INTO presence (alert_key, source, last_seen) VALUES (?, ?, ?) ON CONFLICT(alert_key, source) DO UPDATE SET last_seen = excluded.last_seen')
      .run(incoming.key, obs.source, obs.at)
    const row = this.db.prepare('SELECT * FROM alerts WHERE key = ?').get(incoming.key) as AlertRow | undefined
    const incidentKey = this.keyOf(incoming)
    const raws: Record<string, unknown> = row ? JSON.parse(row.raw_json) : {}
    raws[obs.source] = incoming.raw
    if (!row) {
      const wasFiring = this.firingCount(incidentKey) > 0
      const a: Alert = { ...incoming, firstSeen: obs.at, lastSeen: obs.at, resolvedAt: null, raw: undefined }
      this.insertAlert(a, incidentKey, raws)
      this.event(obs.at, 'fired', a.key, incidentKey, { origin: a.origin, severity: a.severity, source: via.source })
      if (!wasFiring) this.incidentFired(incidentKey, a, obs.at)
      this.parkJoined(incidentKey, a)
      return
    }
    const existing = JSON.parse(row.json) as Alert
    const refire = row.state === 'resolved'
    // Capped again: the merge may keep the stored row's severity (a richer channel's), and that row may predate the cap.
    const merged = this.capped(this.merge(existing, incoming, obs.at))
    // The incident follows the merged alert: a channel with fewer labels (a bare chat row, as the retired Zulip poll gave) must not move an alert
    // that the Grafana poll already placed in its service.
    const mergedKey = this.keyOf(merged)
    if (refire) {
      const wasFiring = this.firingCount(mergedKey) > 0
      merged.startsAt = incoming.startsAt
      merged.firstSeen = obs.at
      merged.resolvedAt = null
      const manual = heldByHand ? this.manualResolveOf(merged.key) : null
      this.event(obs.at, 'fired', merged.key, mergedKey, { origin: merged.origin, severity: merged.severity, refire: true, source: via.source, ...(manual ? { reopened: true } : {}) })
      if (!wasFiring) this.incidentFired(mergedKey, merged, obs.at)
      if (manual) this.incidentReopened(mergedKey, manual, via.source, obs.at, wasFiring)
    }
    this.updateAlert(merged, mergedKey, raws)
    this.parkJoined(mergedKey, merged)
  }

  private merge(existing: Alert, incoming: Alert, nowIso: string): Alert {
    // Richer means more labels, and a polled or pushed channel beats a parsed chat message on a tie. On a full
    // tie the fresh derivation wins, so a changed service map takes effect on the next observation.
    const score = (a: Alert): number => Object.keys(a.labels).length + (a.via[0].kind === 'zulip' ? 0 : 0.5)
    const incomingRicher = score(incoming) >= score(existing)
    const rich = incomingRicher ? incoming : existing
    const poor = incomingRicher ? existing : incoming
    const labels = { ...poor.labels, ...rich.labels }
    const via = existing.via.filter((v) => v.source !== incoming.via[0].source).concat(incoming.via[0])
    // The Netdata Cloud poll owns the links of the alerts it raised: its newest reading replaces the first one, so a better link it has
    // learned since (a node's own page, not the room's) reaches an alert that is already open. Every other channel keeps the link it saw first.
    const polled = incoming.via[0].kind === 'netdata-cloud' && incoming.origin === existing.origin
    const links: AlertLinks = polled ? { ...definedOnly(existing.links), ...definedOnly(incoming.links) } : { ...incoming.links, ...definedOnly(existing.links) }
    return {
      ...existing,
      rule: rich.rule,
      service: rich.service,
      host: rich.host || poor.host,
      severity: rich.severity,
      severityLabel: rich.severityLabel,
      labels,
      annotations: mergedAnnotations(poor.annotations, rich.annotations, incoming),
      startsAt: existing.startsAt < incoming.startsAt ? existing.startsAt : incoming.startsAt,
      generatorURL: polled ? (incoming.generatorURL ?? existing.generatorURL) : (existing.generatorURL ?? incoming.generatorURL),
      status: incoming.via[0].kind === 'zulip' ? existing.status : incoming.status,
      value: existing.value ?? incoming.value,
      links,
      via,
      lastSeen: nowIso,
      resolvedAt: null,
      raw: undefined
    }
  }

  private insertAlert(a: Alert, incidentKey: string, raws: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO alerts (key, state, incident_key, service, rule, host, severity, starts_at, first_seen, last_seen, resolved_at, json, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(a.key, a.resolvedAt ? 'resolved' : 'firing', incidentKey, a.service, a.rule, a.host, a.severity, a.startsAt, a.firstSeen, a.lastSeen, a.resolvedAt, JSON.stringify(a), JSON.stringify(raws))
  }

  private updateAlert(a: Alert, incidentKey: string, raws: Record<string, unknown>): void {
    this.db
      .prepare(
        `UPDATE alerts SET state = ?, incident_key = ?, service = ?, rule = ?, host = ?, severity = ?, starts_at = ?, first_seen = ?, last_seen = ?, resolved_at = ?, json = ?, raw_json = ? WHERE key = ?`
      )
      .run(a.resolvedAt ? 'resolved' : 'firing', incidentKey, a.service, a.rule, a.host, a.severity, a.startsAt, a.firstSeen, a.lastSeen, a.resolvedAt, JSON.stringify(a), JSON.stringify(raws), a.key)
  }

  private dropPresence(alertKey: string, source: string, resolvedAtIso: string): void {
    this.db.prepare('DELETE FROM presence WHERE alert_key = ? AND source = ?').run(alertKey, source)
    const left = this.db.prepare('SELECT COUNT(*) AS n FROM presence WHERE alert_key = ?').get(alertKey) as { n: number }
    if (left.n > 0) return
    const row = this.db.prepare("SELECT * FROM alerts WHERE key = ? AND state = 'firing'").get(alertKey) as AlertRow | undefined
    if (!row) return
    const a = this.capped(JSON.parse(row.json) as Alert)
    a.resolvedAt = resolvedAtIso
    a.endsAt = resolvedAtIso
    a.lastSeen = resolvedAtIso
    this.updateAlert(a, row.incident_key, JSON.parse(row.raw_json))
    this.event(resolvedAtIso, 'resolved', a.key, row.incident_key, { origin: a.origin })
    if (this.firingCount(row.incident_key) === 0) this.incidentResolved(row.incident_key, a, resolvedAtIso)
  }

  private firingCount(incidentKey: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE incident_key = ? AND state = 'firing'").get(incidentKey) as { n: number }
    return r.n
  }

  private incidentFired(incidentKey: string, a: Alert, at: string): void {
    // A new episode starts unacknowledged. The attention row outlives the episode it was written in, so without this a re-fired incident
    // inherits the last episode's ack ("Acknowledged by Dana" on a new problem), stays off the pager and hides a live page. History keeps the
    // old ack (it reads the ack events, not this row). A silence is time-boxed and stays until it runs out; the sheet says it was set earlier.
    this.db.prepare('UPDATE attention SET acked_by = NULL, acked_at = NULL WHERE incident_key = ?').run(incidentKey)
    // A park set by hand belongs to the episode it was set in (incidentResolved removes it); one left behind by a re-keyed incident must not hold a new problem off the wall.
    this.db.prepare('DELETE FROM parks WHERE incident_key = ?').run(incidentKey)
    this.event(at, 'fired', null, incidentKey, { level: 'incident', service: a.service, rule: a.rule, instance: this.splitValue(a) ?? undefined, severity: a.severity, origin: a.origin, startsAt: a.startsAt })
  }

  private incidentResolved(incidentKey: string, last: Alert, at: string, extra: Record<string, unknown> = {}): void {
    // The episode is over, at its source or by hand, and a park set by hand ends with it (a re-fire is a new episode, unparked).
    this.db.prepare('DELETE FROM parks WHERE incident_key = ?').run(incidentKey)
    // The episode's own fired event, never a seeded one: history imported while this episode fires carries a later id, and an older
    // episode's start must not become the start of this one.
    const fired = this.db
      .prepare("SELECT at, detail FROM events WHERE incident_key = ? AND kind = 'fired' AND alert_key IS NULL AND json_extract(detail, '$.imported') IS NULL ORDER BY id DESC LIMIT 1")
      .get(incidentKey) as { at: string; detail: string } | undefined
    const startsAt = fired ? (JSON.parse(fired.detail) as { startsAt?: string }).startsAt ?? fired.at : last.startsAt
    const since = fired?.at ?? startsAt
    const inst = this.db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE incident_key = ? AND resolved_at >= ?').get(incidentKey, since) as { n: number }
    // The resolved notice is routed by this origin, as the firing incident was (routingOrder): a dev alert that resolves last names the episode's most
    // severe prod alert's origin when one was in it, so the prod alerts' resolved notice does not go down the dev route either.
    const prod = this.isDev(last)
      ? worstFirst((this.db.prepare('SELECT * FROM alerts WHERE incident_key = ? AND resolved_at >= ?').all(incidentKey, since) as unknown as AlertRow[]).map((r) => this.toAlert(r)), rankOf).find((x) => !this.isDev(x))
      : undefined
    this.event(at, 'resolved', null, incidentKey, {
      level: 'incident',
      service: last.service,
      rule: last.rule,
      instance: this.splitValue(last) ?? undefined,
      severity: last.severity,
      origin: (prod ?? last).origin,
      startsAt,
      resolvedAt: at,
      instances: Math.max(1, inst.n),
      ...extra
    })
  }

  // ---- manual resolve, reopen, confirmation, comments ------------------------------------------------------

  /** Who marked this alert resolved by hand, and why, when its latest resolution was a manual one. */
  private manualResolveOf(alertKey: string): { by: string; reason: string } | null {
    const r = this.db.prepare("SELECT detail FROM events WHERE alert_key = ? AND kind = 'resolved' ORDER BY id DESC LIMIT 1").get(alertKey) as { detail: string } | undefined
    if (!r) return null
    const d = JSON.parse(r.detail) as { manual?: boolean; by?: unknown; reason?: unknown }
    return d.manual ? { by: typeof d.by === 'string' ? d.by : 'someone', reason: typeof d.reason === 'string' ? d.reason : '' } : null
  }

  /**
   * A source still reports an incident that was marked resolved by hand, so it is firing again. Recorded as a `reopened` event, with the
   * reason the history reads; the notification log of the incident is cleared so the pager treats it as a new firing (the repeat interval
   * of the first one would otherwise keep a page that was hidden for an hour from going out); the operator log is told.
   */
  private incidentReopened(incidentKey: string, manual: { by: string; reason: string }, source: string, at: string, alreadyFiring: boolean): void {
    if (alreadyFiring) return
    this.event(at, 'reopened', null, incidentKey, { by: manual.by, reason: manual.reason, source, text: `reopened: source still firing after manual resolve by ${manual.by}` })
    const prefix = `${incidentKey}|`
    this.db.prepare('DELETE FROM nflog WHERE substr(key, 1, ?) = ?').run(prefix.length, prefix)
    this.pendingNotes.push({ incidentKey, kind: 'reopened', by: manual.by, text: manual.reason })
  }

  /**
   * Mark a firing incident resolved by hand. Every firing alert of it resolves now, with who and why on the alert's own event and on the
   * incident's resolved event, so History, the sheet and the API can tell it from a source's resolve. Nothing the source reported is
   * forgotten: its presence rows stay, so the next poll or push that still lists the alert reopens it (see incidentReopened) and a source
   * that no longer lists it clears the hold quietly. An acknowledgement or silence on the incident ends with it, so a reopened incident is
   * unattended again.
   */
  resolveManual(incidentKey: string, by: string, reason: string): { ok: true; at: string; alerts: number } | { ok: false; error: string } {
    if (this.firingCount(incidentKey) === 0) return { ok: false, error: 'not firing' }
    const at = this.iso()
    return tx(this.db, () => {
      const rows = this.db.prepare("SELECT * FROM alerts WHERE incident_key = ? AND state = 'firing'").all(incidentKey) as unknown as AlertRow[]
      let last: Alert | null = null
      for (const row of rows) {
        const a = this.capped(JSON.parse(row.json) as Alert)
        a.resolvedAt = at
        a.endsAt = at
        a.lastSeen = at
        this.updateAlert(a, row.incident_key, JSON.parse(row.raw_json))
        this.event(at, 'resolved', a.key, row.incident_key, { origin: a.origin, manual: true, by, reason })
        last = a
      }
      if (last) this.incidentResolved(incidentKey, last, at, { manual: true, by, reason })
      this.db.prepare('DELETE FROM attention WHERE incident_key = ?').run(incidentKey)
      return { ok: true as const, at, alerts: rows.length }
    })
  }

  /**
   * Record that an incident a source has already resolved is resolved: who, when, and an optional note (a fix commit, a PR, a link). Refused
   * while it is firing, when it never resolved, and while the only resolve it has is a manual one the source has not backed (a source that
   * still reports the alert).
   */
  confirmResolution(incidentKey: string, by: string, note: string): { ok: true; at: string; resolvedAt: string } | { ok: false; error: string } {
    if (this.firingCount(incidentKey) > 0) return { ok: false, error: 'still firing: only a source resolves an alert; use resolve to mark it resolved by hand' }
    const last = this.db
      .prepare("SELECT at, detail FROM events WHERE incident_key = ? AND kind = 'resolved' AND alert_key IS NULL AND json_extract(detail, '$.imported') IS NULL ORDER BY id DESC LIMIT 1")
      .get(incidentKey) as { at: string; detail: string } | undefined
    if (!last) return { ok: false, error: 'this incident has not resolved' }
    const manual = (JSON.parse(last.detail) as { manual?: boolean }).manual === true
    if (manual) {
      const held = this.db
        .prepare("SELECT COUNT(*) AS n FROM presence p JOIN alerts a ON a.key = p.alert_key WHERE a.incident_key = ? AND a.state = 'resolved'")
        .get(incidentKey) as { n: number }
      if (held.n > 0) return { ok: false, error: 'resolved by hand and a source still reports it: a source has not resolved this yet' }
    }
    const at = this.iso()
    this.event(at, 'confirmed', null, incidentKey, { by, resolvedAt: last.at, ...(note !== '' ? { note } : {}), ...(manual ? { afterManual: true } : {}) })
    return { ok: true, at, resolvedAt: last.at }
  }

  /** True when at least one alert of this incident is firing now. */
  isFiring(incidentKey: string): boolean {
    return this.firingCount(incidentKey) > 0
  }

  /** True when the engine has ever held something under this incident key: a comment needs an incident to be about. */
  knowsIncident(incidentKey: string): boolean {
    if (this.db.prepare('SELECT 1 AS x FROM alerts WHERE incident_key = ? LIMIT 1').get(incidentKey)) return true
    return !!this.db.prepare('SELECT 1 AS x FROM events WHERE incident_key = ? LIMIT 1').get(incidentKey)
  }

  /** Add a comment to an incident, firing or resolved. Null for a key the engine has never held. `text` is already checked by the caller. */
  comment(incidentKey: string, by: string, text: string): IncidentComment | null {
    if (!this.knowsIncident(incidentKey)) return null
    const createdAt = this.iso()
    const r = this.db.prepare('INSERT INTO comments (incident_key, author, text, created_at) VALUES (?, ?, ?, ?)').run(incidentKey, by, text, createdAt)
    return { id: Number(r.lastInsertRowid), incidentKey, by, text, createdAt }
  }

  /** The comments of an incident, oldest first. */
  comments(incidentKey: string, limit = 200): IncidentComment[] {
    const rows = this.db.prepare('SELECT id, incident_key, author, text, created_at FROM comments WHERE incident_key = ? ORDER BY id DESC LIMIT ?').all(incidentKey, limit) as Array<{
      id: number
      incident_key: string
      author: string
      text: string
      created_at: string
    }>
    return rows.reverse().map((r) => ({ id: r.id, incidentKey: r.incident_key, by: r.author, text: r.text, createdAt: r.created_at }))
  }

  /** How many comments each of these incidents has. */
  commentCounts(incidentKeys: string[]): Map<string, number> {
    const out = new Map<string, number>()
    const get = this.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE incident_key = ?')
    for (const k of incidentKeys) out.set(k, (get.get(k) as { n: number }).n)
    return out
  }

  /** The people's and agents' actions on incidents in a range (acknowledge, unacknowledge, silence, park, unpark, reopen, confirm), newest first, with who and why. */
  actions(sinceIso: string, untilIso: string, limit: number): AlertEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE alert_key IS NULL AND incident_key IS NOT NULL AND at >= ? AND at <= ? AND (kind IN ('ack','unack','silence','park','unpark','reopened','confirmed') OR (kind = 'resolved' AND json_extract(detail, '$.manual') = 1)) ORDER BY id DESC LIMIT ?"
      )
      .all(sinceIso, untilIso, limit) as unknown as EventRow[]
    return rows.map(toEvent)
  }

  /**
   * Seed history from sources that already hold resolved incidents (the retired Zulip bridge poll was the only one), once per episode.
   * An episode this engine already recorded is not history to seed: a channel that saw the alert live (the
   * webhook and the poll of the same Alertmanager alert) and the topic the bridge closed for it describe one
   * incident, and their timestamps differ by seconds (the sender's endsAt against the poll that noticed), so
   * the only identity that holds is "this incident was already firing, or already resolved, over that time".
   */
  private importHistory(observed: Alert): void {
    const a = this.capped(observed)
    if (!a.resolvedAt) return
    const incidentKey = this.keyOf(a)
    if (this.episodeKnown(incidentKey, a.startsAt, a.resolvedAt)) return
    const exists = this.db.prepare('SELECT 1 AS x FROM alerts WHERE key = ?').get(a.key)
    if (!exists) this.insertAlert({ ...a, raw: undefined }, incidentKey, { [a.via[0].source]: a.raw })
    const instance = this.splitValue(a) ?? undefined
    this.event(a.startsAt, 'fired', null, incidentKey, { level: 'incident', service: a.service, rule: a.rule, instance, severity: a.severity, origin: a.origin, startsAt: a.startsAt, imported: true })
    this.event(a.resolvedAt, 'resolved', null, incidentKey, {
      level: 'incident',
      service: a.service,
      rule: a.rule,
      instance,
      severity: a.severity,
      origin: a.origin,
      startsAt: a.startsAt,
      resolvedAt: a.resolvedAt,
      instances: 1,
      imported: true
    })
  }

  /** True when the incident already has a closed episode, or is firing now, that overlaps [startsAt, endsAt]. */
  private episodeKnown(incidentKey: string, startsAt: string, endsAt: string): boolean {
    const s = Date.parse(startsAt)
    const e = Date.parse(endsAt)
    if (Number.isNaN(s) || Number.isNaN(e)) return false
    const closed = this.db
      .prepare("SELECT at, detail FROM events WHERE incident_key = ? AND kind = 'resolved' AND alert_key IS NULL")
      .all(incidentKey) as Array<{ at: string; detail: string }>
    for (const r of closed) {
      const rEnd = Date.parse(r.at)
      const rStart = Date.parse((JSON.parse(r.detail) as { startsAt?: string }).startsAt ?? r.at)
      if (rStart <= e + EPISODE_SLACK_MS && s <= rEnd + EPISODE_SLACK_MS) return true
    }
    const open = this.db.prepare("SELECT starts_at FROM alerts WHERE incident_key = ? AND state = 'firing'").all(incidentKey) as Array<{ starts_at: string }>
    const openStart = open.reduce((m, r) => Math.min(m, Date.parse(r.starts_at)), Number.POSITIVE_INFINITY)
    return openStart <= e + EPISODE_SLACK_MS
  }

  /** The label value that splits this alert's rule into one incident per instance, or null when the config does not split it. */
  private splitValue(a: Alert): string | null {
    for (const r of this.cfg.splitIncidents ?? []) {
      if (r.match.origin !== undefined && !new RegExp(r.match.origin).test(a.origin)) continue
      if (r.match.rule !== undefined && !new RegExp(r.match.rule).test(a.rule)) continue
      return a.labels[r.by] || null
    }
    return null
  }

  private keyOf(a: Alert): string {
    return incidentKeyOf(a.service, a.rule, this.splitValue(a))
  }

  /** Move firing alerts to the incident the config now gives them (a split rule added or removed since they were stored). Called once at start. */
  rekey(): number {
    const rows = this.db.prepare("SELECT * FROM alerts WHERE state = 'firing'").all() as unknown as AlertRow[]
    let moved = 0
    for (const r of rows) {
      const a = JSON.parse(r.json) as Alert
      const key = this.keyOf(a)
      if (key === r.incident_key) continue
      this.db.prepare('UPDATE alerts SET incident_key = ? WHERE key = ?').run(key, r.key)
      this.parkJoined(key, a)
      moved += 1
    }
    return moved
  }

  private replaceRules(source: string, cells: RuleCell[]): void {
    this.db.prepare('DELETE FROM rules WHERE source = ?').run(source)
    const ins = this.db.prepare('INSERT INTO rules (id, source, json) VALUES (?, ?, ?)')
    for (const c of cells) ins.run(c.id, source, JSON.stringify(c))
  }

  /**
   * A sender's check list. Keyed by the sender (origin), not by the webhook source that carried it, so two senders of one webhook keep
   * their own cells. A complete list is the sender's whole set: a check it no longer lists is gone. A partial one only updates.
   */
  private replaceChecks(push: ChecksPush): void {
    // Only its own check cells: an origin that is also a polled source's id (a header naming grafana) cannot drop that source's rules.
    if (push.complete) this.db.prepare("DELETE FROM rules WHERE source = ? AND id LIKE 'check:%'").run(push.origin)
    const ins = this.db.prepare('INSERT INTO rules (id, source, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET source = excluded.source, json = excluded.json')
    for (const c of push.cells) ins.run(c.id, push.origin, JSON.stringify(c))
  }

  private event(at: string, kind: EventKind, alertKey: string | null, incidentKey: string | null, detail: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events (at, kind, alert_key, incident_key, detail) VALUES (?, ?, ?, ?, ?)').run(at, kind, alertKey, incidentKey, JSON.stringify(detail))
  }

  // ---- sources --------------------------------------------------------------------------------------

  recordSource(id: string, ok: boolean, error: string | null): void {
    const at = this.iso()
    this.db
      .prepare(
        `INSERT INTO sources (id, last_ok, last_attempt, error, misses) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_ok = CASE WHEN ? THEN excluded.last_ok ELSE sources.last_ok END,
           last_attempt = excluded.last_attempt, error = excluded.error,
           misses = CASE WHEN ? THEN 0 ELSE sources.misses + 1 END`
      )
      .run(id, ok ? at : null, at, ok ? null : error, ok ? 0 : 1, ok ? 1 : 0, ok ? 1 : 0)
  }

  /**
   * Raise or clear the self-alert that says a source has gone quiet. A dead poller must not read as all clear. A pushed source that promised a schedule
   * (`staleAfterSec`, src/server/config.ts) is included too: silence past its promise raises the same self-alert at `staleSeverity` (default page), where a
   * polled source's missed polls stay a warning. Its words say what it promised, never the poll count it never had.
   */
  staleAlerts(makeAlert: (id: string, name: string) => Alert): Alert[] {
    const out: Alert[] = []
    for (const s of this.sources()) {
      // A skipped source is not started on this host, so its silence is a missing credential, not a poll gone quiet.
      if (s.kind === 'self' || s.state !== 'stale' || s.skipped !== undefined) continue
      const source = this.cfg.sources.find((c) => c.id === s.id)
      const promisedSec = source?.type === 'webhook' ? source.staleAfterSec : undefined
      // A webhook that promised nothing is only ever stale through that promise, so this changes nothing for one that never made it.
      if (s.kind === 'webhook' && promisedSec === undefined) continue
      const alert = makeAlert(s.id, s.name)
      if (promisedSec === undefined) {
        out.push(alert)
        continue
      }
      const severity: Severity = (source as WebhookSourceConfig).staleSeverity ?? 'page'
      const silentSec = s.lastOk ? Math.max(0, (this.nowMs() - Date.parse(s.lastOk)) / 1000) : 0
      out.push({
        ...alert,
        severity,
        severityLabel: severity,
        labels: { ...alert.labels, severity },
        annotations: {
          ...alert.annotations,
          summary: `${s.name} has pushed nothing for ${spanText(silentSec)} (it promised a push at least every ${spanText(promisedSec)}).`
        }
      })
    }
    return out
  }

  sources(): SourceStatus[] {
    const rows = this.db.prepare('SELECT * FROM sources').all() as Array<{ id: string; last_ok: string | null; last_attempt: string | null; error: string | null; misses: number }>
    const byId = new Map(rows.map((r) => [r.id, r]))
    const out: SourceStatus[] = []
    for (const c of this.cfg.sources) {
      const r = byId.get(c.id)
      // Not started on this host: no poll to miss and no push to be late, so the row an earlier run may have left is not this source's state.
      const skipped = this.skippedSources.get(c.id)
      const misses = r?.misses ?? 0
      // A pushing source has no poll to miss: it is stale when it was heard once and has been silent longer than it promised.
      const pushed = c.type === 'webhook'
      const silentSec = pushed && r?.last_ok ? Math.max(0, (this.nowMs() - Date.parse(r.last_ok)) / 1000) : 0
      const pushStale = pushed && c.staleAfterSec !== undefined && silentSec > c.staleAfterSec
      const state = skipped !== undefined ? 'idle' : pushed ? (pushStale ? 'stale' : r?.last_ok ? 'ok' : 'idle') : !r?.last_attempt ? 'idle' : misses >= this.cfg.staleAfterMisses ? 'stale' : misses > 0 ? 'error' : 'ok'
      // Alerts firing that this source reports: a resolved alert a person marked resolved still has its presence row, and is not firing.
      const firing = (this.db.prepare("SELECT COUNT(*) AS n FROM presence p JOIN alerts a ON a.key = p.alert_key WHERE p.source = ? AND a.state = 'firing'").get(c.id) as { n: number }).n
      const ruleRows = this.db.prepare('SELECT json FROM rules WHERE source = ?').all(c.id) as Array<{ json: string }>
      const rules = ruleRows.length
      // Of those cells, the ones whose check asserts more than that something answered: the wall's proof that a source can go red.
      const asserted = ruleRows.reduce((n, row) => n + (assertsBeyondDefault(cellAsserts(row.json)) ? 1 : 0), 0)
      out.push({
        id: c.id,
        kind: c.type,
        name: c.id,
        state,
        lastOk: r?.last_ok ?? null,
        lastAttempt: r?.last_attempt ?? null,
        error: skipped !== undefined ? null : pushStale && pushed ? `Nothing pushed for ${hoursText(silentSec)} (it should push at least every ${hoursText(c.staleAfterSec ?? 0)}).` : (r?.error ?? null),
        firing,
        rules,
        misses,
        asserted,
        ...(skipped !== undefined ? { skipped } : {}),
        ...('discovered' in c && c.discovered ? { discovered: c.discovered } : {}),
        ...(pushed && c.staleAfterSec !== undefined ? { staleAfterSec: c.staleAfterSec } : {})
      })
    }
    return out
  }

  // ---- doctor ---------------------------------------------------------------------------------------
  // The provenance checks the running process can make about its own sources (GET /api/doctor). `watcher doctor --live` reads them instead of
  // starting a second poller, and `doctor --prove` mutates the answers in `observations` rather than asking a target again.

  /** The last good answer of one source's probe targets, from memory. Empty for a source that has answered nothing since the process started. */
  probesOf(source: string): ProbeObservation[] {
    return this.lastProbes.get(source) ?? []
  }

  /**
   * Where each source that reads an endpoint or a schedule from the project says it found it (source.untraced), whether a probe asserts anything beyond a
   * nominal 200 (source.bare-200), probes the Watcher itself (source.self-probe), and does its assertion go red when its last good answer is mutated
   * (source.assertion-not-red, the only one that fails: the gate rests on `doctor --prove`). Never touches the network, so a doctor run does not count as
   * a poll.
   */
  doctor(): DoctorReport {
    const checks: DoctorCheck[] = []
    for (const s of this.cfg.sources) {
      if (!DISCOVERABLE.has(s.type)) continue
      const where = `source ${s.id}`
      const found = 'discovered' in s ? s.discovered : undefined
      if (found) {
        checks.push({ code: 'source.untraced', status: 'pass', message: `${where} traces its source to ${found.foundAt}.` })
      } else {
        checks.push({
          code: 'source.untraced',
          status: 'warn',
          message: `${where} records no \`discovered\` block: nothing says where its endpoint was found.`,
          next: `watcher add ${s.type} --id ${s.id} --found-at <file:line>`
        })
      }
      if (s.type !== 'http-probe') continue
      const bare = s.targets.filter((t) => probeAssertions(t).every((a) => a === DEFAULT_ASSERTION)).map((t) => t.id)
      if (bare.length === 0) checks.push({ code: 'source.bare-200', status: 'pass', message: `${where} asserts more than a nominal 200 from every target.` })
      else {
        checks.push({
          code: 'source.bare-200',
          status: 'warn',
          message: `${where}: ${bare.join(', ')} assert${bare.length === 1 ? 's' : ''} only a nominal HTTP 200, so a dependency can be down and the cell stays green.`,
          next: `watcher add http-probe --id ${s.id} --url <url> --expect-json '{"ok":true}'`
        })
      }
      for (const t of s.targets) {
        if (!isSelfProbe(t.url, this.cfg)) continue
        checks.push({
          code: 'source.self-probe',
          status: 'warn',
          message: `target ${t.id} of ${where} probes the Watcher itself (${t.url}): it proves this process answers, not the project.`,
          next: 'point the probe at the service it is meant to watch'
        })
      }
      const held = this.probesOf(s.id)
      for (const t of s.targets) {
        if (!t.expectJson || Object.keys(t.expectJson).length === 0) continue
        const proof = proveProbe(t, held.find((o) => o.target === t.id) ?? null)
        if (proof.red) {
          checks.push({ code: 'source.assertion-not-red', status: 'pass', message: `target ${t.id} of ${where}: a mutation of its last good answer turned an assertion red.` })
        } else {
          checks.push({
            code: 'source.assertion-not-red',
            status: 'fail',
            message: `target ${t.id} of ${where} was not shown to go red: ${held.some((o) => o.target === t.id) ? 'a declared assertion stayed green under every mutation of its last good answer' : 'no good answer has been recorded yet'}.`,
            next: `wait for one good poll of ${s.id}, then run doctor --prove again`
          })
        }
      }
    }
    return { ok: checks.every((c) => c.status !== 'fail'), checks, observations: [...this.lastProbes.values()].flat() }
  }

  // ---- re-check ---------------------------------------------------------------------------------------
  // What an on-demand re-check reads around a poll (src/server/recheck.ts). It writes nothing: the poll goes through `ingest` like a scheduled one.

  /** One alert and the sources that report it firing right now, or null for a key this engine has never held. */
  alertPresence(key: string): { alert: Alert; sources: string[] } | null {
    const row = this.db.prepare('SELECT * FROM alerts WHERE key = ?').get(key) as AlertRow | undefined
    if (!row) return null
    const sources = (this.db.prepare('SELECT source FROM presence WHERE alert_key = ? ORDER BY source').all(key) as Array<{ source: string }>).map((r) => r.source)
    return { alert: this.toAlert(row), sources }
  }

  /** The firing alerts that at least one of these sources reports, by key. */
  firingKeysFrom(sourceIds: string[]): string[] {
    if (sourceIds.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT DISTINCT p.alert_key AS key FROM presence p JOIN alerts a ON a.key = p.alert_key WHERE a.state = 'firing' AND p.source IN (${sourceIds.map(() => '?').join(',')}) ORDER BY p.alert_key`
      )
      .all(...sourceIds) as Array<{ key: string }>
    return rows.map((r) => r.key)
  }

  /** Of these alert keys, the ones that are resolved now. */
  resolvedAmong(keys: string[]): string[] {
    const out: string[] = []
    const get = this.db.prepare("SELECT state FROM alerts WHERE key = ?")
    for (const k of keys) {
      const r = get.get(k) as { state: string } | undefined
      if (r?.state === 'resolved') out.push(k)
    }
    return out
  }

  // ---- attention ------------------------------------------------------------------------------------

  ack(incidentKey: string, by: string, note = ''): boolean {
    if (this.firingCount(incidentKey) === 0) return false
    const at = this.iso()
    this.db
      .prepare('INSERT INTO attention (incident_key, acked_by, acked_at) VALUES (?, ?, ?) ON CONFLICT(incident_key) DO UPDATE SET acked_by = excluded.acked_by, acked_at = excluded.acked_at')
      .run(incidentKey, by, at)
    this.event(at, 'ack', null, incidentKey, { by, ...(note !== '' ? { note } : {}) })
    return true
  }

  unack(incidentKey: string, by: string, note = ''): void {
    this.db.prepare('UPDATE attention SET acked_by = NULL, acked_at = NULL, silenced_until = NULL, silenced_by = NULL WHERE incident_key = ?').run(incidentKey)
    this.event(this.iso(), 'unack', null, incidentKey, { by, ...(note !== '' ? { note } : {}) })
  }

  silence(incidentKey: string, minutes: number, by: string, reason = ''): boolean {
    if (this.firingCount(incidentKey) === 0) return false
    const at = this.iso()
    const until = this.iso(this.nowMs() + minutes * 60_000)
    this.db
      .prepare('INSERT INTO attention (incident_key, silenced_until, silenced_by) VALUES (?, ?, ?) ON CONFLICT(incident_key) DO UPDATE SET silenced_until = excluded.silenced_until, silenced_by = excluded.silenced_by')
      .run(incidentKey, until, by)
    this.event(at, 'silence', null, incidentKey, { by, until, minutes, ...(reason !== '' ? { reason } : {}) })
    return true
  }

  // ---- park (by hand) ---------------------------------------------------------------------------------
  // The sweep states a park in its alerts' annotations (src/shared/incident.ts `parkOf`). This is the other way to park: whoever fixed or judged a firing incident,
  // for any source, takes it off the live wall without `resolve`'s reopen loop. Stored beside the acknowledgements and silences (table `parks`), one per incident, and
  // read by `incidentState` as `manualPark`. It covers the alerts that were firing when it was set (`parks.alert_keys`) and ends when the episode resolves (at the source or
  // by hand), when `until` passes, on unpark, or when an alert that is not one of them joins the incident (`parkJoined`). The caller has checked the input (`checkPark`,
  // src/shared/agent.ts).

  private parkRow(r: ParkRow): Park {
    const keys = parkKeysOf(r.alert_keys)
    return { state: r.state as ParkedState, until: r.until_at, since: r.parked_at, ref: r.ref, note: r.note, by: r.parked_by, ...(keys !== null ? { alertKeys: keys } : {}) }
  }

  /**
   * The `parks` row of an incident, or undefined. A row written by a release from before `parks.alert_keys` existed still reads: the column is
   * selected as NULL, which `parkKeysOf` reads as "covers whatever fires" (src/server/db.ts `migrate` backfills it when the database is opened).
   */
  private parkRowOf(incidentKey: string): ParkRow | undefined {
    const select = (columns: string): unknown => this.db.prepare(`SELECT ${columns} FROM parks WHERE incident_key = ?`).get(incidentKey)
    const columns = 'state, until_at, parked_by, parked_at, ref, note'
    try {
      return select(`${columns}, alert_keys`) as ParkRow | undefined
    } catch {
      // A pre-migration `parks` table has no `alert_keys` column yet. Reading it as NULL keeps the engine working until `migrate` runs.
      return select(`${columns}, NULL AS alert_keys`) as ParkRow | undefined
    }
  }

  /** Every `parks` row, read through `parkRowOf`'s pre-migration fallback. */
  private parkRows(): ParkRow[] {
    const columns = 'incident_key, state, until_at, parked_by, parked_at, ref, note'
    try {
      return this.db.prepare(`SELECT ${columns}, alert_keys FROM parks`).all() as unknown as ParkRow[]
    } catch {
      return this.db.prepare(`SELECT ${columns}, NULL AS alert_keys FROM parks`).all() as unknown as ParkRow[]
    }
  }

  /** The park set by hand on an incident, held or run out, or null when none was set in this episode. */
  manualParkOf(incidentKey: string): Park | null {
    const r = this.parkRowOf(incidentKey)
    return r ? this.parkRow(r) : null
  }

  /**
   * An alert was just seen firing in `incidentKey`. A park set by hand covers the alerts that were firing when it was set, the same rule as the sweep's annotations ("parked
   * only when every firing alert states a park"): an alert that is not one of them (another host or instance, or a rule that began after the park) is a new problem, so the
   * park ends now. Its end is written as this moment, so the incident is back in its severity tier, unattended and paged as a new problem would be, with its clock starting
   * at the join. An alert that was in the set and resolved and fired again is the same key and keeps the park. A park that is over already is left alone.
   */
  private parkJoined(incidentKey: string, a: Alert): void {
    const r = this.parkRowOf(incidentKey)
    if (!r) return
    const nowMs = this.nowMs()
    if (Date.parse(r.until_at) <= nowMs) return
    const keys = parkKeysOf(r.alert_keys)
    if (keys === null || keys.includes(a.key)) return
    const at = this.iso(nowMs)
    this.db.prepare('UPDATE parks SET until_at = ? WHERE incident_key = ?').run(at, incidentKey)
    this.event(at, 'unpark', null, incidentKey, { ended: 'joined', parkedBy: r.parked_by, state: r.state, wasUntil: r.until_at, alert: { key: a.key, rule: a.rule, host: a.host } })
  }

  /**
   * Park a firing incident by hand until `until` (ISO UTC, already checked to be within PARK_MAX_HOURS). A second park on the same incident replaces the first. A `park`
   * event records who, why and until when; `replaced` says an earlier park was written over. Refused for an incident that is not firing.
   */
  park(incidentKey: string, p: { state: ParkedState; until: string; by: string; note: string; ref?: string }): { ok: true; at: string; replaced: boolean } | { ok: false; error: string } {
    if (this.firingCount(incidentKey) === 0) return { ok: false, error: 'not firing' }
    const at = this.iso()
    const ref = p.ref && p.ref !== '' ? p.ref : null
    return tx(this.db, () => {
      // the park covers the alerts firing now, and no others
      const covered = (this.db.prepare("SELECT key FROM alerts WHERE incident_key = ? AND state = 'firing' ORDER BY key").all(incidentKey) as unknown as Array<{ key: string }>).map((r) => r.key)
      // "replaced" means an earlier park was still in force; a row that an unpark or an expiry left behind is written over without saying so
      const prev = this.db.prepare('SELECT until_at FROM parks WHERE incident_key = ?').get(incidentKey) as { until_at: string } | undefined
      const replaced = !!prev && Date.parse(prev.until_at) > Date.parse(at)
      // A database from before `alert_keys` takes the same park; it just cannot record the coverage, so every park there covers whatever fires.
      const put = (withKeys: boolean): void => {
        const cols = withKeys ? ', alert_keys' : ''
        const marks = withKeys ? ', ?' : ''
        const setKeys = withKeys ? ', alert_keys = excluded.alert_keys' : ''
        const values = withKeys ? [incidentKey, p.state, p.until, p.by, at, ref, p.note, JSON.stringify(covered)] : [incidentKey, p.state, p.until, p.by, at, ref, p.note]
        this.db
          .prepare(
            `INSERT INTO parks (incident_key, state, until_at, parked_by, parked_at, ref, note${cols}) VALUES (?, ?, ?, ?, ?, ?, ?${marks})
             ON CONFLICT(incident_key) DO UPDATE SET state = excluded.state, until_at = excluded.until_at, parked_by = excluded.parked_by, parked_at = excluded.parked_at, ref = excluded.ref, note = excluded.note${setKeys}`
          )
          .run(...values)
      }
      try {
        put(true)
      } catch (err) {
        if (!(err instanceof Error) || !/(no such column: alert_keys|has no column named alert_keys)/.test(err.message)) throw err
        put(false)
      }
      this.event(at, 'park', null, incidentKey, { by: p.by, state: p.state, until: p.until, note: p.note, ...(ref ? { ref } : {}), ...(replaced ? { replaced: true } : {}) })
      return { ok: true as const, at, replaced }
    })
  }

  /**
   * End a park set by hand now. The park is not deleted: its end is written as this moment, so the incident is back in its severity tier, unattended, with its clock
   * starting here (as when a park runs out), not at its first firing. Refused when the incident is not firing, was not parked by hand, or its park has already ended.
   */
  unpark(incidentKey: string, by: string, note = ''): { ok: true; at: string; was: Park } | { ok: false; error: 'not firing' | 'not parked by hand' | 'park ended'; endedAt?: string } {
    if (this.firingCount(incidentKey) === 0) return { ok: false, error: 'not firing' }
    const was = this.manualParkOf(incidentKey)
    if (!was) return { ok: false, error: 'not parked by hand' }
    const nowMs = this.nowMs()
    if (Date.parse(was.until) <= nowMs) return { ok: false, error: 'park ended', endedAt: was.until }
    const at = this.iso(nowMs)
    return tx(this.db, () => {
      this.db.prepare('UPDATE parks SET until_at = ? WHERE incident_key = ?').run(at, incidentKey)
      this.event(at, 'unpark', null, incidentKey, { by, state: was.state, wasUntil: was.until, ...(note !== '' ? { note } : {}) })
      return { ok: true as const, at, was }
    })
  }

  // ---- reading --------------------------------------------------------------------------------------

  private toAlert(r: AlertRow, withRaw = false): Alert {
    const a = JSON.parse(r.json) as Alert
    a.resolvedAt = r.resolved_at
    a.raw = withRaw ? JSON.parse(r.raw_json) : undefined
    return this.capped(a)
  }

  private cells(): RuleCell[] {
    const nowMs = this.nowMs()
    const stale = new Set(this.sources().filter((s) => s.state === 'stale').map((s) => s.id))
    const rows = this.db.prepare('SELECT json FROM rules').all() as Array<{ json: string }>
    return rows.map((r) => {
      const c = JSON.parse(r.json) as RuleCell
      if (stale.has(c.source)) return { ...c, state: 'stale' as const }
      // A pushed check list names its own limit; a polled rule is stale after two of its intervals.
      const limitSec = c.staleAfterSec ?? (c.intervalSec ? c.intervalSec * 2 : undefined)
      if (c.evaluatedAt && limitSec && nowMs - Date.parse(c.evaluatedAt) > limitSec * 1000) return { ...c, state: 'stale' as const }
      return c
    })
  }

  private flapState(incidentKey: string): { flapping: boolean; stableForSec: number } {
    const since = this.iso(this.nowMs() - FLAP_WINDOW_MS)
    const rows = this.db
      .prepare("SELECT at FROM events WHERE incident_key = ? AND alert_key IS NULL AND kind IN ('fired','resolved') AND at >= ? ORDER BY id DESC")
      .all(incidentKey, since) as Array<{ at: string }>
    const last = rows[0] ? Date.parse(rows[0].at) : 0
    return { flapping: rows.length >= FLAP_EDGES, stableForSec: last ? Math.max(0, (this.nowMs() - last) / 1000) : Number.MAX_SAFE_INTEGER }
  }

  private matchRoutes(sev: Severity, origin: string, labels: Record<string, string>): RouteConfig[] {
    const out: RouteConfig[] = []
    for (const r of this.cfg.routes) {
      if (r.match.severity && !r.match.severity.includes(sev)) continue
      if (r.match.origin && !r.match.origin.includes(origin)) continue
      if (r.match.labels && !Object.entries(r.match.labels).every(([k, re]) => new RegExp(re).test(labels[k] ?? ''))) continue
      out.push(r)
      if (!r.continue) break
    }
    return out
  }

  private lastReceipt(incidentKey: string): Receipt | null {
    const r = this.db
      .prepare("SELECT at, channel_id, ok, status, latency_ms FROM results WHERE incident_key = ? AND kind IN ('alert','escalation') ORDER BY id DESC LIMIT 1")
      .get(incidentKey) as { at: number; channel_id: string; ok: number; status: string; latency_ms: number } | undefined
    return r ? { at: this.iso(r.at), channel: r.channel_id, ok: r.ok === 1, status: r.status, latencyMs: r.latency_ms } : null
  }

  private firingIncidents(): Incident[] {
    const nowMs = this.nowMs()
    const rows = this.db.prepare("SELECT * FROM alerts WHERE state = 'firing' ORDER BY incident_key, host, key").all() as unknown as AlertRow[]
    const att = new Map(
      (this.db.prepare('SELECT * FROM attention').all() as Array<{ incident_key: string; acked_by: string | null; acked_at: string | null; silenced_until: string | null; silenced_by: string | null }>).map((r) => [r.incident_key, r])
    )
    const manual = new Map(
      this.parkRows().map((r) => [r.incident_key as string, this.parkRow(r)])
    )
    const cells = this.cells()
    const grouped = new Map<string, AlertRow[]>()
    for (const r of rows) {
      const list = grouped.get(r.incident_key) ?? []
      list.push(r)
      grouped.set(r.incident_key, list)
    }
    const out: Incident[] = []
    for (const [key, list] of grouped) {
      // Worst first (severity, shortest ETA, oldest), so the headline, the summary, the tile's instance list and the
      // links all describe the instance a person should look at first, not whichever host sorts first by name.
      const alerts = worstFirst(list.map((r) => this.toAlert(r)), rankOf)
      const first = alerts[0]
      const severity = alerts.reduce<Severity>((s, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[s] ? a.severity : s), 'info')
      // The incident's clock (its age band, its escalation steps, "unattended for") starts when the alerts of its CURRENT severity
      // began. An older warning in the same incident (same service and rule, another host) must not make a page that just
      // arrived look an hour old and escalate to SMS and email on the spot.
      const startsAt = alerts.filter((x) => x.severity === severity).reduce((m, x) => (x.startsAt < m ? x.startsAt : m), '9999')
      const a = att.get(key)
      const sourceSilenced = alerts.every((x) => x.status.state === 'suppressed')
      const silencedUntil = a?.silenced_until && Date.parse(a.silenced_until) > nowMs ? a.silenced_until : null
      const st = incidentState({
        severity,
        instances: alerts.length,
        startsAtMs: Date.parse(startsAt),
        nowMs,
        ackedAtMs: a?.acked_at ? Date.parse(a.acked_at) : null,
        silencedUntilMs: silencedUntil ? Date.parse(silencedUntil) : sourceSilenced ? nowMs + 1 : null,
        // every firing alert of the incident: the park they all state, if any, is decided in the state function and nowhere else, beside a park set by hand
        annotations: alerts.map((x) => x.annotations),
        manualPark: manual.get(key) ?? null
      })
      const labels = commonLabels(alerts)
      // Routed by its most severe prod alert when it has one (routingOrder), not by whichever alert the tile shows first: a dev alert there would send the prod ones down the dev route.
      const routes = this.matchRoutes(severity, this.routingOrder(alerts)[0].origin, labels)
      // A route with an empty receiver list is the wall-only route: it matches and nobody is notified, not even by escalation.
      const wallOnly = routes.every((r) => r.receivers.length === 0 && (r.escalate ?? []).every((e) => e.receivers.length === 0))
      const unattended = unattendedSecOf(st, a?.acked_at ? Date.parse(a.acked_at) : null, nowMs)
      let nextStep: Incident['nextStep'] = null
      let heldUntil: string | null = null
      if (st.attention === 'none') {
        for (const r of routes) {
          for (const e of r.escalate ?? []) {
            if (e.afterSec > unattended && e.receivers.length > 0) {
              const at = this.iso(nowMs + (e.afterSec - unattended) * 1000)
              if (!nextStep || at < nextStep.at) nextStep = { at, channels: e.receivers }
            }
          }
          if (r.muteInQuietHours && severity !== 'page') {
            const q = quietState(this.cfg.quietHours, nowMs)
            if (q.quiet && q.endsAtMs) heldUntil = this.iso(q.endsAtMs)
          }
        }
      }
      out.push({
        key,
        service: first.service,
        rule: first.rule,
        instance: this.splitValue(first),
        summary: alerts.map((x) => x.annotations.summary).find(Boolean) ?? first.rule,
        severity,
        state: st,
        startsAt,
        alerts,
        ackedBy: a?.acked_by ?? null,
        ackedAt: a?.acked_at ?? null,
        silencedUntil,
        silencedBy: silencedUntil ? (a?.silenced_by ?? null) : null,
        silenceCarried: silencedUntil ? this.silenceCarried(key) : false,
        cells: cells.filter((c) => c.service === first.service),
        receipt: this.lastReceipt(key),
        nextStep,
        heldUntil,
        wallOnly
      })
    }
    return out
  }

  /** True when the silence on this incident was set before its current episode fired: it was carried over, not chosen for this problem. */
  private silenceCarried(incidentKey: string): boolean {
    const silence = this.db.prepare("SELECT at FROM events WHERE incident_key = ? AND kind = 'silence' AND alert_key IS NULL ORDER BY id DESC LIMIT 1").get(incidentKey) as { at: string } | undefined
    const fired = this.db
      .prepare("SELECT at FROM events WHERE incident_key = ? AND kind = 'fired' AND alert_key IS NULL AND json_extract(detail, '$.imported') IS NULL ORDER BY id DESC LIMIT 1")
      .get(incidentKey) as { at: string } | undefined
    return !!silence && !!fired && silence.at < fired.at
  }

  wall(): WallState {
    const nowMs = this.nowMs()
    const incidents = this.firingIncidents()
    const cells = this.cells()
    const firingServices = new Set(incidents.map((i) => i.service))
    const byService = new Map<string, RuleCell[]>()
    for (const c of cells) {
      const list = byService.get(c.service) ?? []
      list.push(c)
      byService.set(c.service, list)
    }
    // Services the rules inventory does not cover (the router's Alertmanager alerts arrive by the webhook source)
    // appear with one inferred cell per rule name seen in the last 30 days.
    const seen = this.db
      .prepare("SELECT DISTINCT json_extract(detail, '$.service') AS service, json_extract(detail, '$.rule') AS rule, json_extract(detail, '$.origin') AS origin FROM events WHERE kind = 'resolved' AND alert_key IS NULL AND json_extract(detail, '$.origin') != 'self' AND at >= ?")
      .all(this.iso(nowMs - RETENTION_MS)) as Array<{ service: string; rule: string; origin: string }>
    // A class the config excludes (bug reports the sweep relays: nobody wants them on the wall) leaves no cell behind once it resolves.
    const excluded = (this.cfg.inferredCellExclude ?? []).map((x) => ({ origin: x.origin === undefined ? null : new RegExp(x.origin), rule: x.rule === undefined ? null : new RegExp(x.rule) }))
    // A service name differing only in case is the same tile: an event stored "Clickhouse" (a sweep finding's `service` label read
    // as a title) must land on the "ClickHouse" the rules inventory names, not draw a second, dotted tile beside it.
    const byLower = new Map([...byService.keys()].map((k) => [k.toLowerCase(), k]))
    // Taken before the loop: a cell the loop adds must not make the next class of the same tile read as covered.
    const covered = new Set([...byService].filter(([, list]) => list.some((c) => c.state !== 'inferred')).map(([service]) => service))
    // A dotted cell is a guess. When the sender of the alert lists that class as a check (a pushed check list), its real cell takes the
    // dotted one's place on the tile the history put it on: the worst reading when the sender lists the class more than once.
    const checkOf = new Map<string, RuleCell>()
    for (const c of cells) {
      if (!c.checkId) continue
      const k = `${c.source}\u0000${c.checkId}`
      const held = checkOf.get(k)
      if (!held || CELL_ATTENTION[c.state] < CELL_ATTENTION[held.state]) checkOf.set(k, c)
    }
    // A rule its own source lists is watched, whatever tile an old alert of it landed on (a history row from the retired Zulip poll carries no component, so its service reads
    // "grafana"): the dotted copy beside the real cell would be a second tile for a rule that is not a guess.
    const listed = new Set(cells.filter((c) => !c.checkId).map((c) => `${c.source}\u0000${c.name}`))
    for (const row of seen) {
      if (!row.service || !row.rule) continue
      if (excluded.some((x) => (!x.origin || x.origin.test(row.origin ?? '')) && (!x.rule || x.rule.test(row.rule)))) continue
      const named = humanize(row.service)
      const s = { service: byLower.get(named.toLowerCase()) ?? named, rule: row.rule }
      byLower.set(s.service.toLowerCase(), s.service)
      const list = byService.get(s.service) ?? []
      // A service the rules inventory covers (any real cell) shows exactly its rules: an alert class seen in its history, whether
      // or not a real cell has the same name, adds nothing. Only a service with no inventory shows what its history has seen.
      if (covered.has(s.service)) continue
      const check = checkOf.get(`${row.origin}\u0000${s.rule}`)
      if (!check && listed.has(`${row.origin}\u0000${s.rule}`)) continue
      if (!list.some((c) => c.name === s.rule)) {
        if (check) list.push({ ...check, id: `${check.id}@${s.service}`, name: s.rule, service: s.service })
        else list.push({ id: `inferred:${s.service}:${s.rule}`, source: 'history', name: s.rule, service: s.service, state: 'inferred' })
      }
      byService.set(s.service, list)
    }
    const health: ServiceHealth[] = []
    for (const [service, list] of [...byService].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      health.push({ service, cells: list.sort(byAttention), firing: firingServices.has(service) ? 1 : 0 })
    }
    const real = cells.filter((c) => c.state !== 'inferred')
    // The oldest evaluation speaks for the rule engines that are polled every few seconds. A check list's runs are hours apart by design
    // (the sweep) and would make the header read hours forever, so they are counted as rules watched but not here.
    const evals = real.filter((c) => !c.checkId).map((c) => c.evaluatedAt).filter((x): x is string => !!x)
    const last = this.db.prepare("SELECT MAX(at) AS at FROM events WHERE alert_key IS NULL AND incident_key IS NOT NULL AND kind IN ('fired','resolved')").get() as { at: string | null }
    const sources = this.sources()
    const header: WallHeader = {
      rulesWatched: real.length,
      // a parked incident is on the wall and counted in `parked`, in no firing or acknowledged tally
      firing: incidents.filter((i) => i.state.firing).length,
      acknowledged: incidents.filter((i) => i.state.attention === 'acked').length,
      parked: incidents.filter(isParked).length,
      oldestEvaluationAt: evals.length ? evals.reduce((m, x) => (x < m ? x : m)) : null,
      lastIncidentAt: last.at,
      stale: sources.some((s) => s.state === 'stale')
    }
    return { generatedAt: this.iso(nowMs), header, sources, incidents, health, channels: this.channelProofs(), ...(this.cfg.wallGroups ? { wallGroups: this.cfg.wallGroups } : {}) }
  }

  channelProofs(): ChannelProof[] {
    return this.cfg.channels.map((c) => {
      const r = this.db
        .prepare("SELECT at, ok, status FROM results WHERE channel_id = ? AND kind = 'test' ORDER BY id DESC LIMIT 1")
        .get(c.id) as { at: number; ok: number; status: string } | undefined
      // A Web Push test that found nobody subscribed could not deliver by construction: the channel is unconfigured, not failing, so
      // lastTestOk is null and the failure audit (it keys watch/channel/<id>/test_failed on lastTestOk === false) does not print it.
      const lastTest = !r ? null : r.ok === 1 ? 'passed' : c.type === 'webpush' && pushUnconfigured(r) ? 'unconfigured' : 'failed'
      return {
        id: c.id,
        type: c.type,
        enabled: !this.disabledChannels.has(c.id),
        lastTestAt: r ? this.iso(r.at) : null,
        lastTestOk: lastTest === 'passed' ? true : lastTest === 'failed' ? false : null,
        lastTest
      }
    })
  }

  incidentDetail(key: string): { incident: Incident | null; alerts: Alert[]; events: AlertEvent[]; resolved: HistoryRow | null; comments: IncidentComment[] } {
    const incident = this.firingIncidents().find((i) => i.key === key) ?? null
    const rows = this.db.prepare('SELECT * FROM alerts WHERE incident_key = ? ORDER BY (state = \'firing\') DESC, last_seen DESC LIMIT 50').all(key) as unknown as AlertRow[]
    const events = (this.db.prepare('SELECT * FROM events WHERE incident_key = ? ORDER BY id DESC LIMIT 100').all(key) as unknown as EventRow[]).map(toEvent)
    const hist = this.history(24 * 30).find((h) => h.incidentKey === key) ?? null
    return { incident, alerts: rows.map((r) => this.toAlert(r, true)), events, resolved: incident ? null : hist, comments: this.comments(key) }
  }

  /**
   * What the incident card reads (src/shared/card.ts, GET /api/incident-card/:ref): the firing incident, else the stored alert rows (without their raw
   * payloads) and the incident's last resolved episode. It reads the one resolved event of this key, not the whole history, because the chat panel asks once per
   * linked incident per view and a channel of alert posts asks for many at once.
   */
  cardSource(key: string): { incident: Incident | null; alerts: Alert[]; resolved: HistoryRow | null } {
    const incident = this.firingIncidents().find((i) => i.key === key) ?? null
    if (incident) return { incident, alerts: [], resolved: null }
    const rows = this.db.prepare('SELECT * FROM alerts WHERE incident_key = ? ORDER BY last_seen DESC LIMIT 50').all(key) as unknown as AlertRow[]
    const ev = this.db
      .prepare("SELECT at, detail FROM events WHERE incident_key = ? AND kind = 'resolved' AND alert_key IS NULL ORDER BY id DESC LIMIT 1")
      .get(key) as { at: string; detail: string } | undefined
    let resolved: HistoryRow | null = null
    if (ev) {
      const d = JSON.parse(ev.detail) as { service?: string; rule?: string; instance?: string; severity?: Severity; origin?: string; startsAt?: string; instances?: number }
      if (d.service && d.rule && d.severity && d.startsAt) {
        resolved = {
          incidentKey: key,
          service: d.service,
          rule: d.rule,
          ...(d.instance ? { instance: d.instance } : {}),
          severity: d.severity,
          source: d.origin ?? '',
          startsAt: d.startsAt,
          resolvedAt: ev.at,
          durationSec: Math.max(0, Math.round((Date.parse(ev.at) - Date.parse(d.startsAt)) / 1000)),
          instances: d.instances ?? 1
        }
      }
    }
    return { incident: null, alerts: rows.map((r) => this.toAlert(r)), resolved }
  }

  alertDetail(key: string): { alert: Alert; events: AlertEvent[] } | null {
    const row = this.db.prepare('SELECT * FROM alerts WHERE key = ?').get(key) as AlertRow | undefined
    if (!row) return null
    const events = (this.db.prepare('SELECT * FROM events WHERE alert_key = ? ORDER BY id DESC LIMIT 100').all(key) as unknown as EventRow[]).map(toEvent)
    return { alert: this.toAlert(row, true), events }
  }

  history(hours: number): HistoryRow[] {
    const since = this.iso(this.nowMs() - hours * 3600_000)
    const rows = this.db
      .prepare("SELECT at, incident_key, detail FROM events WHERE kind = 'resolved' AND alert_key IS NULL AND at >= ? ORDER BY at DESC LIMIT 500")
      .all(since) as Array<{ at: string; incident_key: string; detail: string }>
    const confirmedRows = this.db.prepare("SELECT at, incident_key, detail FROM events WHERE kind = 'confirmed' AND alert_key IS NULL AND at >= ? ORDER BY id ASC").all(since) as Array<{
      at: string
      incident_key: string
      detail: string
    }>
    const confirmed = new Map<string, NonNullable<HistoryRow['confirmed']>>()
    for (const c of confirmedRows) {
      const d = JSON.parse(c.detail) as { by?: unknown; note?: unknown; resolvedAt?: unknown }
      if (typeof d.resolvedAt !== 'string') continue
      confirmed.set(`${c.incident_key}\u0000${d.resolvedAt}`, {
        by: typeof d.by === 'string' ? d.by : 'someone',
        at: c.at,
        ...(typeof d.note === 'string' && d.note !== '' ? { note: d.note } : {})
      })
    }
    return rows.map((r) => {
      const d = JSON.parse(r.detail) as {
        service: string
        rule: string
        instance?: string
        severity: Severity
        origin: string
        startsAt: string
        instances: number
        manual?: boolean
        by?: string
        reason?: string
      }
      const ack = this.ackedIn(r.incident_key, d.startsAt, r.at)
      const done = confirmed.get(`${r.incident_key}\u0000${r.at}`)
      return {
        incidentKey: r.incident_key,
        service: d.service,
        rule: d.rule,
        ...(d.instance ? { instance: d.instance } : {}),
        severity: d.severity,
        source: d.origin,
        startsAt: d.startsAt,
        resolvedAt: r.at,
        durationSec: Math.max(0, Math.round((Date.parse(r.at) - Date.parse(d.startsAt)) / 1000)),
        instances: d.instances,
        ...(ack ? { ackedBy: ack.by, ackedAt: ack.at } : {}),
        ...(d.manual ? { manual: { by: typeof d.by === 'string' ? d.by : 'someone', reason: typeof d.reason === 'string' ? d.reason : '' } } : {}),
        ...(done ? { confirmed: done } : {})
      }
    })
  }

  /**
   * Who had the incident acknowledged when its episode ended, and when: the last ack or unack the incident took between its start and its end,
   * when that last one is an ack. Null when nobody did, or when the acknowledgement was taken off again.
   */
  private ackedIn(incidentKey: string, startsAt: string, endsAt: string): { by: string; at: string } | null {
    const r = this.db
      .prepare("SELECT at, kind, detail FROM events WHERE incident_key = ? AND alert_key IS NULL AND kind IN ('ack','unack') AND at >= ? AND at <= ? ORDER BY id DESC LIMIT 1")
      .get(incidentKey, startsAt, endsAt) as { at: string; kind: string; detail: string } | undefined
    if (!r || r.kind !== 'ack') return null
    const by = (JSON.parse(r.detail) as { by?: unknown }).by
    return { by: typeof by === 'string' && by !== '' ? by : 'someone', at: r.at }
  }

  // ---- what the pager reads -------------------------------------------------------------------------

  notifyViews(): { views: NotifyView[]; resolved: ResolvedView[] } {
    const nowMs = this.nowMs()
    const views: NotifyView[] = this.firingIncidents().map((i) => {
      // The pager speaks for the alerts at the incident's CURRENT severity only. A warning that joins or leaves a page's incident
      // (same service and rule, another host) is not news for the page: it must not change the digest the dedupe compares, or
      // every such change would re-send the page and its SMS and email steps. Prod before dev (routingOrder): the view's origin is the one the pager
      // routes it by (src/server/notify/match.ts), so it names the prod alert whenever one fires at this severity, as the wall's route does.
      const top = this.routingOrder(i.alerts.filter((a) => a.severity === i.severity))
      const labels = commonLabels(top)
      const flap = this.flapState(i.key)
      const first = top[0]
      const firstSeen = top.reduce((m, a) => (a.firstSeen < m ? a.firstSeen : m), top[0].firstSeen)
      const names = instanceLabels(top, [i.rule])
      return {
        key: i.key,
        service: i.service,
        rule: i.rule,
        summary: i.summary,
        severity: i.severity,
        severityLabel: first.severityLabel,
        origin: first.origin,
        labels,
        instances: top.map((a, k) => ({
          fingerprint: a.fingerprint,
          name: names[k].text,
          nameSource: names[k].source,
          value: a.value,
          startsAt: a.startsAt,
          severity: a.severity,
          summary: a.annotations.summary,
          annotations: a.annotations,
          links: a.links,
          generatorURL: a.generatorURL
        })),
        startsAt: i.startsAt,
        firstSeen,
        attention: i.state.attention,
        unattendedSec: unattendedSecOf(i.state, i.ackedAt ? Date.parse(i.ackedAt) : null, nowMs),
        // a park that has ended hands the incident back as a fresh episode: the unattended clock started then, so the pager counts from it too
        freshSince: i.state.unattendedSinceMs > Date.parse(i.startsAt) ? this.iso(i.state.unattendedSinceMs) : null,
        flapping: flap.flapping,
        links: first.links
      }
    })
    const since = this.iso(nowMs - 2 * 3600_000)
    const rows = this.db
      .prepare("SELECT at, incident_key, detail FROM events WHERE kind = 'resolved' AND alert_key IS NULL AND at >= ? ORDER BY at DESC")
      .all(since) as Array<{ at: string; incident_key: string; detail: string }>
    const firing = new Set(views.map((v) => v.key))
    const resolved: ResolvedView[] = []
    for (const r of rows) {
      if (firing.has(r.incident_key)) continue
      const d = JSON.parse(r.detail) as { service: string; rule: string; instance?: string; severity: Severity; origin: string; startsAt: string; imported?: boolean; manual?: boolean }
      // A resolve by hand is not the source saying it cleared, so it sends no "resolved" notice: the write that did it is in the operator log.
      if (d.imported || d.manual) continue
      const notified = this.db.prepare("SELECT 1 AS x FROM results WHERE incident_key = ? AND kind IN ('alert','escalation') AND ok = 1 LIMIT 1").get(r.incident_key)
      resolved.push({
        key: r.incident_key,
        service: d.service,
        rule: d.rule,
        summary: incidentTitle(d),
        severity: d.severity,
        origin: d.origin,
        labels: {},
        startsAt: d.startsAt,
        resolvedAt: r.at,
        durationSec: Math.max(0, Math.round((Date.parse(r.at) - Date.parse(d.startsAt)) / 1000)),
        stableForSec: (nowMs - Date.parse(r.at)) / 1000,
        wasNotified: !!notified,
        ...((): { ackedBy?: string; ackedAt?: string } => {
          const ack = this.ackedIn(r.incident_key, d.startsAt, r.at)
          return ack ? { ackedBy: ack.by, ackedAt: ack.at } : {}
        })()
      })
    }
    return { views, resolved }
  }
}

interface EventRow {
  id: number
  at: string
  kind: EventKind
  alert_key: string | null
  incident_key: string | null
  detail: string
}

function toEvent(r: EventRow): AlertEvent {
  return { id: r.id, at: r.at, kind: r.kind, alertKey: r.alert_key, incidentKey: r.incident_key, detail: JSON.parse(r.detail) as Record<string, unknown> }
}

function definedOnly(links: AlertLinks): AlertLinks {
  return Object.fromEntries(Object.entries(links).filter(([, v]) => v !== undefined && v !== '')) as AlertLinks
}

function commonLabels(alerts: Alert[]): Record<string, string> {
  if (alerts.length === 0) return {}
  const out: Record<string, string> = { ...alerts[0].labels }
  for (const a of alerts.slice(1)) for (const k of Object.keys(out)) if (a.labels[k] !== out[k]) delete out[k]
  return out
}

/**
 * The annotations of a merged alert: the richer channel's win over the poorer one's, as before. The park (PARK_KEYS, src/shared/incident.ts) is the exception: a
 * pushed observation states the whole of it, so what the push leaves out is no longer claimed and the park ends there, instead of living on from the first push
 * because this merge keeps every older key. A feed is a push body read by a poll, so it states the park the same way. Any other polled channel says nothing
 * about a park, so a poll never ends one.
 */
function mergedAnnotations(poor: Record<string, string>, rich: Record<string, string>, incoming: Alert): Record<string, string> {
  const out = { ...poor, ...rich }
  if (incoming.via[0].kind !== 'webhook' && incoming.via[0].kind !== 'feed') return out
  for (const k of PARK_KEYS) {
    const v = incoming.annotations[k]
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out
}
