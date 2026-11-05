// Grafana source: the embedded Alertmanager's active alerts plus the rule inventory, in one poll.
//
// Wire shapes, both retrieved 2026-10-14:
//  - alerts: Alertmanager v2 GettableAlert (prometheus/alertmanager api/v2/openapi.yaml). There is no
//    'firing' state: status.state 'active' means firing, 'suppressed' means silenced or inhibited.
//  - rules: Grafana's Prometheus-compatible GET /api/prometheus/grafana/api/v1/rules, recorded in
//    test/fixtures/grafana-rules.json.
// Link forms follow Grafana's own notification templates (grafana/alerting templates/template_data.go):
// /d/<dashboardUid>, ?viewPanel=<panelId>, /alerting/silence/new, /alerting/grafana/<ruleUid>/view.

import type { Alert, AlertLinks, AlertStatus, AmState, CellState, Observation, RuleCell } from '../../shared/types.ts'
import { secret } from '../config.ts'
import type { GrafanaSourceConfig } from '../config.ts'
import { deriveService, makeAlert } from '../derive.ts'
import type { PolledSource, SourceDeps } from './types.ts'
import {
  isDeadMansPing,
  getJson,
  isoOrNull,
  isRecord,
  parseJsonRecord,
  ruleNameOf,
  safeUrl,
  stringMap,
  trimSlash,
  valueText
} from './shared.ts'

const ALERTS_PATH = '/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=true&inhibited=true'
const RULES_PATH = '/api/prometheus/grafana/api/v1/rules'
const AM_STATES = new Set<string>(['unprocessed', 'active', 'suppressed'])
const HOUR_MS = 3_600_000

interface RuleInfo {
  uid: string | undefined
  name: string
  folder: string
  group: string
  intervalSec: number | undefined
  state: string
  health: string
  paused: boolean
  labels: Record<string, string>
  lastEvaluation: string | undefined
  instanceStates: string[]
  query: string | undefined
}

interface RuleIndex {
  byUid: Map<string, RuleInfo>
  byName: Map<string, RuleInfo[]>
}

export function createGrafanaSource(cfg: GrafanaSourceConfig, deps: SourceDeps): PolledSource {
  const apiBase = trimSlash(cfg.url)
  const linkBase = trimSlash(cfg.publicUrl ?? cfg.url)

  async function poll(): Promise<Observation> {
    const headers = { Authorization: `Bearer ${secret(deps.env, cfg.tokenEnv)}`, Accept: 'application/json' }
    const [alertsBody, rulesBody] = await Promise.all([
      getJson(deps.fetch, apiBase + ALERTS_PATH, headers, 'Grafana alerts'),
      getJson(deps.fetch, apiBase + RULES_PATH, headers, 'Grafana rules')
    ])
    if (!Array.isArray(alertsBody)) throw new Error('Grafana alerts response is not a list')
    const now = deps.nowIso()
    const rules = readRules(rulesBody)
    const index = indexRules(rules)
    const build = (raw: unknown): Alert | null => toAlert(raw, { cfg, deps, linkBase, index, now })
    const firing: Alert[] = []
    const resolved: Alert[] = []
    const seen = new Set<string>()
    for (const raw of alertsBody) {
      const alert = build(raw)
      if (!alert || seen.has(alert.key)) continue
      // A heartbeat rule fires on purpose: it is a liveness cell below, not an incident.
      if (isDeadMansPing(alert.labels)) continue
      seen.add(alert.key)
      // Alertmanager never lists a resolved alert; an endsAt in the past can only be clock skew.
      const bucket = alert.resolvedAt ? resolved : firing
      bucket.push(alert)
    }
    const cells = rules.map((rule) => toCell(rule, cfg, deps, linkBase))
    return { source: cfg.id, kind: 'grafana', at: now, firing, resolved, complete: true, rules: cells }
  }

  return { id: cfg.id, kind: 'grafana', name: 'Grafana', pollSec: cfg.pollSec, poll }
}

// ---- rules ------------------------------------------------------------------------------------------

function readRules(body: unknown): RuleInfo[] {
  const groups = isRecord(body) && isRecord(body.data) ? body.data.groups : undefined
  if (!Array.isArray(groups)) throw new Error('Grafana rules response has an unexpected shape')
  const out: RuleInfo[] = []
  for (const g of groups) {
    if (!isRecord(g) || !Array.isArray(g.rules)) continue
    for (const r of g.rules) if (isRecord(r) && typeof r.name === 'string') out.push(readRule(r, g))
  }
  return out
}

function readRule(r: Record<string, unknown>, g: Record<string, unknown>): RuleInfo {
  const alerts = Array.isArray(r.alerts) ? r.alerts : []
  return {
    uid: typeof r.uid === 'string' && r.uid !== '' ? r.uid : undefined,
    name: r.name as string,
    folder: typeof g.file === 'string' ? g.file : '',
    group: typeof g.name === 'string' ? g.name : '',
    intervalSec: typeof g.interval === 'number' && g.interval > 0 ? g.interval : undefined,
    state: typeof r.state === 'string' ? r.state : '',
    health: typeof r.health === 'string' ? r.health : '',
    paused: r.isPaused === true,
    labels: stringMap(r.labels),
    lastEvaluation: isoOrNull(r.lastEvaluation) ?? undefined,
    instanceStates: alerts.flatMap((a) => (isRecord(a) && typeof a.state === 'string' ? [a.state] : [])),
    query: typeof r.query === 'string' ? r.query : undefined
  }
}

function indexRules(rules: RuleInfo[]): RuleIndex {
  const byUid = new Map<string, RuleInfo>()
  const byName = new Map<string, RuleInfo[]>()
  for (const r of rules) {
    if (r.uid) byUid.set(r.uid, r)
    byName.set(r.name, [...(byName.get(r.name) ?? []), r])
  }
  return { byUid, byName }
}

/** Grafana labels every alert with __alert_rule_uid__; the name (and folder, when names repeat) is the fallback. */
function findRule(index: RuleIndex, labels: Record<string, string>, ruleName: string): RuleInfo | undefined {
  const uid = labels.__alert_rule_uid__
  if (uid && index.byUid.has(uid)) return index.byUid.get(uid)
  const named = index.byName.get(ruleName) ?? []
  if (named.length === 1) return named[0]
  return named.find((r) => r.folder === labels.grafana_folder)
}

/**
 * Rule state: firing and pending win, then NoData, then Error, else ok. A paused rule is not being
 * evaluated, so it can never prove anything is watched: it shows as stale.
 */
function cellState(rule: RuleInfo): CellState {
  if (rule.paused) return 'stale'
  // A heartbeat is healthy while it fires and broken when it stops: the alert path may be down.
  if (isDeadMansPing(rule.labels)) return rule.state === 'firing' ? 'ok' : 'error'
  if (rule.state === 'firing') return 'firing'
  if (rule.state === 'pending') return 'pending'
  if (rule.health === 'nodata' || rule.instanceStates.some((s) => /nodata/i.test(s))) return 'nodata'
  if (rule.health === 'error' || rule.instanceStates.some((s) => /error/i.test(s))) return 'error'
  return 'ok'
}

function toCell(rule: RuleInfo, cfg: GrafanaSourceConfig, deps: SourceDeps, linkBase: string): RuleCell {
  return {
    id: `${cfg.id}:${rule.uid ?? `${rule.group}/${rule.name}`}`,
    source: cfg.id,
    name: rule.name,
    service: deriveService(cfg.id, rule.name, rule.labels, deps.serviceMap),
    state: cellState(rule),
    evaluatedAt: rule.lastEvaluation,
    intervalSec: rule.intervalSec,
    url: ruleUrl(linkBase, rule)
  }
}

// ---- alerts -----------------------------------------------------------------------------------------

interface AlertCtx {
  cfg: GrafanaSourceConfig
  deps: SourceDeps
  linkBase: string
  index: RuleIndex
  now: string
}

function toAlert(raw: unknown, ctx: AlertCtx): Alert | null {
  if (!isRecord(raw)) return null
  const labels = stringMap(raw.labels)
  const annotations = stringMap(raw.annotations)
  const rule = ruleNameOf(labels)
  const startsAt = isoOrNull(raw.startsAt) ?? ctx.now
  const info = findRule(ctx.index, labels, rule)
  const links = alertLinks(ctx.linkBase, { labels, annotations, rule, info, startsAt, generatorURL: raw.generatorURL })
  return makeAlert(
    {
      origin: ctx.cfg.id,
      fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : undefined,
      rule,
      labels,
      annotations,
      startsAt,
      endsAt: isoOrNull(raw.endsAt),
      generatorURL: safeUrl(raw.generatorURL),
      status: readStatus(raw.status),
      value: valueText(parseJsonRecord(annotations.__values__), annotations.__value_string__),
      links,
      via: { source: ctx.cfg.id, kind: 'grafana', lastSeen: ctx.now, url: links.rule ?? links.generator },
      raw
    },
    ctx.deps.serviceMap,
    ctx.now
  )
}

function readStatus(v: unknown): Partial<AlertStatus> {
  if (!isRecord(v)) return {}
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
  const state = typeof v.state === 'string' && AM_STATES.has(v.state) ? (v.state as AmState) : undefined
  return { state, silencedBy: list(v.silencedBy), inhibitedBy: list(v.inhibitedBy), mutedBy: list(v.mutedBy) }
}

interface LinkInput {
  labels: Record<string, string>
  annotations: Record<string, string>
  rule: string
  info: RuleInfo | undefined
  startsAt: string
  generatorURL: unknown
}

function alertLinks(base: string, a: LinkInput): AlertLinks {
  const links: AlertLinks = {}
  const generator = safeUrl(a.generatorURL)
  if (generator) links.generator = generator
  const runbook = safeUrl(a.annotations.runbook_url)
  if (runbook) links.runbook = runbook
  const uid = a.annotations.__dashboardUid__
  if (uid) {
    links.dashboard = `${base}/d/${encodeURIComponent(uid)}`
    const panelId = a.annotations.__panelId__
    if (panelId) links.panel = `${links.dashboard}?viewPanel=${encodeURIComponent(panelId)}`
  }
  if (a.info) {
    links.rule = ruleUrl(base, a.info)
    links.explore = exploreUrl(base, a.info, Date.parse(a.startsAt) - HOUR_MS)
  }
  links.silence = silenceUrl(base, a.labels, a.rule)
  return links
}

function ruleUrl(base: string, rule: RuleInfo): string | undefined {
  return rule.uid ? `${base}/alerting/grafana/${encodeURIComponent(rule.uid)}/view` : undefined
}

/** A pseudo-alert is silenced by alertname plus rulename; silencing alertname alone would mute every rule's NoData. */
function silenceUrl(base: string, labels: Record<string, string>, rule: string): string {
  const matchers = [`alertname=${labels.alertname ?? rule}`]
  if (labels.rulename) matchers.push(`rulename=${labels.rulename}`)
  const query = new URLSearchParams(matchers.map((m) => ['matcher', m]))
  return `${base}/alerting/silence/new?${query}`
}

/**
 * Explore on the rule's first real query: its data source and model, from an hour before the alert began.
 * Expression queries (datasourceUid __expr__) have nothing to explore. Omitted when the rule has no such query.
 */
function exploreUrl(base: string, rule: RuleInfo, fromMs: number): string | undefined {
  const query = firstDataQuery(rule.query)
  if (!query) return undefined
  const model = isRecord(query.model) ? query.model : {}
  const datasource = { ...(isRecord(model.datasource) ? model.datasource : {}), uid: query.datasourceUid }
  const refId = typeof query.refId === 'string' ? query.refId : 'A'
  const pane = {
    datasource: query.datasourceUid,
    queries: [{ ...model, refId, datasource }],
    range: { from: String(Math.max(0, fromMs)), to: 'now' }
  }
  const params = new URLSearchParams({ schemaVersion: '1', panes: JSON.stringify({ a: pane }) })
  return `${base}/explore?${params}`
}

function firstDataQuery(text: string | undefined): (Record<string, unknown> & { datasourceUid: string }) | undefined {
  if (!text) return undefined
  let queries: unknown
  try {
    queries = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!Array.isArray(queries)) return undefined
  for (const q of queries) {
    if (isRecord(q) && typeof q.datasourceUid === 'string' && q.datasourceUid !== '__expr__') {
      return q as Record<string, unknown> & { datasourceUid: string }
    }
  }
  return undefined
}
