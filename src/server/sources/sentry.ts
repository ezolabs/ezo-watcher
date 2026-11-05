// Sentry source: the client-side crashes and errors Sentry knows best, read by a poll of its REST API with a read-only user token.
//
// Why a poll and not a webhook (skills/ezo-watcher/references/sources.md, "sentry"): the Free Developer plan has "alerts and notifications via email" only; alert actions
// through an internal integration are on the paid plans (sentry.io/pricing, retrieved 2026-10-15). A poll needs no integration, no firewall rule
// (outbound HTTPS, like Netdata Cloud), sees an issue Sentry marks resolved, and reads release health, which no issue webhook carries.
//
// Wire shapes, all retrieved 2026-10-15 from org example-org and recorded in test/fixtures/sentry-*.json (users and assignees stripped):
//  - GET /api/0/organizations/{org}/projects/                 [{id, slug}]
//  - GET /api/0/organizations/{org}/issues/?query=is:unresolved ...   an issue: id, shortId, title, culprit, level, status, substatus
//    (new | ongoing | regressed | escalating | archived_*), isUnhandled, count, userCount, firstSeen, lastSeen, permalink, project{id,slug}.
//    docs.sentry.io/api/events/list-an-organizations-issues/
//  - GET /api/0/organizations/{org}/events/?dataset=errors&field=issue.id ...   Discover rows per issue, release and environment
//    ({issue.id, issue, project, release, environment, count(), count_unique(user), max(timestamp)}). The issue list carries no release.
//  - GET /api/0/organizations/{org}/sessions/?field=sum(session)&field=crash_free_rate(session)&groupBy=project|release|environment
//    docs.sentry.io/api/releases/retrieve-release-health-session-statistics/
// The pages follow the Link header (`rel="next"; results="true"`) and only to the API origin, so the bearer token never leaves it.
//
// One poll is the complete set. An unresolved issue in the state Sentry calls `new`, `regressed` or `escalating`, seen inside `quietAfterSec`, on a
// release build in an alerted environment, is one alert; it resolves when Sentry resolves or archives the issue, when its substatus moves on
// (new -> ongoing after about a week), or when it goes quiet. Every request must succeed: a poll that fails throws, the engine counts a miss, and
// three misses raise the source-stale warning, so a half-read poll never resolves an alert it could not see.

import { createHash } from 'node:crypto'
import type { Alert, AlertLinks, ChecksPush, Observation, Severity } from '../../shared/types.ts'
import { secret } from '../config.ts'
import type { SentrySourceConfig } from '../config.ts'
import { makeAlert } from '../derive.ts'
import { parseChecks } from './checks.ts'
import type { PolledSource, SourceDeps } from './types.ts'
import { REQUEST_TIMEOUT_MS, clip, describeFailure, isRecord, safeUrl, trimSlash } from './shared.ts'

/** The alertnames (classes) this source fires under. Each is also a check on every project tile, so a quiet tile shows a solid cell for it. */
export const SENTRY_RULES = {
  newIssue: 'SentryNewIssue',
  regression: 'SentryRegression',
  spike: 'SentrySpike',
  crashFree: 'SentryCrashFreeLow'
} as const
type RuleName = (typeof SENTRY_RULES)[keyof typeof SENTRY_RULES]
const ALL_RULES: RuleName[] = [SENTRY_RULES.newIssue, SENTRY_RULES.regression, SENTRY_RULES.spike, SENTRY_RULES.crashFree]
/** The `issue_type` label, in the words Sentry uses. */
const TYPE_WORDS: Record<RuleName, string> = { SentryNewIssue: 'new issue', SentryRegression: 'regression', SentrySpike: 'spike', SentryCrashFreeLow: 'crash-free sessions' }

export const SENTRY_DEFAULTS = {
  environments: ['production', 'testflight'],
  pageEnvironments: ['production'],
  devReleases: '-dev\\.|\\.dev@',
  quietAfterSec: 6 * 3600,
  pageEventsPerHour: 20,
  pageUsers: 5,
  crashFreeMinSessions: 50,
  crashFreeWarnBelow: 0.98,
  crashFreePageBelow: 0.95
} as const

const MAX_PAGES = 5
const DAY_SEC = 86400
const LEVELS = new Set(['fatal', 'error', 'warning'])

// ---- parsed shapes ----------------------------------------------------------------------------------

export interface SentryIssue {
  id: string
  shortId: string
  title: string
  culprit: string
  level: string
  status: string
  substatus: string
  isUnhandled: boolean
  count: number
  userCount: number
  firstSeen: string
  lastSeen: string
  permalink: string | undefined
  projectSlug: string
  projectId: string
}

/** One Discover row: an issue on one release in one environment, over the window. */
export interface SentryRow {
  issueId: string
  release: string
  environment: string
  count: number
  users: number
  lastEventAt: string
}

export interface SentrySession {
  projectId: string
  release: string
  environment: string
  sessions: number
  crashFree: number | null
}

export interface SentryProject {
  id: string
  slug: string
}

/** Everything one poll read, as parsed JSON bodies. `rows24h` and `rows1h` are the Discover data arrays. */
export interface SentryData {
  projects: unknown
  issues: unknown[]
  rows24h: unknown[]
  rows1h: unknown[]
  sessions: unknown
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : 0
}

export function readProjects(body: unknown): SentryProject[] {
  if (!Array.isArray(body)) throw new Error('Sentry projects response is not a list')
  return body.flatMap((p) => (isRecord(p) && str(p.slug) !== '' && str(p.id) !== '' ? [{ id: str(p.id), slug: str(p.slug) }] : []))
}

export function readIssue(raw: unknown): SentryIssue | null {
  if (!isRecord(raw) || !isRecord(raw.project)) return null
  const id = str(raw.id)
  const shortId = str(raw.shortId)
  const projectSlug = str(raw.project.slug)
  if (id === '' || shortId === '' || projectSlug === '' || Number.isNaN(Date.parse(str(raw.lastSeen)))) return null
  return {
    id,
    shortId,
    title: str(raw.title),
    culprit: str(raw.culprit),
    level: str(raw.level),
    status: str(raw.status),
    substatus: str(raw.substatus),
    isUnhandled: raw.isUnhandled === true,
    count: num(raw.count),
    userCount: num(raw.userCount),
    firstSeen: str(raw.firstSeen),
    lastSeen: str(raw.lastSeen),
    permalink: safeUrl(raw.permalink),
    projectSlug,
    projectId: str(raw.project.id)
  }
}

export function readRow(raw: unknown): SentryRow | null {
  if (!isRecord(raw)) return null
  const issueId = str(raw['issue.id'])
  const release = str(raw.release)
  if (issueId === '' || release === '') return null
  return { issueId, release, environment: str(raw.environment), count: num(raw['count()']), users: num(raw['count_unique(user)']), lastEventAt: str(raw['max(timestamp)']) }
}

export function readSessions(body: unknown): SentrySession[] {
  if (!isRecord(body) || !Array.isArray(body.groups)) throw new Error('Sentry sessions response has an unexpected shape')
  const out: SentrySession[] = []
  for (const g of body.groups) {
    if (!isRecord(g) || !isRecord(g.by) || !isRecord(g.totals)) continue
    const rate = g.totals['crash_free_rate(session)']
    out.push({
      projectId: str(g.by.project),
      release: str(g.by.release),
      environment: str(g.by.environment),
      sessions: num(g.totals['sum(session)']),
      crashFree: typeof rate === 'number' && Number.isFinite(rate) ? rate : null
    })
  }
  return out
}

// ---- no personal data -------------------------------------------------------------------------------

const MAX_WORD = 200

function looksLikeEmail(w: string): boolean {
  const at = w.indexOf('@')
  if (at < 1 || at === w.length - 1) return false
  const domain = w.slice(at + 1).replace(/[^A-Za-z0-9]+$/, '')
  const dot = domain.lastIndexOf('.')
  if (dot < 1) return false
  return /^[A-Za-z]{2,24}$/.test(domain.slice(dot + 1)) && /^[A-Za-z0-9.-]+$/.test(domain.slice(0, dot))
}

function looksLikeIp(w: string): boolean {
  const v4 = /^[[(]?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d{1,5})?[\])]?(?::\d{1,5})?[^A-Za-z0-9]*$/.exec(w)
  if (v4) return v4.slice(1, 5).every((o) => Number(o) <= 255)
  return /^[0-9a-f:]{6,45}$/i.test(w) && w.split(':').length >= 4
}

/**
 * An error message or a culprit as one line with no email address and no IP address in it, cut to `max`. Sentry already scrubs IPs
 * server-side; this is the second hand, word by word (a word is bounded, so no pattern here can run long).
 */
export function scrubText(text: string, max: number): string {
  const words = text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '')
    .map((w) => {
      const word = w.length > MAX_WORD ? w.slice(0, MAX_WORD) : w
      return looksLikeEmail(word) ? '[email]' : looksLikeIp(word) ? '[ip]' : word
    })
  return clip(words.join(' '), max)
}

// ---- the poll's arithmetic --------------------------------------------------------------------------

export interface NormalizeCtx {
  nowIso: string
  serviceMap: SourceDeps['serviceMap']
}

type Resolved = Required<Pick<SentrySourceConfig, 'quietAfterSec' | 'pageEventsPerHour' | 'pageUsers' | 'crashFreeMinSessions' | 'crashFreeWarnBelow' | 'crashFreePageBelow'>> & {
  environments: ReadonlySet<string>
  pageEnvironments: ReadonlySet<string>
  dev: RegExp
}

function resolve(cfg: SentrySourceConfig): Resolved {
  return {
    environments: new Set(cfg.environments ?? SENTRY_DEFAULTS.environments),
    pageEnvironments: new Set(cfg.pageEnvironments ?? SENTRY_DEFAULTS.pageEnvironments),
    dev: new RegExp(cfg.devReleases ?? SENTRY_DEFAULTS.devReleases),
    quietAfterSec: cfg.quietAfterSec ?? SENTRY_DEFAULTS.quietAfterSec,
    pageEventsPerHour: cfg.pageEventsPerHour ?? SENTRY_DEFAULTS.pageEventsPerHour,
    pageUsers: cfg.pageUsers ?? SENTRY_DEFAULTS.pageUsers,
    crashFreeMinSessions: cfg.crashFreeMinSessions ?? SENTRY_DEFAULTS.crashFreeMinSessions,
    crashFreeWarnBelow: cfg.crashFreeWarnBelow ?? SENTRY_DEFAULTS.crashFreeWarnBelow,
    crashFreePageBelow: cfg.crashFreePageBelow ?? SENTRY_DEFAULTS.crashFreePageBelow
  }
}

/** The rule class of an issue by Sentry's own substatus, or null for a state this source leaves alone (ongoing, archived). */
export function ruleOfIssue(substatus: string): RuleName | null {
  if (substatus === 'regressed') return SENTRY_RULES.regression
  if (substatus === 'escalating') return SENTRY_RULES.spike
  if (substatus === 'new') return SENTRY_RULES.newIssue
  return null
}

const fingerprintOf = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex')
const pct = (rate: number): string => `${Math.round(rate * 1000) / 10}%`

/**
 * One poll's data as the Observation. Pure: no clock, no network. The tier is part of an alert's fingerprint, so a warning that becomes a page is a new
 * alert with a fresh clock (the escalation to SMS and email counts from its start), and the warning it replaced resolves.
 */
export function normalizeSentry(data: SentryData, cfg: SentrySourceConfig, ctx: NormalizeCtx): Observation {
  const o = resolve(cfg)
  const nowMs = Date.parse(ctx.nowIso)
  const projects = readProjects(data.projects)
  const watched = projects.filter((p) => p.slug in cfg.projects)
  const slugOfId = new Map(watched.map((p) => [p.id, p.slug]))
  const idOfSlug = new Map(watched.map((p) => [p.slug, p.id]))
  const present = new Set(idOfSlug.keys())
  const web = trimSlash(cfg.webUrl)

  // Release builds in an alerted environment only. Dev builds label themselves `production` in the Helper, so the release name decides too.
  const qualifies = (release: string, environment: string): boolean => o.environments.has(environment) && !o.dev.test(release)
  const rows = new Map<string, SentryRow[]>()
  for (const raw of data.rows24h) {
    const r = readRow(raw)
    if (r && qualifies(r.release, r.environment)) rows.set(r.issueId, [...(rows.get(r.issueId) ?? []), r])
  }
  /** Events in the last hour per issue: every alerted environment (what the tile says), and the page environments alone (what can page). */
  const lastHour = new Map<string, { all: number; page: number }>()
  for (const raw of data.rows1h) {
    const r = readRow(raw)
    if (!r || !qualifies(r.release, r.environment)) continue
    const h = lastHour.get(r.issueId) ?? { all: 0, page: 0 }
    h.all += r.count
    if (o.pageEnvironments.has(r.environment)) h.page += r.count
    lastHour.set(r.issueId, h)
  }

  const firing: Alert[] = []
  const seen = new Set<string>()
  const add = (a: Alert): void => {
    if (seen.has(a.key)) return
    seen.add(a.key)
    firing.push(a)
  }
  const open = new Map<string, Alert[]>()
  const tag = (tile: string, rule: RuleName, a: Alert): void => {
    const k = `${tile}\u0000${rule}`
    open.set(k, [...(open.get(k) ?? []), a])
  }

  for (const raw of data.issues) {
    const issue = readIssue(raw)
    if (!issue) continue
    const tile = cfg.projects[issue.projectSlug]
    if (!tile || issue.status !== 'unresolved' || !LEVELS.has(issue.level)) continue
    const rule = ruleOfIssue(issue.substatus)
    if (!rule) continue
    if (nowMs - Date.parse(issue.lastSeen) > o.quietAfterSec * 1000) continue
    const mine = rows.get(issue.id)
    if (!mine || mine.length === 0) continue
    const newest = mine.reduce((m, r) => (r.lastEventAt > m.lastEventAt ? r : m))

    const crash = issue.level === 'fatal' || issue.isUnhandled
    const pageRows = mine.filter((r) => o.pageEnvironments.has(r.environment))
    const hours = lastHour.get(issue.id) ?? { all: 0, page: 0 }
    const hour = hours.page
    const users = Math.max(issue.userCount, ...mine.map((r) => r.users))
    const pageUsers = Math.max(0, ...pageRows.map((r) => r.users))
    let pageReason: string | undefined
    if (crash && pageRows.length > 0) {
      if (hour >= o.pageEventsPerHour) pageReason = `${hour} crash events in the last hour on a production release (a page is ${o.pageEventsPerHour} or more)`
      else if (pageUsers >= o.pageUsers) pageReason = `${pageUsers} users hit by a crash on a production release in 24 h (a page is ${o.pageUsers} or more)`
    }
    const severity: Severity = pageReason ? 'page' : 'warning'

    const message = scrubText(issue.title, 200)
    const culprit = scrubText(issue.culprit, 80)
    const culpritText = culprit === '' || culprit === '?' || culprit === '<unknown>' ? '' : culprit
    const summary = clip(culpritText ? `${culpritText} – ${message}` : message, 160)
    const events = `${issue.count} event${issue.count === 1 ? '' : 's'}`
    const alert = makeAlert(
      {
        origin: cfg.id,
        fingerprint: fingerprintOf('issue', cfg.id, issue.id, rule, severity),
        rule,
        labels: {
          alertname: rule,
          severity,
          service: tile,
          instance: issue.shortId,
          project: issue.projectSlug,
          issue_type: TYPE_WORDS[rule],
          level: issue.level,
          release: newest.release,
          environment: newest.environment,
          firstSeen: issue.firstSeen,
          users: String(users),
          events: String(issue.count)
        },
        annotations: {
          summary,
          description: `${TYPE_WORDS[rule]} in ${issue.projectSlug}${crash ? ' (a crash)' : ''}: ${events}, ${users} user${users === 1 ? '' : 's'}, first seen ${issue.firstSeen}, last seen ${issue.lastSeen}, release ${newest.release} (${newest.environment})`,
          ...(pageReason ? { page_reason: pageReason } : {})
        },
        // A page's clock starts when Watch first sees it at that tier; a warning keeps the issue's own onset.
        startsAt: rule === SENTRY_RULES.newIssue && severity === 'warning' && Number.isFinite(Date.parse(issue.firstSeen)) && Date.parse(issue.firstSeen) <= nowMs ? issue.firstSeen : ctx.nowIso,
        generatorURL: issue.permalink,
        value: `${hours.all} in the last hour, ${events} in all`,
        links: issue.permalink ? ({ generator: issue.permalink } satisfies AlertLinks) : {},
        via: { source: cfg.id, kind: 'sentry', lastSeen: ctx.nowIso, ...(issue.permalink ? { url: issue.permalink } : {}) },
        // The raw drill level: the fields a person needs, and none of Sentry's user, assignee or owner fields.
        raw: { id: issue.id, shortId: issue.shortId, title: message, culprit: culpritText, level: issue.level, status: issue.status, substatus: issue.substatus, isUnhandled: issue.isUnhandled, project: issue.projectSlug, count: issue.count, userCount: issue.userCount, firstSeen: issue.firstSeen, lastSeen: issue.lastSeen, permalink: issue.permalink, releases: mine }
      },
      ctx.serviceMap,
      ctx.nowIso
    )
    add(alert)
    tag(tile, rule, alert)
  }

  // Crash-free sessions per release, over the last 24 hours.
  const lowest = new Map<string, { rate: number; sessions: number; release: string }>()
  for (const s of readSessions(data.sessions)) {
    const slug = slugOfId.get(s.projectId)
    if (!slug || !qualifies(s.release, s.environment) || s.crashFree === null || s.sessions < o.crashFreeMinSessions) continue
    const tile = cfg.projects[slug]
    const prev = lowest.get(tile)
    if (!prev || s.crashFree < prev.rate) lowest.set(tile, { rate: s.crashFree, sessions: s.sessions, release: s.release })
    if (s.crashFree >= o.crashFreeWarnBelow) continue
    const pageIt = s.crashFree < o.crashFreePageBelow && o.pageEnvironments.has(s.environment)
    const severity: Severity = pageIt ? 'page' : 'warning'
    const alert = makeAlert(
      {
        origin: cfg.id,
        fingerprint: fingerprintOf('crash-free', cfg.id, slug, s.release, s.environment, severity),
        rule: SENTRY_RULES.crashFree,
        labels: {
          alertname: SENTRY_RULES.crashFree,
          severity,
          service: tile,
          instance: s.release,
          project: slug,
          issue_type: TYPE_WORDS[SENTRY_RULES.crashFree],
          level: 'fatal',
          release: s.release,
          environment: s.environment,
          sessions: String(s.sessions),
          crashFree: pct(s.crashFree)
        },
        annotations: {
          summary: `${s.release} – ${pct(s.crashFree)} of ${s.sessions} sessions crash-free in 24 h`,
          description: `Crash-free sessions of ${s.release} (${s.environment}) in the last 24 h: ${pct(s.crashFree)} of ${s.sessions}. A warning is under ${pct(o.crashFreeWarnBelow)}, a page under ${pct(o.crashFreePageBelow)} on a production release.`,
          ...(pageIt ? { page_reason: `crash-free sessions ${pct(s.crashFree)}, under the ${pct(o.crashFreePageBelow)} page line, on a production release with ${s.sessions} sessions` } : {})
        },
        startsAt: ctx.nowIso,
        generatorURL: `${web}/issues/?project=${idOfSlug.get(slug) ?? ''}&query=${encodeURIComponent(`release:${s.release}`)}`,
        value: `${pct(s.crashFree)} crash-free of ${s.sessions} sessions`,
        links: {},
        via: { source: cfg.id, kind: 'sentry', lastSeen: ctx.nowIso },
        raw: { project: slug, release: s.release, environment: s.environment, sessions: s.sessions, crashFree: s.crashFree }
      },
      ctx.serviceMap,
      ctx.nowIso
    )
    add(alert)
    tag(tile, SENTRY_RULES.crashFree, alert)
  }

  return {
    source: cfg.id,
    kind: 'sentry',
    at: ctx.nowIso,
    firing,
    resolved: [],
    complete: true,
    checks: buildChecks(cfg, { present, open, lowest, nowIso: ctx.nowIso })
  }
}

/** One check per tile and class: solid when it ran and nothing is open, filled while something is. A tile none of whose projects Sentry knows is skipped (dashed). */
function buildChecks(
  cfg: SentrySourceConfig,
  s: { present: Set<string>; open: Map<string, Alert[]>; lowest: Map<string, { rate: number; sessions: number; release: string }>; nowIso: string }
): ChecksPush {
  const tiles = new Map<string, string[]>()
  for (const [slug, tile] of Object.entries(cfg.projects)) tiles.set(tile, [...(tiles.get(tile) ?? []), slug])
  const list: Array<Record<string, unknown>> = []
  for (const [tile, slugs] of tiles) {
    const known = slugs.filter((x) => s.present.has(x))
    for (const rule of ALL_RULES) {
      if (known.length === 0) {
        list.push({ id: rule, service: tile, state: 'skipped', detail: `${slugs.join(', ')} not found in Sentry` })
        continue
      }
      const mine = s.open.get(`${tile}\u0000${rule}`) ?? []
      let detail: string
      if (mine.length > 0) detail = `${mine.length} open: ${mine.slice(0, 3).map((a) => a.labels.instance).join(', ')}${mine.length > 3 ? ', ...' : ''}`
      else if (rule === SENTRY_RULES.crashFree) {
        const low = s.lowest.get(tile)
        detail = low ? `none low; lowest ${pct(low.rate)} of ${low.sessions} sessions (${low.release})` : 'none low; no release has enough sessions in 24 h'
      } else detail = 'none open'
      list.push({ id: rule, service: tile, state: mine.length > 0 ? 'failing' : 'ok', lastRunAt: s.nowIso, detail })
    }
  }
  return parseChecks({ staleAfterSec: Math.max(300, cfg.pollSec * 4), complete: true, list }, { origin: cfg.id, source: cfg.id, now: s.nowIso })
}

// ---- the source -------------------------------------------------------------------------------------

/** The next page's URL when Sentry's Link header says there is one, and only when it stays on the API origin. */
export function nextPage(link: string | null, origin: string): string | null {
  if (!link) return null
  const m = /<([^>]+)>;\s*rel="next";\s*results="true"/.exec(link)
  if (!m) return null
  try {
    return new URL(m[1]).origin === origin ? m[1] : null
  } catch {
    return null
  }
}

export function createSentrySource(cfg: SentrySourceConfig, deps: SourceDeps): PolledSource {
  const apiOrigin = new URL(cfg.url).origin
  const base = `${trimSlash(cfg.url)}/api/0/organizations/${encodeURIComponent(cfg.org)}`
  const o = resolve(cfg)

  async function page(url: string, headers: Record<string, string>, label: string): Promise<{ body: unknown; next: string | null }> {
    let res: Response
    try {
      res = await deps.fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (err) {
      throw new Error(`${label} request failed: ${describeFailure(err)}`)
    }
    // The status only: the URL carries the project ids and the query, the headers carry the token.
    if (!res.ok) throw new Error(`${label} returned HTTP ${res.status}`)
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new Error(`${label} returned a body that is not JSON`)
    }
    return { body, next: nextPage(res.headers.get('link'), apiOrigin) }
  }

  /** A list endpoint read to its end, at most MAX_PAGES pages. `pick` takes the list out of a body. */
  async function list(url: string, headers: Record<string, string>, label: string, pick: (body: unknown) => unknown[]): Promise<unknown[]> {
    const out: unknown[] = []
    let next: string | null = url
    for (let i = 0; next && i < MAX_PAGES; i++) {
      const p = await page(next, headers, label)
      out.push(...pick(p.body))
      next = p.next
    }
    if (next) deps.log?.(`source ${cfg.id}: ${label} has more than ${MAX_PAGES} pages, the rest are not read`)
    return out
  }

  const query = (pairs: Array<[string, string]>): string => {
    const q = new URLSearchParams()
    for (const [k, v] of pairs) q.append(k, v)
    return q.toString()
  }

  async function poll(): Promise<Observation> {
    const headers = { Authorization: `Bearer ${secret(deps.env, cfg.tokenEnv)}`, Accept: 'application/json' }
    const now = deps.nowIso()
    const projectsBody = (await page(`${base}/projects/`, headers, 'Sentry projects')).body
    const ids = readProjects(projectsBody).filter((p) => p.slug in cfg.projects).map((p) => p.id)
    if (ids.length === 0) throw new Error('none of the configured projects exist in Sentry')
    const projectPairs = ids.map((id): [string, string] => ['project', id])
    const eventsWindow = `${Math.ceil(Math.max(DAY_SEC, o.quietAfterSec) / 3600)}h`
    const asList = (what: string) => (body: unknown): unknown[] => {
      if (!Array.isArray(body)) throw new Error(`${what} response is not a list`)
      return body
    }
    const dataOf = (what: string) => (body: unknown): unknown[] => {
      if (!isRecord(body) || !Array.isArray(body.data)) throw new Error(`${what} response has an unexpected shape`)
      return body.data
    }
    const discover = (period: string): Array<[string, string]> => [
      ['dataset', 'errors'],
      ['field', 'issue.id'],
      ['field', 'release'],
      ['field', 'environment'],
      ['field', 'count()'],
      ['field', 'count_unique(user)'],
      ['field', 'max(timestamp)'],
      ['query', 'is:unresolved'],
      ['statsPeriod', period],
      ['per_page', '100'],
      ['sort', '-max(timestamp)'],
      ...projectPairs
    ]

    const issues = await list(
      `${base}/issues/?${query([['query', 'is:unresolved'], ['statsPeriod', `${Math.ceil(o.quietAfterSec / 3600)}h`], ['sort', 'date'], ['limit', '100'], ['collapse', 'stats'], ['collapse', 'lifetime'], ['collapse', 'filtered'], ...projectPairs])}`,
      headers,
      'Sentry issues',
      asList('Sentry issues')
    )
    const rows24h = await list(`${base}/events/?${query(discover(eventsWindow))}`, headers, 'Sentry events', dataOf('Sentry events'))
    const rows1h = await list(`${base}/events/?${query(discover('1h'))}`, headers, 'Sentry events (last hour)', dataOf('Sentry events'))
    const sessions = (
      await page(
        `${base}/sessions/?${query([['field', 'sum(session)'], ['field', 'crash_free_rate(session)'], ['groupBy', 'project'], ['groupBy', 'release'], ['groupBy', 'environment'], ['statsPeriod', '24h'], ['interval', '1h'], ['includeSeries', '0'], ['per_page', '100'], ...projectPairs])}`,
        headers,
        'Sentry sessions'
      )
    ).body
    return normalizeSentry({ projects: projectsBody, issues, rows24h, rows1h, sessions }, cfg, { nowIso: now, serviceMap: deps.serviceMap })
  }

  return { id: cfg.id, kind: 'sentry', name: 'Sentry', pollSec: cfg.pollSec, poll }
}
