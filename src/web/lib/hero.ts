// The error hero of the incident sheet: the one line of real error text an alert carries, and up to four facts about it.
//
// Every source keeps its error in a different place, so one pure function picks it per source and says nothing when the
// source gave no error. A hero is never made up: no error text means no hero, a cleared value ('0') is never the error, and
// a summary the sheet already shows as its title is not repeated under it.
//
//   source          the error line                                                                 the facts (first four present)
//   grafana         a template label (`template`, `tpl`, ...), else the `signature` label, else   Route, Family, Events or Measured,
//                   `status` + `class`; the measured value is a fact, and only while it is real    Silent for, Since, Source
//   sentry          the exception type and message (the issue's title), else the summary after    Culprit, Issue, Events, Users, Release
//                   the culprit; crash-free sessions: the rate and the session count
//   netdata         the alert's value text ("62.9% used, 160.6 GiB free")                          Host, Mount or Chart, Level, Duration
//   prober          the curl error or the HTTP status of the last failed check                     URL, Failed, From
//   regression      the evidence line: the title of a record the sweep printed, else the first     Issue, Events, Users, Project
//   sweep           error-looking line of its captured output, else its summary
//   webhook/others  the summary, when it says more than the title already does                    Value (only while it is real)

import { parseSweepRecord } from '../../shared/sweep-record.ts'

/** What the hero reads. An `Alert` is one, and so is any object with a rule and some labels. */
export interface HeroSource {
  origin?: string
  rule?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  /** The value string a source sent ("A=3, B=3, C=1", "62.9% used, 160.6 GiB free"). */
  value?: string
  via?: ReadonlyArray<{ kind: string }>
  /** The payload the detail endpoint carries (a Sentry issue's title and culprit). */
  raw?: unknown
}

export interface HeroFact {
  name: string
  value: string
}

export type HeroKind = 'grafana' | 'sentry' | 'netdata' | 'prober' | 'sweep' | 'other'

export interface Hero {
  kind: HeroKind
  /** The error, one line of plain text; the sheet draws it large, in the monospaced face, and wraps it. */
  line: string
  /** What the Copy control puts on the clipboard: the line, or the whole signature the line was read from. */
  copy: string
  /** At most four, in the order that serves a person first. */
  facts: HeroFact[]
}

/** The most facts a hero shows: one compact row. */
export const MAX_FACTS = 4
/** A line longer than this is cut on a word, so a captured log line cannot become a wall of its own; Copy keeps the whole of it. */
export const MAX_LINE = 300
const MAX_COPY = 1000
/** What Watch's Sentry source writes between a culprit and a message. */
const EN_DASH = ' \u2013 '

// ---- small readers --------------------------------------------------------------------------------------------------

function clean(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
}

/** Two texts compare equal ignoring case, spacing and punctuation: the hero never repeats the title. */
function same(a: string, b: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  return norm(a) !== '' && norm(a) === norm(b)
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max).replace(/\s+\S*$/, '')
  return `${cut.length > 0 ? cut : s.slice(0, max)}...`
}

function label(a: HeroSource, ...keys: string[]): string {
  for (const k of keys) {
    const v = clean(a.labels?.[k])
    if (v !== '') return v
  }
  return ''
}

function annotation(a: HeroSource, key: string): string {
  for (const [k, v] of Object.entries(a.annotations ?? {})) if (k.toLowerCase() === key && typeof v === 'string' && v.trim() !== '') return v.trim()
  return ''
}

/** A number written as nothing but zero ("0", "0.0", "0%"): a cleared reading, never an error. */
function isZeroText(s: string): boolean {
  return /^[+-]?0+(?:\.0+)?\s*(?:%|[a-z]{0,4})$/i.test(s.trim())
}

function numberText(n: number): string {
  return String(Number(n.toPrecision(4)))
}

// ---- what kind of source ------------------------------------------------------------------------------------------------

export function heroKindOf(a: HeroSource): HeroKind {
  const via = new Set((a.via ?? []).map((v) => v.kind))
  const origin = clean(a.origin).toLowerCase()
  const alertname = label(a, 'alertname') || clean(a.rule)
  if (origin === 'api-uptime' || (label(a, 'component') === 'uptime' && /^(ProbeDown|CertExpiring)$/.test(alertname))) return 'prober'
  if (origin === 'sweep' || label(a, 'sweep_key') !== '') return 'sweep'
  if (via.has('sentry') || (label(a, 'issue_type') !== '' && label(a, 'project') !== '')) return 'sentry'
  if (via.has('netdata-cloud') || via.has('netdata-fleet') || origin.startsWith('netdata') || label(a, 'netdata_severity') !== '' || label(a, 'system') === 'Netdata') return 'netdata'
  if (via.has('grafana') || origin === 'grafana' || label(a, 'grafana_folder') !== '') return 'grafana'
  return 'other'
}

// ---- Grafana ---------------------------------------------------------------------------------------------------------

/**
 * The measured value of a Grafana alert, while it is real. Grafana's own `__values__` (the current evaluation) wins over the value
 * string Watch kept from the last breach: a rule held open after it dropped back under its line reads 0, 0, 0 now, and that is not an
 * error. The threshold variable (its 0 or 1 says only whether the line is crossed) is never the measure. Null when every reading is 0.
 */
export function measuredOf(a: HeroSource): string | null {
  const thresholds = new Set<string>()
  const typed = annotation(a, '__value_string__')
  for (const m of typed.matchAll(/var='(\w+)'[^\]]*?type='(\w+)'/g)) if (m[2] === 'threshold' || m[2] === 'classic_conditions') thresholds.add(m[1])
  let readings: Array<[string, number]> = []
  const json = annotation(a, '__values__')
  if (json !== '') {
    try {
      const parsed: unknown = JSON.parse(json)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        readings = Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))
      }
    } catch {
      // not JSON: read the value string below
    }
  }
  if (readings.length === 0) {
    const pieces = clean(a.value).split(/,\s*/).map((p) => /^([\w.-]+)=(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.exec(p))
    if (pieces.length > 0 && pieces.every((m): m is RegExpExecArray => m !== null)) readings = pieces.map((m) => [m[1], Number(m[2])])
  }
  // with no types to read, the last of three named variables (A query, B reduce, C threshold) is the condition
  if (thresholds.size === 0 && readings.length >= 3 && readings[readings.length - 1][0] === 'C') readings = readings.slice(0, -1)
  const measures = readings.filter(([name]) => !thresholds.has(name))
  const real = measures.find(([name, n]) => name === 'B' && n !== 0) ?? measures.find(([, n]) => n !== 0)
  return real ? numberText(real[1]) : null
}

function withFacts(...rows: Array<[string, string]>): HeroFact[] {
  return rows.filter(([, v]) => v !== '').map(([name, value]) => ({ name, value }))
}

function grafanaHero(a: HeroSource): Pick<Hero, 'line' | 'copy' | 'facts'> | null {
  let line = label(a, 'template', 'tpl', 'error', 'message', 'exception', 'error_text')
  let copy = line
  let route = label(a, 'route', 'path', 'endpoint', 'url')
  let family = label(a, 'family')
  if (line === '') {
    const signature = label(a, 'signature')
    if (signature !== '') {
      const parts = signature.split(' | ').map((p) => p.trim())
      // the edge request-log fingerprint reads: family | METHOD route | status | class
      if (parts.length === 4 && parts.every((p) => p !== '')) {
        line = `${parts[2]} ${parts[3]}`
        route = route || parts[1]
        family = family || parts[0]
      } else {
        line = signature
      }
      copy = signature
    }
  }
  // `status` and `class` are the line itself when nothing else said the error: they are not facts then
  let composed = false
  if (line === '') {
    line = [label(a, 'status', 'http_status', 'code'), label(a, 'class', 'error_class', 'error_type', 'reason')].filter(Boolean).join(' ')
    copy = line
    composed = true
  }
  if (line === '' || isZeroText(line)) return null
  const measured = measuredOf(a)
  const count = label(a, 'count', 'events')
  const events = count !== '' ? count : measured ?? ''
  const eventsName = count !== '' || label(a, 'component') === 'new-errors' ? 'Events' : 'Measured'
  const silent = label(a, 'silent_hours')
  const facts = withFacts(
    ['Route', route],
    ['Family', family],
    [eventsName, events],
    ['Silent for', silent !== '' ? `${silent} h` : ''],
    ['Since', label(a, 'first_seen')],
    ['Source', label(a, 'source')],
    ['Status', composed ? '' : label(a, 'status', 'http_status', 'code')],
    ['Class', composed ? '' : label(a, 'class', 'error_class', 'error_type', 'reason')]
  ).filter((f) => !(f.name === 'Route' || f.name === 'Family' || f.name === 'Source') || f.value.length < 4 || !line.includes(f.value))
  return { line, copy, facts }
}

// ---- Sentry ----------------------------------------------------------------------------------------------------------

function sentryHero(a: HeroSource): Pick<Hero, 'line' | 'copy' | 'facts'> | null {
  const release = label(a, 'release')
  const environment = label(a, 'environment')
  const releaseText = release !== '' ? (environment !== '' ? `${release} (${environment})` : release) : ''
  const crashFree = label(a, 'crashFree')
  if (crashFree !== '') {
    const sessions = label(a, 'sessions')
    const line = sessions !== '' ? `${crashFree} crash-free of ${sessions} sessions` : `${crashFree} crash-free`
    return { line, copy: line, facts: withFacts(['Release', releaseText]) }
  }
  const raw = a.raw && typeof a.raw === 'object' ? (a.raw as Record<string, unknown>) : {}
  let message = clean(raw.title)
  let culprit = clean(raw.culprit)
  if (message === '') {
    // the summary is "<culprit> <en dash> <message>" when the issue has a culprit, the message alone when it has none
    const summary = clean(annotation(a, 'summary'))
    const at = summary.indexOf(EN_DASH)
    if (at > 0) {
      culprit = culprit || summary.slice(0, at).trim()
      message = summary.slice(at + EN_DASH.length).trim()
    } else {
      message = summary
    }
  }
  if (message === '') return null
  return { line: message, copy: message, facts: withFacts(['Culprit', culprit], ['Issue', label(a, 'instance')], ['Events', label(a, 'events')], ['Users', label(a, 'users')], ['Release', releaseText]) }
}

// ---- Netdata ---------------------------------------------------------------------------------------------------------

function netdataHero(a: HeroSource): Pick<Hero, 'line' | 'copy' | 'facts'> | null {
  let text = clean(a.value)
  if (text === '') {
    // the webhook's own message: "disk_space_usage on node-3 is critical: 98.9% used, 3.1 GiB available"; Cloud's summary says it the same way
    const saying = /\bis (?:at )?(?:critical|warning)[^:]*:\s*(.+)$/i
    text = saying.exec(clean(annotation(a, 'description')))?.[1] ?? saying.exec(clean(annotation(a, 'summary')))?.[1] ?? ''
  }
  text = clean(text)
  if (text === '' || isZeroText(text)) return null
  const duration = clean(annotation(a, 'duration'))
  return {
    line: text,
    copy: text,
    facts: withFacts(['Host', label(a, 'host')], label(a, 'mountpoint') !== '' ? ['Mount', label(a, 'mountpoint')] : ['Chart', label(a, 'chart', 'netdata_instance')], ['Level', label(a, 'netdata_severity')], ['Duration', duration])
  }
}

// ---- the uptime prober ---------------------------------------------------------------------------------------------------

/**
 * The prober's description reads "site (https://api.gg/) failed 3 checks in a row, last: no response (curl exit 28: curl: (28) Operation
 * timed out after 10004 milliseconds with 0 bytes received). Probed from node2 once a minute. DOWN is declared after 3 failed checks."
 * The error is what the last check got: the curl message when there is one, else the HTTP status, else the words it gave.
 */
function proberHero(a: HeroSource): Pick<Hero, 'line' | 'copy' | 'facts'> | null {
  const d = clean(annotation(a, 'description'))
  const url = /\((https?:\/\/[^\s)]+)\)/.exec(d)?.[1] ?? ''
  const failed = /failed (\d+) checks? in a row/i.exec(d)?.[1]
  const from = /\bProbed from (\S+?)(?:[.,]|\s|$)/i.exec(d)?.[1] ?? ''
  const tail = /\blast:\s*(.+?)(?:\.\s+(?:Probed|DOWN)\b|$)/i.exec(d)?.[1] ?? ''
  let line = ''
  if (tail !== '') {
    const curl = /curl: \(\d+\)[^()]*/.exec(tail)?.[0]
    const http = /\bHTTP\s*\d{3}\b[^()]*/i.exec(tail)?.[0]
    line = clean(curl ?? http ?? tail.replace(/^\(|\)$/g, ''))
  }
  if (line === '') line = label(a, 'error', 'http_status', 'status')
  if (line === '' || isZeroText(line)) return null
  return {
    line,
    copy: line,
    facts: withFacts(['URL', url || label(a, 'instance')], ['Failed', failed !== undefined ? `${failed} ${failed === '1' ? 'check' : 'checks'} in a row` : ''], ['From', from])
  }
}

// ---- the regression sweep ----------------------------------------------------------------------------------------------

/** Words that make a captured line the error and not the preamble ("exit code: 1" is not; "probe timed out after 30s" is). */
const ERROR_LINE = /\b(?:error|exception|fatal|panic|failed|failure|refused|denied|timed out|timeout|not found|unreachable|ECONN\w+|ETIMEDOUT|ENOTFOUND)\b/i

/** The title of the record the sweep printed (src/shared/sweep-record.ts) is the error; the detail holds an issue id and `key=value` pairs. */
function sweepRecord(first: string): Pick<Hero, 'line' | 'copy' | 'facts'> | null {
  const record = parseSweepRecord(first)
  if (!record) return null
  const { title, detail } = record
  const pair = (key: string): string => new RegExp(`(?:^|\\s)${key}=(\\S+)`).exec(detail)?.[1] ?? ''
  const issue = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\b/.exec(detail)?.[1] ?? ''
  return { line: title, copy: title, facts: withFacts(['Issue', issue], ['Events', pair('count')], ['Users', pair('users')], ['Project', pair('project')]) }
}

function sweepHero(a: HeroSource): Pick<Hero, 'line' | 'copy' | 'facts'> | null {
  const lines = annotation(a, 'evidence_output')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length > 0) {
    const record = sweepRecord(lines[0])
    if (record) return record
    const line = lines.find((l) => ERROR_LINE.test(l)) ?? lines[0]
    return { line, copy: line, facts: [] }
  }
  const summary = clean(annotation(a, 'summary'))
  return summary !== '' ? { line: summary, copy: summary, facts: [] } : null
}

// ---- everything else ---------------------------------------------------------------------------------------------------

function otherHero(a: HeroSource): Pick<Hero, 'line' | 'copy' | 'facts'> | null {
  const summary = clean(annotation(a, 'summary'))
  if (summary === '') return null
  const value = clean(a.value)
  return { line: summary, copy: summary, facts: value !== '' && !isZeroText(value) ? [{ name: 'Value', value }] : [] }
}

// ---- the hero ----------------------------------------------------------------------------------------------------------

/**
 * The hero of one alert, or null when the source gave no error. `title` is the sheet's own title: a line that only repeats it is not a hero.
 * Pure: no clock, no network, nothing but the alert.
 */
export function heroOf(a: HeroSource, title = ''): Hero | null {
  const kind = heroKindOf(a)
  const read = { grafana: grafanaHero, sentry: sentryHero, netdata: netdataHero, prober: proberHero, sweep: sweepHero, other: otherHero }[kind](a)
  if (!read) return null
  const line = clip(clean(read.line), MAX_LINE)
  if (line === '' || isZeroText(line)) return null
  if (title !== '' && same(line, title)) return null
  return { kind, line, copy: clip(read.copy.replace(/\s+/g, ' ').trim(), MAX_COPY), facts: read.facts.slice(0, MAX_FACTS) }
}
