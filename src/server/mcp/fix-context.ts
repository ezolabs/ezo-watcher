// The fix loop, server side: one brief an agent can act on (`get_fix_context`) and the awaited verification that closes it
// (`verify_fix`). Both read the same engine the wall does; neither writes except through the engine's own confirm path, so a
// verification can never invent a resolution a source did not report.
//
// The brief is the answer to "what do I need to know to fix this without asking a person": what is firing and since when,
// which source and target raised it and how they are configured (a credential is always the env-var NAME, never a value),
// what the rule cell asserted and which predicate the last run failed, where the endpoint was found in the project, the last
// good answer beside the failing one, a command that re-runs the check locally, the other live incidents on the same service,
// and the evidence links the source itself offers. `next` names the loop: fix, restart/deploy, verify.
//
// A brief is bounded on purpose: an agent's context is the scarce resource, so a body is cut, a config is cut, and the lists
// are short. Nothing here carries a token or a secret value.

import { incidentEvidence } from '../../shared/evidence-links.ts'
import type { EvidenceLink } from '../../shared/evidence-links.ts'
import { incidentTitle } from '../../shared/incident.ts'
import { RECHECK_GAP_MS } from '../recheck.ts'
import type { AlertRecheck, RecheckSource } from '../../shared/recheck.ts'
import type { Rechecker } from '../recheck.ts'
import type { WatchConfig } from '../config.ts'
import type { Engine } from '../engine.ts'
import type { Alert, Incident, ParkedState, RuleCell, Severity, SourceDiscovery } from '../../shared/types.ts'
import { incidentUrl } from './shape.ts'

/** A body kept in a brief is cut here: enough to see the shape, never enough to fill a context. */
const BODY_MAX = 1500
/** One config value kept in a brief is cut here. */
const VALUE_MAX = 500
/** Read-only lists stay short. */
const LIST_MAX = 10
/** How long `verify_fix` waits by default, and the bounds it accepts. */
export const VERIFY_DEFAULT_TIMEOUT_SEC = 60
export const VERIFY_MIN_TIMEOUT_SEC = 5
export const VERIFY_MAX_TIMEOUT_SEC = 300
/** The note the confirmation carries, so History reads "verified by agent" and not just "confirmed". */
export const VERIFIED_BY_AGENT = 'verified by agent'

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`)

/** A value for a shell command, single-quoted, so a key or a URL cannot become two arguments. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** A JSON path as jq spells it: `.db.ok`, or `.["x-y"]` for a segment jq cannot take bare. */
export function jqPath(path: string): string {
  return path
    .split('.')
    .map((part) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? `.${part}` : `.[${JSON.stringify(part)}]`))
    .join('')
}

/**
 * Which predicates a failure line falsifies. The sender's own words are the only evidence of which assertion went red, so this
 * matches the failure wording the probe and check senders use; an unrecognized line leaves the list empty, and the brief says
 * `failureDetail` so the agent can read it itself.
 */
export function failingAssertionWords(asserts: readonly string[], detail: string | null | undefined): string[] {
  const d = (detail ?? '').toLowerCase()
  if (d === '') return []
  const failed: string[] = []
  for (const a of asserts) {
    const body = /^body\.([^ =]+) =/.exec(a)
    if (body && d.includes(`${body[1].toLowerCase()} is `)) failed.push(a)
  }
  if (/no answer|timed out|refused|redirect|non-2xx|\bstatus\b|expected \d{3}/.test(d) && asserts[0]) failed.push(asserts[0])
  if (/not json/.test(d)) failed.push('a body that is JSON')
  if (/1 mib|over the cap|body.*over/.test(d)) failed.push('a body of at most 1 MiB')
  return [...new Set(failed)]
}

/** A cell from the incident's own service strip that speaks for one alert. */
export type CellWithInstance = RuleCell & { instance?: string }

/**
 * The cell that speaks for one alert: the same source, the same rule (a pushed check carries its class in `checkId`), and the
 * same target when the cell names one. A failing or pending cell wins over a green one, because that is the reading the agent
 * needs.
 */
export function cellForAlert(cells: readonly CellWithInstance[], alert: Alert): CellWithInstance | null {
  const sources = new Set([alert.origin, ...alert.via.map((v) => v.source)])
  const names = new Set([alert.rule, alert.labels.alertname].filter((x): x is string => typeof x === 'string' && x !== ''))
  const target = targetIdOf(alert)
  const matches = cells.filter((c) => {
    if (!sources.has(c.source)) return false
    if (!names.has(c.name) && !(c.checkId !== undefined && names.has(c.checkId))) return false
    if (target !== null && c.instance !== undefined && c.instance !== target) return false
    return true
  })
  const rank = (c: CellWithInstance): number => (c.state === 'firing' ? 0 : c.state === 'error' ? 1 : c.state === 'nodata' ? 2 : c.state === 'stale' ? 3 : c.state === 'pending' ? 4 : 5)
  return matches.sort((a, b) => rank(a) - rank(b))[0] ?? null
}

/**
 * An alert's stored raw payload. The engine keeps one per source (`{ <source>: <payload> }`), so the source that raised the
 * alert is the one to read; an unwrapped payload is accepted when it has a shape a source writes, which keeps a test's object
 * and an alert recorded before the wrapper readable.
 */
export function rawFor(alert: Alert): Record<string, unknown> | null {
  const raw = alert.raw
  if (raw === null || typeof raw !== 'object') return null
  const wrapped = raw as Record<string, unknown>
  for (const id of [alert.origin, ...alert.via.map((v) => v.source)]) {
    const inner = wrapped[id]
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>
  }
  if ('probe' in wrapped || 'permalink' in wrapped || 'culprit' in wrapped || 'chart' in wrapped || 'alert' in wrapped || 'target' in wrapped) {
    return wrapped
  }
  return null
}

/** The target a probe alert names: its raw target, its instance label, or its host. */
export function targetIdOf(alert: Alert): string | null {
  const raw = rawFor(alert)
  if (raw !== null && typeof raw.target === 'string') return raw.target
  const instance = alert.labels.instance
  if (typeof instance === 'string' && instance !== '') return instance
  return alert.host !== '' ? alert.host : null
}

// ---- the brief -----------------------------------------------------------------------------------------------------------------------------

export interface AssertionBlock {
  /** The alert this reading is about. */
  alert: string
  rule: string
  source: string
  /** The cell's name, or null when the source lists no cell for this rule. */
  cell: string | null
  state: string | null
  /** Every predicate the cell made, in the sender's words (`RuleCell.asserts`). */
  asserts: string[]
  /** The subset the failure line falsifies. Empty when the sender did not say, never a guess. */
  failed: string[]
  /** The failing run's own one line, as the source wrote it. */
  failureDetail: string | null
}

export interface ObservationBlock {
  at: string | null
  status: number | null
  /** The source's own line about this reading. */
  detail: string
  /** A body, cut to BODY_MAX; present only for a probe's last good answer. */
  body?: string
  headers?: Record<string, string>
}

export interface ReproduceBlock {
  /** The one command to run first. */
  command: string
  /** What a green answer looks like. */
  expect: string
  alternatives: Array<{ label: string; command: string; expect: string }>
  /** Ask the Watcher to run the same check itself. */
  watcher: string
  note: string
}

export interface SourceBlock {
  id: string
  kind: string
  state: string
  lastOk: string | null
  lastAttempt: string | null
  error: string | null
  /** The source's config, with every literal secret dropped and every credential left as its env-var name. */
  config: unknown
  /** The one target this alert names, when the source is a prober. */
  target: unknown | null
  /** Where the endpoint was found in the project (`watcher add --found-at`). */
  discovered: SourceDiscovery | null
}

export interface FixContextBrief {
  key: string
  title: string
  summary: string
  service: string
  rule: string
  severity: Severity
  /** The incident's own state: firing, and who has it. */
  state: {
    firing: boolean
    attention: 'none' | 'acked' | 'silenced' | 'parked'
    ackedBy: string | null
    silencedUntil: string | null
    parkedState: ParkedState | null
    parkedUntil: string | null
  }
  firstSeen: string
  lastSeen: string
  startsAt: string
  ageSec: number
  url: string
  /** One per alert, firing first. */
  alerts: Array<{ key: string; rule: string; host: string; severity: Severity; state: 'firing' | 'resolved'; startsAt: string; lastSeen: string; resolvedAt: string | null; value?: string }>
  sources: SourceBlock[]
  asserts: AssertionBlock[]
  observations: { lastGood: ObservationBlock | null; lastBad: ObservationBlock }
  reproduce: ReproduceBlock
  related: Array<{ key: string; title: string; severity: Severity; attention: string; ageSec: number; url: string }>
  evidence: EvidenceLink[]
  /** The source's own evidence, shaped for the kind that raised the alert (Sentry's permalink and culprit, Netdata's chart). */
  sourceEvidence: Record<string, unknown> | null
  next: Array<{ action: string; detail: string }>
}

function bounded(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]'
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => bounded(v, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'raw') continue
      // A credential is kept as the NAME of the variable that holds it (`tokenEnv`, `secretEnv`), never as a value.
      if (/(token|secret|password|passphrase|bearer|api[_-]?key)/i.test(k) && !/env$/i.test(k)) continue
      out[k] = bounded(v, depth + 1)
    }
    return out
  }
  if (typeof value === 'string') return clip(value, VALUE_MAX)
  return value
}

function sourceConfigOf(cfg: WatchConfig, id: string): unknown | null {
  const s = cfg.sources.find((x) => x.id === id)
  return s === undefined ? null : bounded(s)
}

function sourceDiscoveryOf(cfg: WatchConfig, id: string): SourceDiscovery | null {
  const s = cfg.sources.find((x) => x.id === id) as { discovered?: SourceDiscovery } | undefined
  return s?.discovered ?? null
}

/** The probe target this alert names, bounded; null for a source with no targets. */
function targetConfigOf(cfg: WatchConfig, id: string, alert: Alert): unknown | null {
  const source = cfg.sources.find((x) => x.id === id) as { type?: string; targets?: Array<Record<string, unknown>> } | undefined
  if (!source || !Array.isArray(source.targets)) return null
  const target = targetIdOf(alert)
  if (target === null) return null
  const hit = source.targets.find((t) => t.id === target)
  return hit ? bounded(hit) : null
}

function sourceEvidenceOf(alert: Alert): Record<string, unknown> | null {
  const r = rawFor(alert)
  if (r === null) return null
  if (typeof r.permalink === 'string' || typeof r.culprit === 'string') {
    return {
      kind: 'sentry',
      permalink: typeof r.permalink === 'string' ? r.permalink : null,
      culprit: typeof r.culprit === 'string' ? r.culprit : null,
      issueId: typeof r.id === 'string' ? r.id : null,
      shortId: typeof r.shortId === 'string' ? r.shortId : null,
      status: typeof r.status === 'string' ? r.status : null,
      events: typeof r.count === 'number' ? r.count : null,
      users: typeof r.userCount === 'number' ? r.userCount : null
    }
  }
  if (typeof r.chart === 'string' || typeof r.instance === 'string' || typeof r.alert === 'string') {
    return {
      kind: 'netdata',
      chart: typeof r.chart === 'string' ? r.chart : typeof r.instance === 'string' ? r.instance : null,
      node: typeof r.node === 'string' ? r.node : alert.host,
      alert: typeof r.alert === 'string' ? r.alert : alert.rule,
      level: typeof r.level === 'string' ? r.level : null,
      link: alert.generatorURL ?? null
    }
  }
  if (r.probe !== undefined) {
    return { kind: 'probe', target: typeof r.target === 'string' ? r.target : null, url: typeof r.url === 'string' ? r.url : null }
  }
  return null
}

/** The last good answer this Watch kept for a probe target, bounded. In memory only; null when the process has none or the source is not a prober. */
function lastGoodOf(engine: Engine, source: string, target: string | null): ObservationBlock | null {
  if (target === null) return null
  const probes = engine.probesOf(source).filter((p) => p.target === target)
  if (probes.length === 0) return null
  const p = probes.reduce((a, b) => (a.at > b.at ? a : b))
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(p.headers)) if (k === 'content-type' || k === 'server' || k === 'date') headers[k] = clip(v, 200)
  return {
    at: p.at,
    status: p.status,
    detail: `HTTP ${p.status}`,
    body: p.bodyText === null ? '[body not read: over the 1 MiB cap]' : clip(p.bodyText, BODY_MAX),
    headers
  }
}

function lastBadOf(alert: Alert, cell: CellWithInstance | null): ObservationBlock {
  const r = rawFor(alert) ?? {}
  const probe = r.probe !== null && typeof r.probe === 'object' ? (r.probe as Record<string, unknown>) : null
  if (probe) {
    return {
      at: alert.lastSeen,
      status: typeof probe.status === 'number' ? probe.status : null,
      detail: clip(typeof probe.detail === 'string' ? probe.detail : (cell?.detail ?? ''), VALUE_MAX)
    }
  }
  if (typeof r.culprit === 'string' || typeof r.permalink === 'string') {
    const parts = [
      typeof r.culprit === 'string' && r.culprit !== '' ? r.culprit : '',
      typeof r.title === 'string' ? r.title : '',
      typeof r.count === 'number' ? `${r.count} events` : '',
      typeof r.userCount === 'number' ? `${r.userCount} users` : '',
      typeof r.lastSeen === 'string' ? `last event ${r.lastSeen}` : ''
    ].filter((x) => x !== '')
    return { at: alert.lastSeen, status: null, detail: clip(parts.join(' | '), VALUE_MAX) }
  }
  if (typeof r.instance === 'string' || typeof r.alert === 'string') {
    const parts = [
      typeof r.alert === 'string' ? r.alert : alert.rule,
      typeof r.node === 'string' ? `on ${r.node}` : alert.host !== '' ? `on ${alert.host}` : '',
      typeof r.instance === 'string' ? `chart ${r.instance}` : '',
      typeof r.level === 'string' ? `level ${r.level}` : ''
    ].filter((x) => x !== '')
    return { at: alert.lastSeen, status: null, detail: clip(parts.join(' '), VALUE_MAX) }
  }
  return { at: alert.lastSeen, status: null, detail: clip(cell?.detail ?? alert.value ?? alert.annotations.summary ?? alert.rule, VALUE_MAX) }
}

/** The command(s) that re-run this alert's check from a terminal, and what a green answer looks like. */
function reproduceOf(key: string, cfg: WatchConfig, alert: Alert): ReproduceBlock {
  const watcher = `watcher recheck ${shellQuote(key)} --wait --json`
  const source = cfg.sources.find((s) => s.id === alert.origin || alert.via.some((v) => v.source === s.id)) as
    | { type: string; url?: string; webUrl?: string; org?: string; tokenEnv?: string; targets?: Array<Record<string, unknown>> }
    | undefined
  const target = source && Array.isArray(source.targets) ? source.targets.find((t) => t.id === targetIdOf(alert)) : undefined
  if (source?.type === 'http-probe' && target && typeof target.url === 'string') {
    const probeUrl = target.url
    const timeoutSec = Math.max(1, Math.min(120, Math.ceil(Number(target.timeoutMs ?? 10_000) / 1000)))
    const expectStatus = typeof target.expectStatus === 'number' ? target.expectStatus : 200
    const statusCommand = `curl -sS -o /dev/null -w '%{http_code}\\n' -m ${timeoutSec} ${shellQuote(probeUrl)}`
    const expectJson = target.expectJson !== null && typeof target.expectJson === 'object' ? (target.expectJson as Record<string, unknown>) : {}
    const paths = Object.keys(expectJson).slice(0, 5)
    const jsonCommands = paths.map((path) => ({
      label: `body.${path}`,
      command: `curl -sS -m ${timeoutSec} ${shellQuote(probeUrl)} | jq ${shellQuote(jqPath(path))}`,
      expect: JSON.stringify(expectJson[path])
    }))
    const primary = jsonCommands[0]
    return {
      command: primary?.command ?? statusCommand,
      expect: primary?.expect ?? String(expectStatus),
      alternatives: primary ? [{ label: 'status', command: statusCommand, expect: String(expectStatus) }, ...jsonCommands.slice(1)] : [],
      watcher,
      note: `The probe GETs the URL with redirects not followed and expects HTTP ${expectStatus}${paths.length > 0 ? ` and ${paths.join(', ')} as configured` : ''}. A green answer is what Watch reads as ok; the same check runs through the Watcher with the command at \`watcher\`.`
    }
  }
  if (source?.type === 'tcp-probe' && target && typeof target.host === 'string' && typeof target.port === 'number') {
    const timeoutSec = Math.max(1, Math.min(120, Math.ceil(Number(target.timeoutMs ?? 10_000) / 1000)))
    const command =
      target.tls === true
        ? `openssl s_client -connect ${shellQuote(`${target.host}:${target.port}`)} -servername ${shellQuote(target.host)} </dev/null 2>/dev/null | openssl x509 -noout -enddate`
        : `nc -zv -w ${timeoutSec} ${shellQuote(target.host)} ${target.port}`
    return {
      command,
      expect: target.tls === true ? 'a certificate with a notAfter later than the warning window' : 'the connect succeeds ("succeeded" or "open")',
      alternatives: [],
      watcher,
      note: `The tcp-probe connects to ${target.host}:${target.port}${target.tls === true ? ' and reads the certificate the TLS handshake presents' : ''}.`
    }
  }
  const orgId = source?.['org']
  if (source?.type === 'sentry' && typeof source.url === 'string' && typeof orgId === 'string' && typeof source.tokenEnv === 'string') {
    const raw = rawFor(alert) ?? {}
    const issue = typeof raw.id === 'string' ? raw.id : null
    const api = source.url.replace(/\/+$/, '')
    const org = encodeURIComponent(orgId)
    const base = `${api}/api/0/organizations/${org}/issues/?query=is:unresolved`
    const filter = issue === null ? '.' : `.[] | select(.id == ${JSON.stringify(issue)}) | .status`
    const command = `curl -sS -H "Authorization: Bearer $${source.tokenEnv}" ${shellQuote(base)} | jq ${shellQuote(filter)}`
    return {
      command,
      expect: issue === null ? 'the issue in the list' : '"unresolved" while the issue is still there; no output once it has left the unresolved list (the alert then resolves)',
      alternatives: [],
      watcher,
      note: `The bearer token is read from $${source.tokenEnv}; no value is printed. The Sentry poll makes the same query and resolves the alert when the issue leaves it.`
    }
  }
  return {
    command: watcher,
    expect: 'the alert resolved, or the source still reports it firing',
    alternatives: [],
    watcher,
    note:
      source?.type === 'webhook' || source === undefined
        ? 'A pushing sender cannot be polled by Watch. `watcher recheck` asks a sender that takes re-check requests to run its check; one that does not is re-read when it next pushes.'
        : 'The source has no local check to copy; `watcher recheck` runs Watch\'s own poll of it.'
  }
}

/**
 * The assertions of every alert of the incident, firing first, and which predicate the last run failed. A resolved incident
 * has no live `cells` of its own, so the service's cells on the wall are the fallback: after a green verification an agent must
 * still be able to read what the check asserted, now `ok`.
 */
export function assertionsFor(engine: Engine, key: string): AssertionBlock[] {
  const detail = engine.incidentDetail(key)
  const service = detail.incident?.service ?? detail.alerts[0]?.service ?? ''
  const cells = (detail.incident?.cells ?? engine.wall().health.find((h) => h.service === service)?.cells ?? []) as CellWithInstance[]
  const ordered = [...detail.alerts].sort((a, b) => Number(a.resolvedAt !== null) - Number(b.resolvedAt !== null))
  return ordered.slice(0, LIST_MAX).map((a) => {
    const cell = cellForAlert(cells, a)
    const detailLine = cell?.detail ?? null
    return {
      alert: a.key,
      rule: a.rule,
      source: a.origin,
      cell: cell?.name ?? null,
      state: cell?.state ?? null,
      asserts: cell?.asserts ?? [],
      failed: failingAssertionWords(cell?.asserts ?? [], detailLine),
      failureDetail: detailLine
    }
  })
}

export interface FixContextDeps {
  engine: Engine
  cfg: WatchConfig
  nowMs: () => number
}

/**
 * The brief for one incident. `{ok:false}` names a key the Watcher has never held, so the caller can answer with the same
 * sentence every other tool uses rather than an empty document.
 */
export function fixContextOf(key: string, d: FixContextDeps): { ok: true; brief: FixContextBrief } | { ok: false; error: string } {
  const detail = d.engine.incidentDetail(key)
  if (!detail.incident && detail.alerts.length === 0) {
    return { ok: false, error: `no incident ${key}. Use watch_state or list_incidents for the keys the Watcher has.` }
  }
  const nowMs = d.nowMs()
  const firing = detail.alerts.filter((a) => a.resolvedAt === null)
  const alert = firing[0] ?? detail.alerts[0]
  const incident: Incident | null = detail.incident
  const firstSeen = detail.alerts.reduce((m, a) => (a.firstSeen < m ? a.firstSeen : m), alert.firstSeen)
  const lastSeen = detail.alerts.reduce((m, a) => (a.lastSeen > m ? a.lastSeen : m), alert.lastSeen)
  const cells = (incident?.cells ?? []) as CellWithInstance[]
  const cell = cellForAlert(cells, alert)
  const asserts = assertionsFor(d.engine, key)
  const sourceIds = [...new Set([alert.origin, ...alert.via.map((v) => v.source)])]
  const statuses = d.engine.sources()
  const sources: SourceBlock[] = sourceIds.slice(0, 4).map((id) => {
    const status = statuses.find((s) => s.id === id)
    return {
      id,
      kind: status?.kind ?? alert.via.find((v) => v.source === id)?.kind ?? 'webhook',
      state: status?.state ?? 'idle',
      lastOk: status?.lastOk ?? null,
      lastAttempt: status?.lastAttempt ?? null,
      error: status?.error ?? null,
      config: sourceConfigOf(d.cfg, id),
      target: targetConfigOf(d.cfg, id, alert),
      discovered: sourceDiscoveryOf(d.cfg, id)
    }
  })
  // The last good answer comes from the probe source that raised the alert; a sentry or netdata alert has no probe answer to show.
  const probeSource = sources.find((s) => s.kind === 'http-probe' || s.kind === 'tcp-probe')
  const target = targetIdOf(alert)
  const related = d.engine
    .wall()
    .incidents.filter((i) => i.key !== key && i.state.firing && i.service.toLowerCase() === (incident?.service ?? alert.service).toLowerCase())
    .slice(0, LIST_MAX)
    .map((i) => ({
      key: i.key,
      title: incidentTitle(i),
      severity: i.severity,
      attention: i.state.attention,
      ageSec: Math.max(0, Math.round((nowMs - Date.parse(i.startsAt)) / 1000)),
      url: incidentUrl(d.cfg.baseUrl, i.key)
    }))
  const title = incident ? incidentTitle(incident) : alert.annotations.summary ?? alert.rule
  const summary = incident?.summary ?? alert.annotations.summary ?? alert.rule
  const service = incident?.service ?? alert.service
  const state = incident?.state
  const brief: FixContextBrief = {
    key,
    title,
    summary: clip(summary, VALUE_MAX),
    service,
    rule: incident?.rule ?? alert.rule,
    severity: incident?.severity ?? alert.severity,
    state: {
      firing: incident !== null && firing.length > 0,
      attention: state?.attention ?? 'none',
      ackedBy: incident?.ackedBy ?? null,
      silencedUntil: incident?.silencedUntil ?? null,
      parkedState: state?.park?.state ?? null,
      parkedUntil: state?.park?.until ?? null
    },
    firstSeen,
    lastSeen,
    startsAt: incident?.startsAt ?? alert.startsAt,
    ageSec: Math.max(0, Math.round((nowMs - Date.parse(incident?.startsAt ?? alert.startsAt)) / 1000)),
    url: incidentUrl(d.cfg.baseUrl, key),
    alerts: detail.alerts.slice(0, LIST_MAX).map((a) => ({
      key: a.key,
      rule: a.rule,
      host: a.host,
      severity: a.severity,
      state: a.resolvedAt === null ? 'firing' : 'resolved',
      startsAt: a.startsAt,
      lastSeen: a.lastSeen,
      resolvedAt: a.resolvedAt,
      ...(a.value !== undefined ? { value: clip(a.value, 200) } : {})
    })),
    sources,
    asserts,
    observations: {
      lastGood: probeSource ? lastGoodOf(d.engine, probeSource.id, target) : null,
      lastBad: lastBadOf(alert, cell)
    },
    reproduce: reproduceOf(key, d.cfg, alert),
    related,
    evidence: incidentEvidence(firing.length > 0 ? firing : detail.alerts.slice(0, 1)),
    sourceEvidence: sourceEvidenceOf(alert),
    next: [
      {
        action: 'fix',
        detail: `Change the cause ${service !== '' ? `of ${service} / ${alert.rule}` : `of ${alert.rule}`}. The assertions in this brief are what the source checked; the one in \`asserts.failed\` is the one the last run falsified.`
      },
      {
        action: 'restart-or-deploy',
        detail: 'Make the fix live: restart or redeploy the service or collector the source reads, then let its next poll run. A source that caches its evaluation window can keep reporting the old result for a while; `awaiting_source` is the park state for that gap.'
      },
      {
        action: 'verify',
        detail: `Run the MCP tool verify_fix with { key: ${JSON.stringify(key)}, by: "agent: <you>" } (or \`watcher recheck ${shellQuote(key)} --wait\`). It re-checks now, waits up to ${VERIFY_DEFAULT_TIMEOUT_SEC} s for the fresh observation, and when every alert of the incident is resolved it records "resolution confirmed by <you>" with the note "${VERIFIED_BY_AGENT}".`
      }
    ]
  }
  return { ok: true, brief }
}

// ---- verify_fix ----------------------------------------------------------------------------------------------------------------------------

export interface VerifyObservation {
  at: string
  key: string
  state: 'firing' | 'resolved'
  alerts: Array<{ key: string; rule: string; state: 'firing' | 'resolved'; startsAt: string; resolvedAt: string | null; lastSeen: string }>
  /** What each re-check answered, the last round first. */
  rechecks: Array<{
    key: string
    at: string
    before: 'firing' | 'resolved'
    after: 'firing' | 'resolved'
    sources: RecheckSource[]
    pushed: AlertRecheck['pushed']
  }>
}

export interface VerifyResult {
  key: string
  resolved: boolean
  /** The deadline passed with at least one alert still firing. */
  timedOut: boolean
  at: string
  /** How many re-check rounds ran (0 when the incident was already resolved). */
  rounds: number
  observation: VerifyObservation
  asserts: AssertionBlock[]
  /** The confirmation recorded on a green answer; null when the incident was still firing or the source's resolve did not back a confirmation. */
  confirmation: { at: string; resolvedAt: string; note: string } | null
  /** Why a green answer could not be confirmed (a manual resolve a source still holds), when that happened. */
  confirmationError: string | null
  next: string[]
}

export interface VerifyDeps {
  engine: Engine
  /** Absent: `verify_fix` refuses, as `recheck` does. */
  recheck?: Rechecker
  nowMs: () => number
  /** Test seam; the real one waits in real time. */
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const clampTimeout = (n: number | undefined): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : VERIFY_DEFAULT_TIMEOUT_SEC
  return Math.min(VERIFY_MAX_TIMEOUT_SEC, Math.max(VERIFY_MIN_TIMEOUT_SEC, v))
}

/**
 * Re-check every firing alert of an incident, wait for the source's fresh answer, and when the whole incident is resolved
 * record the confirmation that closes the fix loop. Never resolves an alert itself: `verify_fix` is a check, and only the
 * source (or a person's `resolve`) ends an alert.
 */
export async function verifyFix(
  d: VerifyDeps,
  key: string,
  by: string,
  opts: { timeoutSec?: number; note?: string } = {}
): Promise<{ ok: true; result: VerifyResult } | { ok: false; error: string }> {
  if (!d.recheck) return { ok: false, error: 're-check is not available on this Watch' }
  const first = d.engine.incidentDetail(key)
  if (!first.incident && first.alerts.length === 0) {
    return { ok: false, error: `no incident ${key}. Use watch_state or list_incidents for the keys the Watcher has.` }
  }
  const timeoutSec = clampTimeout(opts.timeoutSec)
  const deadline = d.nowMs() + timeoutSec * 1000
  const sleep = d.sleep ?? realSleep
  const answers: AlertRecheck[] = []
  let rounds = 0
  let timedOut = false
  for (;;) {
    const firing = d.engine.incidentDetail(key).alerts.filter((a) => a.resolvedAt === null)
    if (firing.length === 0) break
    const round = (await Promise.all(firing.slice(0, LIST_MAX).map((a) => d.recheck!.alert(a.key, { via: 'mcp', by })))).filter(
      (x): x is AlertRecheck => x !== null
    )
    answers.splice(0, answers.length, ...round)
    rounds += 1
    if (d.engine.incidentDetail(key).alerts.every((a) => a.resolvedAt !== null)) break
    const waitMs = Math.min(RECHECK_GAP_MS + 500, deadline - d.nowMs())
    if (waitMs <= 0) {
      timedOut = true
      break
    }
    await sleep(waitMs)
    if (d.nowMs() >= deadline && d.engine.incidentDetail(key).alerts.some((a) => a.resolvedAt === null)) {
      timedOut = true
      break
    }
  }
  const at = new Date(d.nowMs()).toISOString()
  const fresh = d.engine.incidentDetail(key)
  const stillFiring = fresh.alerts.filter((a) => a.resolvedAt === null)
  const resolved = stillFiring.length === 0 && fresh.alerts.length > 0
  let confirmation: VerifyResult['confirmation'] = null
  let confirmationError: string | null = null
  if (resolved) {
    const note = opts.note ?? VERIFIED_BY_AGENT
    const c = d.engine.confirmResolution(key, by, note)
    if (c.ok) {
      confirmation = { at: c.at, resolvedAt: c.resolvedAt, note }
      d.log?.(`verify_fix ${by} on ${key}: confirmed (${note})`)
    } else {
      confirmationError = c.error
      d.log?.(`verify_fix ${by} on ${key}: resolved but not confirmed (${c.error})`)
    }
  } else {
    d.log?.(`verify_fix ${by} on ${key}: still firing after ${rounds} re-check round${rounds === 1 ? '' : 's'}${timedOut ? ' (timed out)' : ''}`)
  }
  const observation: VerifyObservation = {
    at,
    key,
    state: resolved ? 'resolved' : 'firing',
    alerts: fresh.alerts.slice(0, LIST_MAX).map((a) => ({
      key: a.key,
      rule: a.rule,
      state: a.resolvedAt === null ? 'firing' : 'resolved',
      startsAt: a.startsAt,
      resolvedAt: a.resolvedAt,
      lastSeen: a.lastSeen
    })),
    rechecks: answers.slice(0, LIST_MAX).map((r) => ({
      key: r.key,
      at: r.at,
      before: r.before,
      after: r.after,
      sources: r.sources,
      pushed: r.pushed
    }))
  }
  return {
    ok: true,
    result: {
      key,
      resolved,
      timedOut,
      at,
      rounds,
      observation,
      asserts: assertionsFor(d.engine, key),
      confirmation,
      confirmationError,
      next: resolved
        ? confirmation
          ? ['The incident is closed and the confirmation is in History. Comment the fix (MCP `comment`) if it is not written down, and keep the park/silence off it.']
          : [`The incident is resolved, but the confirmation was refused: ${confirmationError}. Read get_fix_context before repeating a write; the episode may be a manual resolve a source still holds.`]
        : [
            `The source still reports ${stillFiring.length} alert${stillFiring.length === 1 ? '' : 's'} firing after ${rounds} re-check round${rounds === 1 ? '' : 's'}${timedOut ? ` (waited ${timeoutSec} s)` : ''}. Read get_fix_context: the failing assertion is the one to fix, and a fix that is live but not yet visible can be parked as awaiting_source.`
          ]
    }
  }
}
