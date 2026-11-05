// Turn a parsed source payload into the canonical Alert. Every adapter goes through makeAlert so identity,
// service, host and severity are derived in exactly one place. The config's severity caps (capSeverity) are the one
// step after it: the engine applies them where every source's alerts arrive, so no adapter needs to hold the config.

import { createHash } from 'node:crypto'
import type { Alert, AlertLinks, AlertStatus, AlertVia, Severity } from '../shared/types.ts'
import { severityOf } from '../shared/incident.ts'
import type { ServiceRule, SeverityCap } from './config.ts'

export interface AlertDraft {
  /** The system that raised the alert: "grafana", "prod", a webhook source id. */
  origin: string
  fingerprint?: string
  rule: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  startsAt: string
  endsAt?: string | null
  generatorURL?: string
  status?: Partial<AlertStatus>
  value?: string
  links?: AlertLinks
  via: AlertVia
  raw: unknown
}

const SERVICE_LABELS = ['service', 'component', 'job', 'app', 'application', 'namespace', 'team']
const HOST_LABELS = ['instance', 'host', 'hostname', 'node', 'nodename', 'pod', 'server']

export function fp8(fingerprint: string): string {
  return fingerprint.replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase()
}

/** Hash of the sorted labels, for sources that give no fingerprint (a push that carries only an 8-hex id). */
export function labelsFingerprint(labels: Record<string, string>): string {
  const sorted = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join('\n')
  return createHash('sha256').update(sorted).digest('hex').slice(0, 16)
}

export function alertKey(origin: string, fingerprint: string): string {
  return `${origin}:${fp8(fingerprint)}`
}

/** The service the config names for this alert, or undefined when no serviceMap entry matches (first match wins). */
export function matchService(
  origin: string,
  rule: string,
  labels: Record<string, string>,
  map: ServiceRule[]
): string | undefined {
  for (const r of map) {
    if (r.match.origin !== undefined && !new RegExp(r.match.origin).test(origin)) continue
    if (r.match.rule !== undefined && !new RegExp(r.match.rule).test(rule)) continue
    let ok = true
    for (const [k, re] of Object.entries(r.match.labels ?? {})) {
      if (!new RegExp(re).test(labels[k] ?? '')) {
        ok = false
        break
      }
    }
    if (ok) return r.service
  }
  return undefined
}

export function deriveService(
  origin: string,
  rule: string,
  labels: Record<string, string>,
  map: ServiceRule[]
): string {
  const named = matchService(origin, rule, labels, map)
  if (named !== undefined) return named
  for (const k of SERVICE_LABELS) if (labels[k]) return humanize(labels[k])
  return origin
}

/** A machine name read as a title: "gateway-gateway" becomes "Gateway gateway". Anything with capitals or spaces is left alone. */
export function humanize(name: string): string {
  if (!/^[a-z0-9]+([-_.][a-z0-9]+)*$/.test(name)) return name
  const words = name.replace(/[-_.]+/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function deriveHost(labels: Record<string, string>): string {
  for (const k of HOST_LABELS) if (labels[k]) return labels[k].replace(/:\d+$/, '')
  return ''
}

/** The annotation an alert held below its own severity carries: "Sent as page, shown as warning: <the cap's note>". */
export const CAPPED_ANNOTATION = 'watch_capped'

const SEVERITY_RANK: Record<Severity, number> = { page: 3, warning: 2, info: 1 }

/** Compiled once per source string: a wall read caps every firing alert, and the config's few patterns are the same every time. */
const patterns = new Map<string, RegExp>()
function pattern(src: string): RegExp {
  let re = patterns.get(src)
  if (!re) {
    re = new RegExp(src)
    patterns.set(src, re)
  }
  return re
}

/** The cap that holds this alert: the lowest `max` among the caps whose every matcher matches (the first of those on a tie), or null when none does. */
export function severityCapOf(alert: Pick<Alert, 'origin' | 'rule' | 'labels'>, caps: readonly SeverityCap[]): SeverityCap | null {
  let held: SeverityCap | null = null
  for (const c of caps) {
    if (c.match.origin !== undefined && !pattern(c.match.origin).test(alert.origin)) continue
    if (c.match.rule !== undefined && !pattern(c.match.rule).test(alert.rule)) continue
    if (!Object.entries(c.match.labels ?? {}).every(([k, src]) => pattern(src).test(alert.labels[k] ?? ''))) continue
    if (!held || SEVERITY_RANK[c.max] < SEVERITY_RANK[held.max]) held = c
  }
  return held
}

/**
 * The alert as the config's severity caps leave it. A cap only ever lowers: a page from a dev environment becomes a warning, with CAPPED_ANNOTATION saying
 * so, and a warning or info under the cap is left alone. It is stateless, so applying it twice changes nothing and applying it to an alert stored under an
 * older config gives what the config says now: an alert that carries the annotation is read at the severity its source sent (`severityOf` of the label, as
 * makeAlert derived it), and when no cap covers it any more it goes back to that severity without the annotation.
 */
export function capSeverity(alert: Alert, caps: readonly SeverityCap[]): Alert {
  const wasCapped = alert.annotations[CAPPED_ANNOTATION] !== undefined
  if (caps.length === 0 && !wasCapped) return alert
  const sent = wasCapped ? severityOf(alert.severityLabel) : alert.severity
  const cap = severityCapOf(alert, caps)
  if (cap && SEVERITY_RANK[sent] > SEVERITY_RANK[cap.max]) {
    const line = `Sent as ${sent}, shown as ${cap.max}: ${cap.note}`
    if (alert.severity === cap.max && alert.annotations[CAPPED_ANNOTATION] === line) return alert
    return { ...alert, severity: cap.max, annotations: { ...alert.annotations, [CAPPED_ANNOTATION]: line } }
  }
  if (!wasCapped) return alert
  const annotations = { ...alert.annotations }
  delete annotations[CAPPED_ANNOTATION]
  return { ...alert, severity: sent, annotations }
}

export function makeAlert(draft: AlertDraft, map: ServiceRule[], nowIso: string): Alert {
  const labels = draft.labels ?? {}
  const fingerprint = draft.fingerprint && fp8(draft.fingerprint) ? draft.fingerprint : labelsFingerprint(labels)
  const severityLabel = labels.severity ?? ''
  const endsAt = draft.endsAt && Date.parse(draft.endsAt) <= Date.parse(nowIso) ? draft.endsAt : null
  return {
    key: alertKey(draft.origin, fingerprint),
    origin: draft.origin,
    fingerprint,
    rule: draft.rule,
    service: deriveService(draft.origin, draft.rule, labels, map),
    host: deriveHost(labels),
    severity: severityOf(severityLabel),
    severityLabel,
    labels,
    annotations: draft.annotations ?? {},
    startsAt: draft.startsAt,
    endsAt,
    generatorURL: draft.generatorURL,
    status: {
      state: draft.status?.state ?? 'active',
      silencedBy: draft.status?.silencedBy ?? [],
      inhibitedBy: draft.status?.inhibitedBy ?? [],
      mutedBy: draft.status?.mutedBy ?? []
    },
    value: draft.value,
    links: draft.links ?? {},
    via: [draft.via],
    firstSeen: nowIso,
    lastSeen: nowIso,
    resolvedAt: endsAt,
    raw: draft.raw
  }
}
