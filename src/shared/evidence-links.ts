// The one evidence-link model. The drill-down sheet and the notification email both render THIS list, so the
// link a person sees on the wall is the link they get in the mail, with the same label and the same order.
//
// An alert reaches Watch with its evidence scattered: a generatorURL, engine-derived links (Grafana panel,
// dashboard, explore, rule, silence), annotation URLs (runbook_url, report_url, evidence_url, the legacy
// triage) and annotation TEXT (evidence, the legacy probe: a shell command, not a URL). This module reads all
// of them and answers one question: what can a person open or copy to see the proof, in what order.
//
//   kind       what it is                                         how it renders
//   source     Grafana panel, explore, rule, vmalert, Alertmanager a link ("Open in Grafana")
//   report     the report message or topic (a Zulip narrow URL     a link ("Report in #triage")
//              from before the move to Chat, or any report_url)
//   runbook    the runbook                                         a link
//   evidence   a probe command or evidence text, or its URL        a copyable code chip (a link when it is a URL)
//   reference  anything else a URL names (silence, other *_url)    a link
//
// Order is the order of that table: source first, because the data is the evidence; then the report; then
// how to fix it; then the command that reproduces it. Links are deduplicated by URL and empty ones dropped.
// The same file ranks instances worst-first (severity, then the most urgent value, then age), because the
// title, the instance table and the email subject must all name the same instance.

import type { Alert, AlertLinks, Severity } from './types.ts'

export type EvidenceKind = 'source' | 'report' | 'runbook' | 'evidence' | 'reference'

export interface EvidenceLink {
  /** Stable per link: the URL, or `cmd:` plus the text. Safe as a React key. */
  id: string
  kind: EvidenceKind
  /** The visible action label, sentence case, with no trailing arrow. */
  label: string
  /** One word for a row that already says what it is about ("Report", "Panel", "Evidence"). */
  short: string
  /** An http(s) URL. Absent only on a copy-only evidence command. */
  url?: string
  /** The command or text to copy, on an evidence entry that has no URL. */
  text?: string
  /** Host of the URL, for a quiet second line. */
  host?: string
}

/** Everything the model reads. An `Alert` is one, and so is the notifier's instance view. */
export interface EvidenceSource {
  annotations?: Record<string, string>
  links?: AlertLinks
  generatorURL?: string
}

const KIND_ORDER: Record<EvidenceKind, number> = { source: 0, report: 1, runbook: 2, evidence: 3, reference: 4 }
const MAX_COMMAND_CHARS = 600

/** http(s) only: link text comes from alert content, so a javascript: or data: URL never reaches a href. */
export function webUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (s === '') return undefined
  try {
    const { protocol } = new URL(s)
    return protocol === 'http:' || protocol === 'https:' ? s : undefined
  } catch {
    return undefined
  }
}

/** Two spellings of one page compare equal: host case, a trailing slash, and Grafana's `orgId=1` do not count. */
function dedupeKey(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete('orgId')
    const search = u.searchParams.toString()
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${search ? `?${search}` : ''}${u.hash}`
  } catch {
    return url
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * "Report in #triage" for one message, "Topic in #triage" for the whole thread: the Zulip narrow URL names its
 * channel (`channel/8-triage`, older `stream/8-triage`) and says whether it points at a message (`near/82`).
 */
function zulipLabel(url: string, fallback: string): string {
  const hash = (() => {
    try {
      return new URL(url).hash
    } catch {
      return ''
    }
  })()
  const channel = /\/(?:channel|stream)\/\d+-([^/]+)/.exec(hash)?.[1]
  if (!channel) return fallback
  const name = decodeURIComponent(channel)
  return /\/near\/\d+/.test(hash) ? `Report in #${name}` : `Topic in #${name}`
}

/** An in-cluster generatorURL (`http://prometheus-0:9090/graph`) has no dot in its host: nobody outside can open it. */
function reachable(url: string | undefined): string | undefined {
  const u = webUrl(url)
  if (!u) return undefined
  try {
    return new URL(u).hostname.includes('.') ? u : undefined
  } catch {
    return undefined
  }
}

function isZulip(url: string): boolean {
  try {
    const u = new URL(url)
    return /\/(?:channel|stream)\/\d+-/.test(u.hash) || /^(?:chat|zulip)\./i.test(u.hostname)
  } catch {
    return false
  }
}

interface Classified {
  kind: EvidenceKind
  label: string
}

/** A generatorURL names whatever evaluated the rule. The regression sweep sets it to its Zulip message, so look. */
function classifyGenerator(url: string): Classified {
  if (isZulip(url)) return { kind: 'report', label: zulipLabel(url, 'Open the report') }
  const hay = (() => {
    try {
      const u = new URL(url)
      return `${u.hostname}${u.pathname}${u.hash}`
    } catch {
      return url
    }
  })()
  if (/(?:^|\.)netdata\.cloud\//i.test(hay)) return { kind: 'source', label: 'Open in Netdata Cloud' }
  if (/(?:^|\.)sentry\.io\//i.test(hay)) return { kind: 'source', label: 'Open in Sentry' }
  if (/grafana|\/alerting\/|\/d\/|\/explore/i.test(hay)) return { kind: 'source', label: 'Open in Grafana' }
  if (/vmalert/i.test(hay)) return { kind: 'source', label: 'Open in vmalert' }
  if (/alertmanager|#\/alerts/i.test(hay)) return { kind: 'source', label: 'Open in Alertmanager' }
  if (/prometheus|\/graph\b/i.test(hay)) return { kind: 'source', label: 'Open in Prometheus' }
  return { kind: 'source', label: 'Open the source' }
}

/** The one-word form of a label, for the compact controls of an instance row. */
function shortOf(kind: EvidenceKind, label: string): string {
  if (kind === 'report') return label.startsWith('Topic') ? 'Topic' : 'Report'
  if (kind === 'runbook') return 'Runbook'
  if (kind === 'evidence') return label.endsWith('command') ? 'Command' : 'Evidence'
  if (kind === 'source') {
    if (label === 'Grafana panel') return 'Panel'
    if (label === 'Grafana dashboard') return 'Dashboard'
    if (label === 'Explore in Grafana') return 'Explore'
    if (label === 'Alert rule in Grafana') return 'Rule'
    return 'Source'
  }
  return label
}

function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]?url$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (words === '') return 'Reference'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// Annotation names, lower case. The sweep sends report_url, evidence and evidence_url; triage and probe are
// the names it used before, and live alerts can still carry them.
const REPORT_KEYS = ['report_url', 'report', 'triage_url', 'triage', 'zulip_url', 'topic_url']
const RUNBOOK_KEYS = ['runbook_url', 'runbook']
const EVIDENCE_TEXT_KEYS: Array<[string, string]> = [
  ['evidence', 'Evidence command'],
  ['probe', 'Probe command'],
  ['command', 'Command']
]
const EVIDENCE_URL_KEYS = ['evidence_url']
const SOURCE_KEYS: Array<[string, string]> = [
  ['panel_url', 'Grafana panel'],
  ['dashboard_url', 'Grafana dashboard'],
  ['explore_url', 'Explore in Grafana'],
  ['grafana_url', 'Open in Grafana'],
  ['vmalert_url', 'Open in vmalert'],
  ['alertmanager_url', 'Open in Alertmanager'],
  ['source_url', 'Open the source']
]
const CLAIMED_KEYS = new Set([
  ...REPORT_KEYS,
  ...RUNBOOK_KEYS,
  ...EVIDENCE_TEXT_KEYS.map(([k]) => k),
  ...EVIDENCE_URL_KEYS,
  ...SOURCE_KEYS.map(([k]) => k),
  'generator_url'
])

function annotation(a: Record<string, string>, key: string): string | undefined {
  for (const [k, v] of Object.entries(a)) if (k.toLowerCase() === key && typeof v === 'string' && v.trim() !== '') return v.trim()
  return undefined
}

function cleanCommand(text: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  return flat.length <= MAX_COMMAND_CHARS ? flat : `${flat.slice(0, MAX_COMMAND_CHARS - 3)}...`
}

/**
 * Every evidence link of ONE alert, ordered (source, report, runbook, evidence, reference), deduplicated by URL,
 * empty and non-http(s) entries dropped. Within the source kind the order is panel, dashboard, explore, rule,
 * generator, and a dashboard is dropped when its panel is there: the panel is the same page, narrower.
 */
export function evidenceLinks(src: EvidenceSource): EvidenceLink[] {
  const ann = src.annotations ?? {}
  const links = src.links ?? {}
  const out: Array<EvidenceLink & { rank: number }> = []
  const seen = new Set<string>()
  const labels = new Set<string>()
  let order = 0
  const add = (kind: EvidenceKind, label: string, raw: unknown, textRaw?: string): void => {
    if (textRaw !== undefined) {
      const text = cleanCommand(textRaw)
      if (text === '' || seen.has(`cmd:${text}`)) return
      seen.add(`cmd:${text}`)
      out.push({ id: `cmd:${text}`, kind, label, short: shortOf(kind, label), text, rank: order++ })
      return
    }
    const url = webUrl(raw)
    if (!url) return
    const key = dedupeKey(url)
    // a label names ONE link: the explicit annotation is added before the generatorURL, so a second report message
    // under "Report in #triage" (the generator's older anchor) is dropped, not shown as an identical twin
    if (seen.has(key) || labels.has(`${kind}|${label}`)) return
    seen.add(key)
    labels.add(`${kind}|${label}`)
    out.push({ id: url, kind, label, short: shortOf(kind, label), url, host: hostOf(url), rank: order++ })
  }

  // report: the message or topic that reports it
  for (const key of REPORT_KEYS) {
    const v = annotation(ann, key)
    if (v) add('report', zulipLabel(v, 'Open the report'), v)
  }

  // source: the engine-derived links first, then annotation URLs, then the generator
  const panel = webUrl(links.panel) ?? webUrl(annotation(ann, 'panel_url'))
  add('source', 'Grafana panel', panel)
  if (!panel) {
    const dashboard = links.dashboard ?? annotation(ann, 'dashboard_url')
    add('source', 'Grafana dashboard', dashboard)
  }
  add('source', 'Explore in Grafana', links.explore ?? annotation(ann, 'explore_url'))
  add('source', 'Alert rule in Grafana', links.rule)
  for (const [key, label] of SOURCE_KEYS.slice(3)) add('source', label, annotation(ann, key))
  // the generator an adapter already vetted (links.generator), else the raw generatorURL, which must be reachable
  const generator = webUrl(links.generator) ?? reachable(src.generatorURL) ?? reachable(annotation(ann, 'generator_url'))
  if (generator) {
    const c = classifyGenerator(generator)
    add(c.kind, c.label, generator)
  }

  // runbook
  add('runbook', 'Runbook', links.runbook ?? RUNBOOK_KEYS.map((k) => annotation(ann, k)).find(Boolean))

  // evidence: a command is a chip; a URL (evidence_url, or an evidence annotation that is one) is a link
  for (const key of EVIDENCE_URL_KEYS) add('evidence', 'Open the evidence', annotation(ann, key))
  for (const [key, label] of EVIDENCE_TEXT_KEYS) {
    const v = annotation(ann, key)
    if (!v) continue
    if (webUrl(v)) add('evidence', 'Open the evidence', v)
    else add('evidence', label, undefined, v)
  }

  // reference: silence, and any other annotation that is a URL under a name this model does not claim
  add('reference', 'Silence in Grafana', links.silence)
  for (const [k, v] of Object.entries(ann)) {
    if (CLAIMED_KEYS.has(k.toLowerCase()) || !/(?:^|[_-])(?:url|link)$/i.test(k)) continue
    add('reference', humanizeKey(k), v)
  }

  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.rank - b.rank).map(({ rank: _rank, ...link }) => link)
}

/**
 * The links of the incident as a whole: those of its WORST instance, plus a link another instance has for a
 * kind the worst one lacks (a runbook attached to only one host). A kind the worst instance already covers is
 * not repeated from the others, and neither are their evidence commands: each instance row carries its own.
 * `instances` must be worst first.
 */
export function incidentEvidence(instances: readonly EvidenceSource[]): EvidenceLink[] {
  if (instances.length === 0) return []
  const out = evidenceLinks(instances[0])
  const kinds = new Set(out.map((l) => l.kind))
  const urls = new Set(out.map((l) => (l.url ? dedupeKey(l.url) : l.id)))
  for (const inst of instances.slice(1)) {
    for (const l of evidenceLinks(inst)) {
      if (l.text !== undefined || kinds.has(l.kind)) continue
      const key = l.url ? dedupeKey(l.url) : l.id
      if (urls.has(key)) continue
      urls.add(key)
      out.push(l)
    }
  }
  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
}

// ---- ranking: worst first ------------------------------------------------------------------------------

export interface RankInput {
  severity: Severity
  /** ISO. The older, the longer it has stood. */
  startsAt: string
  /** The instance's own summary: the most urgent value is read from it ("full in ~8h"). */
  summary?: string
  /** A source value string, read when the summary names no ETA. */
  value?: string
  /** Tie-break by name so the order never flickers between polls. */
  name?: string
}

const SEVERITY_RANK: Record<Severity, number> = { page: 0, warning: 1, info: 2 }
const UNIT_SEC: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }

/**
 * Seconds until the thing the text promises: "full in ~1.9d" is 164160. Reads a verb of exhaustion, then
 * `in`, then a number with a unit (s, m, min, h, hr, d, w, long forms too). Null when the text names none.
 */
export function etaSeconds(text: string | undefined): number | null {
  if (!text) return null
  const m = /\b(?:full|empty|exhausted|expires?|breach(?:es)?|out|ETA)\s+(?:in\s+)?~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|[smhdw])\b/i.exec(text)
  if (!m) return null
  const unit = UNIT_SEC[m[2].charAt(0).toLowerCase()]
  const n = Number(m[1])
  return Number.isFinite(n) && unit ? n * unit : null
}

function startMs(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms
}

/** The comparator behind `worstFirst`: severity, then the shortest ETA, then the oldest, then the name. */
export function compareWorst(a: RankInput, b: RankInput): number {
  const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (sev !== 0) return sev
  const ea = etaSeconds(a.summary) ?? etaSeconds(a.value)
  const eb = etaSeconds(b.summary) ?? etaSeconds(b.value)
  if (ea !== eb) {
    if (ea === null) return 1
    if (eb === null) return -1
    return ea - eb
  }
  const age = startMs(a.startsAt) - startMs(b.startsAt)
  if (age !== 0) return age
  return (a.name ?? '') < (b.name ?? '') ? -1 : (a.name ?? '') > (b.name ?? '') ? 1 : 0
}

/** A new array, worst first. Stable: equal instances keep their input order. */
export function worstFirst<T>(items: readonly T[], read: (item: T) => RankInput): T[] {
  return items
    .map((item, i) => ({ item, i, r: read(item) }))
    .sort((a, b) => compareWorst(a.r, b.r) || a.i - b.i)
    .map((x) => x.item)
}

/** What the ranking reads off a stored alert, so the engine, the sheet and the notifier rank the same way. */
export function rankOf(a: Pick<Alert, 'severity' | 'startsAt' | 'annotations' | 'value' | 'host' | 'labels' | 'rule'>): RankInput {
  return { severity: a.severity, startsAt: a.startsAt, summary: a.annotations.summary, value: a.value, name: instanceName(a) }
}

// ---- naming an instance ------------------------------------------------------------------------------
//
// Every surface (the wall tile, the sheet rows, the email table, the plain-text body) names an instance the same
// way. The name is the first of: the host, the instance label, the service label, the namespace and workload, the
// alert's own summary, and only then the alertname. An alert that has no host (a sweep finding, a
// Sentry issue) is told apart by its summary, never by the alertname the incident is already titled with.

export type LabelSource = 'host' | 'instance' | 'service' | 'workload' | 'summary' | 'rule'

export interface InstanceLabel {
  text: string
  source: LabelSource
}

/** What naming an instance reads. An `Alert` is one, and so is the notifier's instance view. */
export interface LabelInput {
  host?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  rule: string
}

const LABEL_LEVELS: LabelSource[] = ['host', 'instance', 'service', 'workload', 'summary']

function clean(v: string | undefined): string {
  return (v ?? '').replace(/\s+/g, ' ').trim()
}

function candidate(a: LabelInput, level: LabelSource): string {
  const l = a.labels ?? {}
  switch (level) {
    case 'host':
      return clean(a.host)
    case 'instance':
      return clean(l.instance).replace(/:\d+$/, '')
    case 'service':
      return clean(l.service)
    case 'workload': {
      const ns = clean(l.namespace)
      const w = clean(l.workload || l.deployment || l.app || l.job)
      return ns && w ? `${ns}/${w}` : ns || w
    }
    case 'summary':
      return clean(a.annotations?.summary)
    default:
      return clean(a.rule)
  }
}

/**
 * One label per instance of ONE incident. A level is used for an instance when it has a value there that no other
 * instance shares and that is not `avoid` (the incident's own title, which the alertname always is): three hosts
 * under one service label are told apart by host, two findings with no labels at all by their summaries. The
 * alertname is the last resort, for an alert with nothing else to say.
 */
export function instanceLabels(items: readonly LabelInput[], avoid: readonly string[] = []): InstanceLabel[] {
  const out: Array<InstanceLabel | null> = items.map(() => null)
  const skip = new Set(avoid.map((x) => clean(x).toLowerCase()).concat(items.map((a) => clean(a.rule).toLowerCase())))
  const taken = new Set<string>()
  for (const level of LABEL_LEVELS) {
    const texts = items.map((a) => candidate(a, level))
    const counts = new Map<string, number>()
    for (const t of texts) if (t !== '') counts.set(t.toLowerCase(), (counts.get(t.toLowerCase()) ?? 0) + 1)
    texts.forEach((t, i) => {
      const key = t.toLowerCase()
      if (out[i] || t === '' || skip.has(key) || taken.has(key) || counts.get(key) !== 1) return
      out[i] = { text: t, source: level }
      taken.add(key)
    })
  }
  return out.map((o, i) => o ?? { text: candidate(items[i], 'rule'), source: 'rule' })
}

/** The label of one instance on its own. */
export function instanceLabel(a: LabelInput, avoid: readonly string[] = []): InstanceLabel {
  return instanceLabels([a], avoid)[0]
}

/** The text of `instanceLabel`: the name the ranking breaks ties on. */
export function instanceName(a: LabelInput): string {
  return instanceLabel(a).text
}

/**
 * The instance's own summary without its own name in front: "node-5 disk / 81% (175 GB free, full in ~8h)" under
 * the name "node-5" reads "disk / 81% (175 GB free, full in ~8h)", so a row that already says node5 does not say it twice.
 */
export function statusText(name: string, summary: string | undefined, value?: string): string {
  const s = (summary ?? '').trim()
  if (s === '') return (value ?? '').trim()
  if (name !== '' && s.toLowerCase().startsWith(name.toLowerCase())) {
    const rest = s.slice(name.length).replace(/^[\s:,/-]+/, '')
    if (rest !== '') return rest
  }
  return s
}
