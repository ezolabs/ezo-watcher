// The Story model: everything a person reads on a wall tile and in the incident sheet, derived from ONE alert in one place.
//
// An alert reaches Watch in one of four shapes (a sweep finding, a Grafana alert, a router Alertmanager v4 alert,
// an node-2 prober transition). Each carries a different subset of what a person needs: what broke, where, the proof, and what
// to do next. This module reads all of them and answers those questions, with a stated fallback for every field, so a tile
// and a sheet never show an empty section and never show the same text twice.
//
//   field            from (first present wins)
//   headline         annotation `headline`, `summary`, the alertname read as words (plus ` on <host>`)
//   what happened    annotation `what_happened`, `description`, `summary` when a `headline` replaced it, a sentence saying none came
//   badge            host (label `host`, `instance` without its port), env, namespace, cluster, then the source system
//   breadcrumb       system (label `system`, else the source system) / service (label `service`, else the wall's group) /
//                    component (label `component`, `job`, `layer`), each shown once
//   where            annotation `where`, else a line built from the labels
//   evidence         command: annotation `evidence`, `probe`, `command`. output: annotation `evidence_output` (up to 4 KB).
//                    values: the Grafana values and the threshold when the alert carries them
//   what to do       annotation `action` (one step per line), else the runbook link alone
//   the tile line    first line of the output (a sweep record `source | id | ISO | title | detail` reads as its title), else the
//                    summary, else the command, the description, the value (a description is Markdown: its lead block as plain
//                    text, then its first sentence)
//
// Links are classified by evidence-links.ts; this file only sorts them into the sections they belong to: the chat links
// (kind report) go to the bottom line "Also in the chat panel", never to a primary control.

import { evidenceLinks, webUrl } from './evidence-links.ts'
import type { EvidenceLink, EvidenceSource } from './evidence-links.ts'
import { descriptionLead } from './markdown.ts'
import { parseSweepRecord } from './sweep-record.ts'

/** What the model reads. An `Alert` is one, and so is anything with a rule and some labels. */
export interface StorySource extends EvidenceSource {
  origin?: string
  rule: string
  service?: string
  host?: string
  labels?: Record<string, string>
  value?: string
}

/** The longest captured output the sheet shows: the sweep sends up to 4 KB. */
export const MAX_OUTPUT_CHARS = 4096
const MAX_LINE_CHARS = 200

// ---- small readers ------------------------------------------------------------------------------------------

function clean(v: string | undefined): string {
  return (v ?? '').replace(/\s+/g, ' ').trim()
}

function annotation(a: StorySource, key: string): string {
  for (const [k, v] of Object.entries(a.annotations ?? {})) if (k.toLowerCase() === key && typeof v === 'string' && v.trim() !== '') return v.trim()
  return ''
}

/** The first label of `keys` that has a value, with the key that held it. */
function labelOf(a: StorySource, keys: readonly string[]): { key: string; text: string } | null {
  const l = a.labels ?? {}
  for (const key of keys) {
    const text = clean(l[key])
    if (text !== '') return { key, text }
  }
  return null
}

/** Two names compare equal ignoring case, spacing, dashes and a plural s: "Host disks" and "host-disk". */
function same(a: string, b: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '')
  return norm(a) !== '' && norm(a) === norm(b)
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * An alertname or a machine name read as words: "IntakeBugReport" is "Intake bug report", "node_disk_high" is "Node disk high".
 * A name that already has spaces is left alone, and an acronym ("HTTP") stays upper case.
 */
export function humanizeName(name: string): string {
  const s = name.trim()
  if (s === '' || /\s/.test(s)) return s
  const words = s
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
  return words.map((w, i) => (/^[A-Z0-9]{2,}$/.test(w) ? w : i === 0 ? capital(w.toLowerCase()) : w.toLowerCase())).join(' ')
}

const SYSTEM_NAMES: Record<string, string> = { grafana: 'Grafana' }

/** The system that raised the alert, as a person names it. Ids such as `prod` and `sweep` are already names. */
export function systemName(origin: string | undefined): string {
  const o = clean(origin)
  return SYSTEM_NAMES[o.toLowerCase()] ?? o
}

// ---- where: host, badge, breadcrumb, chips ------------------------------------------------------------------------

/** A hostname, not a label set: `instance="backend=di9-dev, model_version=x"` is a router's way of naming a pair. */
function isHostName(h: string): boolean {
  return h !== '' && h.length <= 64 && !/[\s=,]/.test(h)
}

/** The machine the alert is about, or empty. The `host` label, else `instance` without its port. */
export function hostOf(a: StorySource): string {
  const candidates = [clean(a.host), clean(a.labels?.host), clean(a.labels?.instance).replace(/:\d+$/, '')]
  return candidates.find(isHostName) ?? ''
}

/** A pod name read as its workload: `api-router-7f9c8d6b5-xk2lp` is `api-router`. A hostname is left whole. */
export function shortHost(host: string): string {
  // Kubernetes draws both random parts from this alphabet (no vowels, no 0, 1 or 3), so "node-exporter" is not a hash
  const alphabet = '[bcdfghjklmnpqrstvwxz2456789]'
  const m = new RegExp(`^(.+?)-${alphabet}{8,10}-${alphabet}{5}$`).exec(host) ?? new RegExp(`^(.+?)-${alphabet}{5}$`).exec(host)
  return m ? m[1] : host
}

export type BadgeKind = 'host' | 'env' | 'system'
export interface Badge {
  text: string
  kind: BadgeKind
}

export type CrumbPart = 'system' | 'service' | 'component'
export interface Crumb {
  part: CrumbPart
  text: string
}

export type ChipKind = 'host' | 'service' | 'env' | 'namespace' | 'cluster' | 'component' | 'source'
export interface WhereChip {
  kind: ChipKind
  /** What the value is, for a screen reader and a tooltip: "Host", "Service", "Environment". */
  label: string
  text: string
}

interface Place {
  host: string
  env: string
  namespace: string
  cluster: string
  service: string
  system: string
  component: { key: string; text: string } | null
  instance: string
}

function placeOf(a: StorySource): Place {
  const system = clean(a.labels?.system) || systemName(a.origin)
  const service = clean(a.labels?.service) || clean(a.service)
  const component = labelOf(a, ['component', 'job', 'layer'])
  const instance = clean(a.labels?.instance)
  return {
    host: hostOf(a),
    env: labelOf(a, ['env', 'environment'])?.text ?? '',
    namespace: clean(a.labels?.namespace),
    cluster: clean(a.labels?.cluster),
    // a service that is only the source's own name (the wall's fallback group) adds nothing to the system
    service: same(service, system) ? '' : service,
    system,
    component,
    instance: instance && !isHostName(instance.replace(/:\d+$/, '')) ? instance : ''
  }
}

function badgeOf(p: Place): Badge {
  if (p.host) return { text: shortHost(p.host), kind: 'host' }
  const env = p.env || p.namespace || p.cluster
  if (env) return { text: env, kind: 'env' }
  return { text: p.system || 'Unknown source', kind: 'system' }
}

function crumbsOf(p: Place, badge: Badge): Crumb[] {
  const out: Crumb[] = []
  const shown = [badge.text]
  const add = (part: CrumbPart, text: string): void => {
    if (text === '' || shown.some((s) => same(s, text))) return
    shown.push(text)
    out.push({ part, text })
  }
  if (badge.kind !== 'system') add('system', p.system)
  add('service', p.service)
  add('component', p.component?.text ?? '')
  return out
}

function chipsOf(p: Place): WhereChip[] {
  const out: WhereChip[] = []
  const seen: string[] = []
  const add = (kind: ChipKind, label: string, text: string): void => {
    if (text === '' || seen.some((s) => same(s, text))) return
    seen.push(text)
    out.push({ kind, label, text })
  }
  add('host', 'Host', p.host)
  add('service', 'Service', p.service)
  add('env', 'Environment', p.env)
  add('namespace', 'Namespace', p.namespace)
  add('cluster', 'Cluster', p.cluster)
  add('component', capital(p.component?.key ?? 'component'), p.component?.text ?? '')
  add('source', 'Source', p.system)
  return out
}

/** The human location line: the sender's own `where`, else the labels written out ("API edge, host prod-node-2, namespace prod."). */
function whereLine(a: StorySource, p: Place): string {
  const given = annotation(a, 'where')
  if (given) return given
  const bits: string[] = []
  if (p.service) bits.push(p.service)
  if (p.component && !same(p.component.text, p.service)) bits.push(`${p.component.key} ${p.component.text}`)
  if (p.host) bits.push(`host ${p.host}`)
  else if (p.instance) bits.push(`instance ${p.instance}`)
  if (p.env) bits.push(`env ${p.env}`)
  if (p.namespace) bits.push(`namespace ${p.namespace}`)
  if (p.cluster) bits.push(`cluster ${p.cluster}`)
  const place = bits.length ? `${capital(bits.join(', '))}. ` : ''
  return `${place}Raised by ${p.system || 'an unnamed source'}.`
}

// ---- the headline and what happened -------------------------------------------------------------------------------

export type HeadlineFrom = 'headline' | 'summary' | 'rule'

export function headlineOf(a: StorySource): { text: string; from: HeadlineFrom } {
  const given = clean(annotation(a, 'headline'))
  if (given) return { text: given, from: 'headline' }
  const summary = clean(annotation(a, 'summary'))
  if (summary) return { text: summary, from: 'summary' }
  const words = humanizeName(clean(a.rule)) || 'Unnamed alert'
  const host = hostOf(a)
  return { text: host && !words.toLowerCase().includes(host.toLowerCase()) ? `${words} on ${host}` : words, from: 'rule' }
}

export type WhatFrom = 'what_happened' | 'description' | 'summary' | 'none'

function paragraphsOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
}

export function whatHappened(a: StorySource, headline: { text: string; from: HeadlineFrom }): { paragraphs: string[]; from: WhatFrom } {
  const given = annotation(a, 'what_happened')
  if (given) return { paragraphs: paragraphsOf(given), from: 'what_happened' }
  const description = annotation(a, 'description')
  if (description && !same(description, headline.text)) return { paragraphs: paragraphsOf(description), from: 'description' }
  const summary = annotation(a, 'summary')
  if (summary && headline.from === 'headline' && !same(summary, headline.text)) return { paragraphs: [summary], from: 'summary' }
  return { paragraphs: ['The source sent no description. Everything it did send is under Labels and Raw below.'], from: 'none' }
}

// ---- evidence: command, output, values, threshold ----------------------------------------------------------------

export interface ValueRow {
  name: string
  value: string
}

export interface StoryEvidence {
  /** The shell command that reproduces the proof. */
  command?: string
  /** The captured output, line breaks kept, cut at 4 KB. */
  output?: string
  /** True when the output was cut at 4 KB. */
  clipped: boolean
  /** The firing value(s), one row each. */
  values: ValueRow[]
  /** What the value is compared with, when the alert says. */
  threshold?: string
}

/** Control characters out (a captured terminal brings them), line breaks and tabs kept, CRLF folded, cut at 4 KB on a line end. */
export function cleanOutput(text: string): { text: string; clipped: boolean } {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+$/, '')
  if (flat.length <= MAX_OUTPUT_CHARS) return { text: flat, clipped: false }
  const head = flat.slice(0, MAX_OUTPUT_CHARS)
  const cut = head.lastIndexOf('\n')
  return { text: cut > MAX_OUTPUT_CHARS / 2 ? head.slice(0, cut) : head, clipped: true }
}

function numberText(n: number): string {
  return String(Number(n.toPrecision(6)))
}

/** Grafana's values: the `__values__` annotation (JSON), else the alert's own value string ("B=77.2, C=1"), else one plain value. */
export function valueRows(a: StorySource): ValueRow[] {
  const json = annotation(a, '__values__')
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const rows = Object.entries(parsed as Record<string, unknown>)
          .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))
          .map(([name, n]) => ({ name, value: numberText(n) }))
        if (rows.length > 0) return rows
      }
    } catch {
      // not JSON: fall through to the value string
    }
  }
  const value = clean(a.value)
  if (value === '') return []
  const pieces = value.split(/,\s*/)
  const rows = pieces.map((p) => /^([\w.-]+)=(\S+)$/.exec(p))
  if (rows.every((m): m is RegExpExecArray => m !== null)) return rows.map((m) => ({ name: m[1], value: m[2] }))
  return [{ name: 'Value', value }]
}

const COMPARE = /\b(at least|above|over|more than|exceeds?|exceeded|greater than|at most|below|under|less than|fewer than|>=|<=|>|<)\s*(\d+(?:\.\d+)?\s*(?:%|ms|min|GiB|MiB|KiB|GB|MB|KB|s|h)?)/i

/** What the value is compared with: an explicit annotation, else the comparison the rule's own text states ("at least 80%"). */
export function thresholdOf(a: StorySource): string | undefined {
  const given = annotation(a, 'threshold') || annotation(a, '__threshold__') || annotation(a, 'threshold_value')
  if (given) return given
  const hay = [annotation(a, 'description'), annotation(a, 'summary')].join(' ')
  const m = COMPARE.exec(hay)
  if (m) return `${m[1].toLowerCase()} ${m[2].replace(/\s+/g, '')}`
  const name = /\bat (\d+(?:\.\d+)?%)/.exec(`${a.rule} ${a.labels?.rulename ?? ''}`)
  return name ? `at ${name[1]}` : undefined
}

function commandOf(links: readonly EvidenceLink[]): string | undefined {
  return links.find((l) => l.kind === 'evidence' && l.text !== undefined)?.text
}

// ---- the one line a tile shows ---------------------------------------------------------------------------------

export type LineKind = 'output' | 'summary' | 'command' | 'value' | 'description'
export interface EvidenceLine {
  text: string
  kind: LineKind
}

function clip(s: string): string {
  if (s.length <= MAX_LINE_CHARS) return s
  const cut = s.slice(0, MAX_LINE_CHARS).replace(/\s+\S*$/, '')
  return `${cut}...`
}

function firstLine(text: string): string {
  return clean(text.split('\n').find((l) => l.trim() !== ''))
}

function firstSentence(text: string): string {
  const flat = clean(text)
  const m = /^(.+?[.!?])(?:\s|$)/.exec(flat)
  return m ? m[1] : flat
}

const ISSUE_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/
const VERSION_TAG = /^v?\d+(?:\.\d+)+\S*$/
/** The level and status words a Sentry record's detail carries: structure, not prose. */
const RECORD_WORDS = new Set(['fatal', 'error', 'warning', 'info', 'debug', 'new', 'ongoing', 'regressed', 'escalating', 'resolved', 'unresolved', 'archived'])

/**
 * What a record the sweep printed (`source | id | ISO | title | detail`, src/shared/sweep-record.ts) reads as on a tile: its title, with the
 * detail's words after it only when it has some. The detail is an issue id, a level, a status, a version tag and `key=value` pairs, and
 * those are no words. Null when the line is not such a record.
 */
function recordLine(line: string): string | null {
  const record = parseSweepRecord(line)
  if (!record) return null
  const extra = record.detail
    .split(/\s+/)
    .filter((t) => t !== '' && !ISSUE_ID.test(t) && !/^[\w.-]+=/.test(t) && !VERSION_TAG.test(t) && !RECORD_WORDS.has(t.toLowerCase()))
    .join(' ')
  return extra !== '' && !record.title.toLowerCase().includes(extra.toLowerCase()) ? `${record.title}: ${extra}` : record.title
}

/**
 * The first line of the output, else the summary, else (when the summary is the headline) the command, the description or the value.
 * A description is Markdown (the regression rules write a bold lead and a short list): its line is the first sentence of its lead block as
 * plain text, never the bold markers or the flattened list; a plain-prose description reads as it always did.
 */
export function evidenceLine(a: StorySource, headline: { text: string }, ev: StoryEvidence): EvidenceLine | null {
  if (ev.output) {
    const line = firstLine(ev.output)
    // a sweep record reads as its title, and a title that is the headline says nothing new: the next branch speaks
    const record = line ? recordLine(line) : null
    if (line && record === null) return { text: clip(line), kind: 'output' }
    if (record !== null && !same(record, headline.text)) return { text: clip(record), kind: 'output' }
  }
  const summary = clean(annotation(a, 'summary'))
  if (summary && !same(summary, headline.text)) return { text: clip(summary), kind: 'summary' }
  if (ev.command) return { text: clip(firstLine(ev.command)), kind: 'command' }
  const description = firstSentence(descriptionLead(annotation(a, 'description')))
  if (description && !same(description, headline.text)) return { text: clip(description), kind: 'description' }
  if (ev.values.length > 0) return { text: clip(ev.values.map((v) => (v.name === 'Value' ? v.value : `${v.name}=${v.value}`)).join(', ')), kind: 'value' }
  return null
}

// ---- what to do ---------------------------------------------------------------------------------------------------

/** One step per line; a leading "1.", "1)", "-", "*" or a bullet is dropped (the sheet numbers the steps itself). */
export function stepsOf(action: string | undefined): string[] {
  return (action ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').trim())
    .filter(Boolean)
}

// ---- the whole story --------------------------------------------------------------------------------------------

/** The links of one alert sorted into the section each belongs to. */
export interface StoryLinks {
  /** Grafana panel, Open in Grafana, vmalert: the data behind the alert. Rendered inside Evidence. */
  source: EvidenceLink[]
  /** An evidence URL (a file the sweep uploaded). Rendered inside Evidence. */
  evidence: EvidenceLink[]
  /** The runbook. Rendered inside What to do. */
  runbook: EvidenceLink[]
  /** Anything else a URL names (silence). Rendered inside What to do. */
  reference: EvidenceLink[]
  /** The chat panel report and topic. Rendered as the small "Also in the chat panel" line at the bottom, never as a button. */
  chat: EvidenceLink[]
}

export function sortLinks(links: readonly EvidenceLink[]): StoryLinks {
  const pick = (kind: EvidenceLink['kind']): EvidenceLink[] => links.filter((l) => l.kind === kind && l.url)
  return { source: pick('source'), evidence: pick('evidence'), runbook: pick('runbook'), reference: pick('reference'), chat: pick('report') }
}

/**
 * The sweep names one URL twice when it is both the runbook and the proof (a Sentry issue: `runbook_url` and `evidence_url`), and the
 * evidence-link model keeps the first, the runbook. The sender's own `action` says "link under Evidence", so that URL is Evidence.
 */
function evidenceUrlIsEvidence(links: StoryLinks, a: StorySource): StoryLinks {
  const url = webUrl(annotation(a, 'evidence_url'))
  const same = url ? links.runbook.filter((l) => l.url === url) : []
  if (same.length === 0) return links
  const moved = same.map((l): EvidenceLink => ({ ...l, kind: 'evidence', label: 'Open the evidence', short: 'Evidence' }))
  return { ...links, runbook: links.runbook.filter((l) => l.url !== url), evidence: [...links.evidence, ...moved] }
}

export interface Story {
  headline: string
  headlineFrom: HeadlineFrom
  /** The rule class, as the sender named it: "IntakeBugReport". */
  caption: string
  what: { paragraphs: string[]; from: WhatFrom }
  badge: Badge
  crumbs: Crumb[]
  chips: WhereChip[]
  where: string
  evidence: StoryEvidence
  line: EvidenceLine | null
  steps: string[]
  links: StoryLinks
}

/** Everything the sheet shows for one alert. `links` defaults to the evidence-link model's reading of the same alert. */
export function storyOf(a: StorySource, links?: readonly EvidenceLink[]): Story {
  const all = links ?? evidenceLinks(a)
  const headline = headlineOf(a)
  const out = annotation(a, 'evidence_output')
  const cleaned = out ? cleanOutput(out) : null
  const values = valueRows(a)
  const evidence: StoryEvidence = {
    command: commandOf(all),
    output: cleaned && cleaned.text !== '' ? cleaned.text : undefined,
    clipped: cleaned?.clipped ?? false,
    values,
    threshold: values.length > 0 ? thresholdOf(a) : undefined
  }
  const place = placeOf(a)
  const badge = badgeOf(place)
  return {
    headline: headline.text,
    headlineFrom: headline.from,
    caption: clean(a.rule),
    what: whatHappened(a, headline),
    badge,
    crumbs: crumbsOf(place, badge),
    chips: chipsOf(place),
    where: whereLine(a, place),
    evidence,
    line: evidenceLine(a, headline, evidence),
    steps: stepsOf(annotation(a, 'action')),
    links: evidenceUrlIsEvidence(sortLinks(all), a)
  }
}

// ---- the tile: one incident, its worst instance speaking -------------------------------------------------------------

export interface TileStory {
  /** What broke, as a sentence. For a split incident with only an alertname to go on, the target comes first. */
  headline: string
  caption: string
  badge: Badge
  crumbs: Crumb[]
  line: EvidenceLine | null
  /** Instances past the worst one. */
  more: number
}

/** The headline of one incident: a split incident that has only an alertname to go on leads with its target, so a long title is never cut before it. */
export function incidentHeadline(s: Pick<Story, 'headline' | 'headlineFrom'>, rule: string, instance?: string | null): string {
  return instance && s.headlineFrom === 'rule' ? `${instance}: ${humanizeName(rule).toLowerCase()}` : s.headline
}

/**
 * The tile of one incident. `alerts` must be worst first: the worst instance names the headline, the badge and the proof; the
 * tile's own count says how many instances there are. When the instances sit on different hosts the badge says how many, not one name.
 */
export function tileStory(alerts: readonly StorySource[], opts: { rule: string; instance?: string | null }): TileStory {
  const lead = alerts[0] ?? { rule: opts.rule }
  const s = storyOf(lead)
  const more = Math.max(0, alerts.length - 1)
  const headline = incidentHeadline(s, opts.rule, opts.instance)
  const hosts = new Set(alerts.map(hostOf).filter(Boolean))
  const badge: Badge = hosts.size > 1 ? { text: `${hosts.size} hosts`, kind: 'host' } : s.badge
  return { headline, caption: s.caption || opts.rule, badge, crumbs: s.crumbs, line: s.line, more }
}
