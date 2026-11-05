// What the MCP read tools answer, shaped from the engine's own views. Pure: every function takes plain data and returns plain data, so the
// shapes are provable without a server. Nothing here carries a raw payload, a token or a secret value: an alert's `raw` is left out.

import { evidenceLinks, incidentEvidence } from '../../shared/evidence-links.ts'
import type { EvidenceLink } from '../../shared/evidence-links.ts'
import { incidentTitle, unattendedSecOf } from '../../shared/incident.ts'
import { isAgentName, resolutionText } from '../../shared/agent.ts'
import { eventLine } from '../../shared/event-text.ts'
export { eventLine } from '../../shared/event-text.ts'
export type { EventLine } from '../../shared/event-text.ts'
import type { Alert, AlertEvent, Attention, HistoryRow, Incident, IncidentComment, ParkedState, Severity, SourceStatus, WallState } from '../../shared/types.ts'

/** The link a person opens to see the incident on the wall. */
export const incidentUrl = (baseUrl: string, key: string): string => `${baseUrl.replace(/\/+$/, '')}/#/i/${encodeURIComponent(key)}`

export interface IncidentRow {
  key: string
  title: string
  summary: string
  service: string
  severity: Severity
  /** none (nobody has it), acked, silenced or parked (an open triage verdict that is not due yet: not live, never paged). */
  attention: Attention
  ackedBy: string | null
  ackedAt: string | null
  silencedUntil: string | null
  silencedBy: string | null
  silenceCarried: boolean
  /** While parked: why (`deferred`, `fixed_undeployed` or `awaiting_source`), when the park ends, when it began, the ticket, the sender's or parker's one line, and who parked it by hand (null for a park the sweep states). All null when the incident is not parked. */
  parkedState: ParkedState | null
  parkedUntil: string | null
  parkedSince: string | null
  parkedRef: string | null
  parkedNote: string | null
  parkedBy: string | null
  startsAt: string
  ageSec: number
  /** Seconds nobody has had it: none while silenced or parked, frozen at an acknowledgement, counted from the end of a park that ended. */
  unattendedSec: number
  instances: number
  /** The systems that raised the firing alerts, and the hosts they name (at most 5). */
  origins: string[]
  hosts: string[]
  comments: number
  url: string
}

export function incidentRow(i: Incident, nowMs: number, comments: number, baseUrl: string): IncidentRow {
  return {
    key: i.key,
    title: incidentTitle(i),
    summary: i.summary,
    service: i.service,
    severity: i.severity,
    attention: i.state.attention,
    ackedBy: i.ackedBy,
    ackedAt: i.ackedAt,
    silencedUntil: i.silencedUntil,
    silencedBy: i.silencedBy,
    silenceCarried: i.silenceCarried,
    parkedState: i.state.park?.state ?? null,
    parkedUntil: i.state.park?.until ?? null,
    parkedSince: i.state.park?.since ?? null,
    parkedRef: i.state.park?.ref ?? null,
    parkedNote: i.state.park?.note ?? null,
    parkedBy: i.state.park?.by ?? null,
    startsAt: i.startsAt,
    ageSec: Math.max(0, Math.round((nowMs - Date.parse(i.startsAt)) / 1000)),
    unattendedSec: Math.round(unattendedSecOf(i.state, i.ackedAt ? Date.parse(i.ackedAt) : null, nowMs)),
    instances: i.alerts.length,
    origins: [...new Set(i.alerts.map((a) => a.origin))].sort(),
    hosts: [...new Set(i.alerts.map((a) => a.host).filter((h) => h !== ''))].slice(0, 5),
    comments,
    url: incidentUrl(baseUrl, i.key)
  }
}

export interface SourceRow {
  id: string
  kind: string
  state: string
  lastOk: string | null
  lastAttempt: string | null
  error: string | null
  /** Why this source is not started on this host (an optional source whose credential env is unset): `missing <ENV>`. Absent on a source that runs. */
  skipped?: string
  firing: number
  rules: number
  misses: number
  /** How many of this source's cells assert more than that something answered (0: nothing of it is proven to go red). Absent on a server that predates it. */
  asserted?: number
  /** Where this source's endpoint was found (config `discovered`), when it records one. Absent: the source is untraced. */
  discovered?: SourceStatus['discovered']
  /** A pushing source that promised a schedule: the longest it may stay silent before it reads stale. */
  staleAfterSec?: number
}

export function sourceRow(s: SourceStatus): SourceRow {
  return {
    id: s.id,
    kind: s.kind,
    state: s.state,
    lastOk: s.lastOk,
    lastAttempt: s.lastAttempt,
    error: s.error,
    ...(s.skipped !== undefined ? { skipped: s.skipped } : {}),
    firing: s.firing,
    rules: s.rules,
    misses: s.misses,
    ...(s.asserted !== undefined ? { asserted: s.asserted } : {}),
    ...(s.discovered ? { discovered: s.discovered } : {}),
    ...(s.staleAfterSec !== undefined ? { staleAfterSec: s.staleAfterSec } : {})
  }
}

/** The wall as one answer: counts, the firing incidents, and how healthy the sources are. The proof-of-watch cells are left out: `list_sources` has the counts. */
export function summarizeWall(wall: WallState, commentCounts: ReadonlyMap<string, number>, baseUrl: string) {
  const nowMs = Date.parse(wall.generatedAt)
  const rows = wall.incidents.map((i) => incidentRow(i, nowMs, commentCounts.get(i.key) ?? 0, baseUrl))
  const count = (f: (r: IncidentRow) => boolean): number => rows.filter(f).length
  const unhealthy = wall.sources.filter((s) => s.state === 'stale' || s.state === 'error')
  // A configured optional source this host did not start is not answering either: its absence is named in the rollup and
  // in the text, never read as "Every source is answering" (list_sources and the Sources page carry the same reason).
  const skipped = wall.sources.flatMap((s) => (s.skipped === undefined ? [] : [{ id: s.id, reason: s.skipped }]))
  // A parked incident is a row (an agent can read why) but in no tally of what is live: not firing, not unattended, not in the severity counts.
  const live = (r: IncidentRow): boolean => r.attention !== 'parked'
  const counts = {
    firing: count(live),
    unattended: count((r) => r.attention === 'none'),
    acknowledged: count((r) => r.attention === 'acked'),
    silenced: count((r) => r.attention === 'silenced'),
    parked: count((r) => r.attention === 'parked'),
    page: count((r) => live(r) && r.severity === 'page'),
    warning: count((r) => live(r) && r.severity === 'warning'),
    info: count((r) => live(r) && r.severity === 'info')
  }
  const parts = [`${counts.firing} firing`]
  if (counts.firing > 0) parts.push(`${counts.unattended} unattended, ${counts.acknowledged} acknowledged, ${counts.silenced} silenced`, `${counts.page} page, ${counts.warning} warning, ${counts.info} info`)
  if (counts.parked > 0) parts.push(`${counts.parked} parked (not live: an open verdict that is not due yet)`)
  const clear = wall.header.stale
    ? 'A source has gone quiet, so an all clear is not earned.'
    : skipped.length === 0
      ? 'Every source is answering.'
      : `${skipped.length} ${skipped.length === 1 ? 'source is' : 'sources are'} not started on this host (${skipped.map((s) => `${s.id}: ${s.reason}`).join('; ')}), so not every source is answering.`
  return {
    generatedAt: wall.generatedAt,
    text: `${parts.join('; ')}. ${clear}`,
    counts,
    header: wall.header,
    incidents: rows,
    sources: {
      total: wall.sources.length,
      ok: wall.sources.filter((s) => s.state === 'ok').length,
      skipped,
      needAttention: unhealthy.map(sourceRow)
    }
  }
}

export type StateFilter = 'firing' | 'unattended' | 'acknowledged' | 'silenced' | 'parked' | 'resolved' | 'all'

export interface IncidentFilter {
  state: StateFilter
  severity?: Severity
  /** Case-insensitive substring of the service name. */
  service?: string
  /** A source id or the system that raised the alert (grafana, prod, sweep, netdata-cloud). */
  source?: string
}

const includes = (hay: string, needle: string | undefined): boolean => needle === undefined || needle.trim() === '' || hay.toLowerCase().includes(needle.trim().toLowerCase())

/** The firing rows a filter keeps. `resolved` keeps none: those are history rows. `firing` is the live ones, so it leaves the parked out; `parked` keeps only those; `all` keeps every row. */
export function filterFiring(rows: readonly IncidentRow[], incidents: readonly Incident[], f: IncidentFilter): IncidentRow[] {
  if (f.state === 'resolved') return []
  const viaOf = new Map(incidents.map((i) => [i.key, new Set(i.alerts.flatMap((a) => [a.origin, ...a.via.map((v) => v.source)]))]))
  return rows.filter((r) => {
    if (f.state === 'firing' && r.attention === 'parked') return false
    if (f.state === 'unattended' && r.attention !== 'none') return false
    if (f.state === 'acknowledged' && r.attention !== 'acked') return false
    if (f.state === 'silenced' && r.attention !== 'silenced') return false
    if (f.state === 'parked' && r.attention !== 'parked') return false
    if (f.severity !== undefined && r.severity !== f.severity) return false
    if (!includes(r.service, f.service)) return false
    if (f.source !== undefined && f.source.trim() !== '' && ![...(viaOf.get(r.key) ?? [])].some((s) => s.toLowerCase() === f.source!.trim().toLowerCase())) return false
    return true
  })
}

export interface HistoryOut extends HistoryRow {
  title: string
  /** How the episode ended, in words: a source's resolve, or a person's or an agent's by hand. */
  endedBy: string
  url?: string
}

export function historyOut(h: HistoryRow, baseUrl?: string): HistoryOut {
  const ended = h.manual ? resolutionText('resolved-manual', h.manual.by, h.manual.reason) : `Resolved by its source (${h.source})`
  return { ...h, title: incidentTitle(h), endedBy: h.confirmed ? `${ended}. ${resolutionText('confirmed', h.confirmed.by, h.confirmed.note)}` : ended, ...(baseUrl ? { url: incidentUrl(baseUrl, h.incidentKey) } : {}) }
}

/** Resolved rows a filter keeps (severity, service, source). */
export function filterHistory(rows: readonly HistoryRow[], f: IncidentFilter): HistoryRow[] {
  return rows.filter((h) => {
    if (f.severity !== undefined && h.severity !== f.severity) return false
    if (!includes(h.service, f.service)) return false
    if (f.source !== undefined && f.source.trim() !== '' && h.source.toLowerCase() !== f.source.trim().toLowerCase()) return false
    return true
  })
}

export interface AlertOut {
  key: string
  rule: string
  host: string
  severity: Severity
  state: 'firing' | 'resolved'
  startsAt: string
  resolvedAt: string | null
  labels: Record<string, string>
  annotations: Record<string, string>
  value?: string
  /** The sources that report it, and when each last did. */
  seenBy: Array<{ source: string; lastSeen: string }>
  evidence: EvidenceLink[]
}

export function alertOut(a: Alert): AlertOut {
  return {
    key: a.key,
    rule: a.rule,
    host: a.host,
    severity: a.severity,
    state: a.resolvedAt ? 'resolved' : 'firing',
    startsAt: a.startsAt,
    resolvedAt: a.resolvedAt,
    labels: a.labels,
    annotations: a.annotations,
    ...(a.value !== undefined ? { value: a.value } : {}),
    seenBy: a.via.map((v) => ({ source: v.source, lastSeen: v.lastSeen })),
    evidence: evidenceLinks(a)
  }
}

export interface IncidentDetailIn {
  incident: Incident | null
  alerts: Alert[]
  events: AlertEvent[]
  resolved: HistoryRow | null
  comments: IncidentComment[]
}

/** One incident, whole: its alerts with labels and evidence, who acknowledged and silenced it, its history and its comments. `notifications` is the pager's last sends. */
export function incidentOut(key: string, d: IncidentDetailIn, nowMs: number, baseUrl: string, notifications: unknown[]) {
  const firing = d.alerts.filter((a) => !a.resolvedAt)
  const row = d.incident ? incidentRow(d.incident, nowMs, d.comments.length, baseUrl) : null
  return {
    key,
    state: d.incident ? ('firing' as const) : ('resolved' as const),
    url: incidentUrl(baseUrl, key),
    incident: row,
    acknowledgement: d.incident?.ackedBy ? { by: d.incident.ackedBy, at: d.incident.ackedAt } : null,
    silence: d.incident?.silencedUntil ? { by: d.incident.silencedBy, until: d.incident.silencedUntil, carriedFromPreviousEpisode: d.incident.silenceCarried } : null,
    park: d.incident?.state.park ?? null,
    resolution: d.resolved ? historyOut(d.resolved, baseUrl) : null,
    evidence: incidentEvidence((firing.length ? firing : d.alerts.slice(0, 1)) as Alert[]),
    alerts: d.alerts.map(alertOut),
    history: d.events.map((e) => eventLine(e)),
    comments: d.comments.map((c) => ({ id: c.id, by: c.by, agent: isAgentName(c.by), at: c.createdAt, text: c.text })),
    notifications
  }
}

// ---- time ranges ---------------------------------------------------------------------------------------------------------------------------

/** The Watcher keeps 30 days of history, so a range reaches back at most this far. */
export const HISTORY_MAX_HOURS = 24 * 30

export type RangeCheck = { ok: true; fromMs: number; toMs: number; hours: number } | { ok: false; error: string }

/**
 * The range an `incident_history` call asks for: `from` and `to` as ISO times, or `hours` back from now (24 by default). `to` defaults to now,
 * `from` to `hours` before `to`. A `from` older than the 30 days the Watcher keeps is cut to them, and `hours` says how far back the answer reaches.
 */
export function historyRange(a: { from?: string; to?: string; hours?: number }, nowMs: number): RangeCheck {
  const parse = (v: string | undefined, what: string): number | null | string => {
    if (v === undefined || v.trim() === '') return null
    const ms = Date.parse(v)
    return Number.isNaN(ms) ? `${what} is not an ISO time: ${v.slice(0, 40)}` : ms
  }
  const to = parse(a.to, 'to')
  if (typeof to === 'string') return { ok: false, error: to }
  const from = parse(a.from, 'from')
  if (typeof from === 'string') return { ok: false, error: from }
  const toMs = to ?? nowMs
  const asked = from ?? toMs - (a.hours ?? 24) * 3600_000
  if (asked >= toMs) return { ok: false, error: 'the range is empty: from must be before to' }
  const floor = nowMs - HISTORY_MAX_HOURS * 3600_000
  const fromMs = Math.max(asked, floor)
  if (toMs <= floor) return { ok: false, error: `Watch keeps ${HISTORY_MAX_HOURS / 24} days of history; that range is older` }
  return { ok: true, fromMs, toMs, hours: Math.min(HISTORY_MAX_HOURS, Math.ceil((nowMs - fromMs) / 3600_000)) }
}
