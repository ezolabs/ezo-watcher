import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/server/config.ts'
import type { SentrySourceConfig, WatchConfig } from '../src/server/config.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { createSentrySource, nextPage, normalizeSentry, ruleOfIssue, scrubText } from '../src/server/sources/sentry.ts'
import type { SentryData } from '../src/server/sources/sentry.ts'
import type { SourceDeps } from '../src/server/sources/types.ts'
import { matchedRoutes } from '../src/server/notify/match.ts'

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
// Recorded from org example-org on 2026-10-15 (skills/ezo-watcher/references/sources.md "sentry"): 40 unresolved issues, the Discover rows of 24 h and of 1 h, the 24 h release
// sessions and the project list. Assignees and subscription details are removed; the issues carry no user at all. `acme-web` joined the org on
// 2026-10-21 and is in the project list alone: the rest stays as recorded, and its sessions answer for that day is empty (`groups: []`), which is the case
// the tests below pin.
const recorded = (name: string): any => JSON.parse(readFileSync(here(`./fixtures/${name}.json`), 'utf8'))
const cfg: WatchConfig = loadConfig(here('./fixtures/watch.config.json'))
const source = cfg.sources.find((s) => s.id === 'sentry') as SentrySourceConfig

const NOW = '2026-10-14T21:30:00.000Z' // inside the recorded data: three testflight issues are new and recent
const LATER = '2026-10-15T20:46:00.000Z' // when it was recorded: everything is more than 6 h old or ongoing

const data = (over: Partial<SentryData> = {}): SentryData => ({
  projects: recorded('sentry-projects'),
  issues: recorded('sentry-issues'),
  rows24h: recorded('sentry-events-24h').data,
  rows1h: recorded('sentry-events-1h').data,
  sessions: recorded('sentry-sessions'),
  ...over
})
const run = (d: SentryData = data(), nowIso = NOW, c: SentrySourceConfig = source) => normalizeSentry(d, c, { nowIso, serviceMap: cfg.serviceMap })

const PROJECT = { desktop: '4512066798288896', helper: '4512239803432960', mobile: '4512066651226112', web: '4512295279525888' }

/** A fatal, unhandled production crash in the Helper, as Sentry would list it, with Discover rows for it. */
function crash(over: { count1h?: number; users?: number; environment?: string; release?: string; level?: string; substatus?: string; lastSeen?: string } = {}): SentryData {
  const issue = {
    id: '9000001',
    shortId: 'APP-HELPER-9',
    title: 'Error: write EPIPE',
    culprit: 'Socket.write(helper)',
    level: over.level ?? 'fatal',
    status: 'unresolved',
    substatus: over.substatus ?? 'new',
    isUnhandled: true,
    count: '40',
    userCount: 0,
    firstSeen: '2026-10-14T21:00:00Z',
    lastSeen: over.lastSeen ?? '2026-10-14T21:25:00Z',
    permalink: 'https://example.sentry.io/issues/9000001/',
    project: { id: PROJECT.helper, slug: 'acme-helper' }
  }
  const row = (count: number) => ({ 'issue.id': 9000001, release: over.release ?? 'acme-helper@1.0.14', environment: over.environment ?? 'production', 'count()': count, 'count_unique(user)': over.users ?? 0, 'max(timestamp)': '2026-10-14T21:25:00+00:00' })
  return data({ issues: [issue], rows24h: [row(40)], rows1h: over.count1h === undefined ? [] : [row(over.count1h)] })
}

const session = (project: string, release: string, environment: string, sessions: number, rate: number | null) => ({ by: { project: Number(project), release, environment }, totals: { 'sum(session)': sessions, 'crash_free_rate(session)': rate } })
const withSessions = (...groups: unknown[]): SentryData => data({ issues: [], rows24h: [], sessions: { groups } })

describe('the recorded example-org responses', () => {
  it('reads all 40 issues and raises the three new testflight crashes of the evening of 14 October as warnings', () => {
    expect(recorded('sentry-issues')).toHaveLength(40)
    const obs = run()
    expect(obs.source).toBe('sentry')
    expect(obs.kind).toBe('sentry')
    expect(obs.complete).toBe(true)
    expect(obs.resolved).toEqual([])
    expect(obs.firing.map((a) => a.host).sort()).toEqual(['APP-MOBILE-1Y', 'APP-MOBILE-1Z', 'APP-MOBILE-20'])
    for (const a of obs.firing) {
      expect(a).toMatchObject({ origin: 'sentry', rule: 'SentryNewIssue', service: 'Acme mobile', severity: 'warning' })
      expect(a.labels).toMatchObject({ alertname: 'SentryNewIssue', project: 'acme-mobile', level: 'fatal', environment: 'testflight', issue_type: 'new issue', users: '0' })
      expect(a.labels.release).toMatch(/^com\.example\.acme@/)
      expect(a.labels.firstSeen).toMatch(/^2026-10-14T/)
      expect(a.generatorURL).toMatch(/^https:\/\/example.sentry.io\/issues\/\d+\/$/)
      expect(a.links.generator).toBe(a.generatorURL)
      expect(a.annotations.summary.length).toBeLessThanOrEqual(160)
    }
  })

  it('titles an alert with the culprit and the message, cut short', () => {
    const a = run().firing.find((x) => x.host === 'APP-MOBILE-20')!
    expect(a.annotations.summary).toBe("playbackLevel(index.android) – TypeError: Cannot read property 'start' of undefined")
    const long = run().firing.find((x) => x.host === 'APP-MOBILE-1Y')!
    expect(long.annotations.summary).toMatch(/^UIApplicationDelegate\.main – Fatal App Hang Fully Blocked/)
    expect(long.annotations.summary.endsWith('…')).toBe(true)
  })

  it('carries no user, assignee or email anywhere in an alert, its labels or its raw drill data', () => {
    const text = JSON.stringify(run().firing)
    expect(text).not.toMatch(/assignedTo|"email"|"user":|"ip_address"|owners/)
    expect(text).not.toMatch(/[\w.+-]+@[A-Za-z0-9-]+\.[a-z]{2,}\b/)
  })

  it('raises nothing a day later (everything is quiet or ongoing) and still publishes a solid check for every class on every tile', () => {
    const obs = run(data(), LATER)
    expect(obs.firing).toEqual([])
    expect(obs.checks!.origin).toBe('sentry')
    expect(obs.checks!.complete).toBe(true)
    expect(obs.checks!.cells).toHaveLength(16)
    expect(new Set(obs.checks!.cells.map((c) => c.state))).toEqual(new Set(['ok']))
    expect(new Set(obs.checks!.cells.map((c) => c.service))).toEqual(new Set(['Acme desktop', 'Acme mobile', 'Acme helper', 'Acme web']))
    expect(obs.checks!.cells.map((c) => c.checkId).sort()).toEqual([...Array(4)].flatMap(() => ['SentryCrashFreeLow', 'SentryNewIssue', 'SentryRegression', 'SentrySpike']).sort())
  })

  it('fills the check of a class while it has an issue open, and names the issues', () => {
    const cells = run().checks!.cells
    const cell = cells.find((c) => c.service === 'Acme mobile' && c.checkId === 'SentryNewIssue')!
    expect(cell.state).toBe('firing')
    expect(cell.detail).toMatch(/^3 open: APP-MOBILE-/)
    expect(cells.find((c) => c.service === 'Acme mobile' && c.checkId === 'SentrySpike')!.state).toBe('ok')
  })

  it('never reads acme-server: the Grafana rules and the sweep own the server side', () => {
    expect(Object.keys(source.projects)).not.toContain('acme-server')
    expect(run().firing.some((a) => a.labels.project === 'acme-server')).toBe(false)
  })

  it('reads a acme-web issue like any other, on the Acme web tile', () => {
    const d = crash({ environment: 'testflight' })
    d.issues = [{ ...(d.issues[0] as object), shortId: 'APP-WEB-1', project: { id: PROJECT.web, slug: 'acme-web' } }]
    d.rows24h = [{ ...(d.rows24h[0] as object), release: 'acme-web@1.2.0' }]
    const a = run(d).firing[0]
    expect(a).toMatchObject({ rule: 'SentryNewIssue', service: 'Acme web' })
    expect(a.labels).toMatchObject({ project: 'acme-web', environment: 'testflight', release: 'acme-web@1.2.0' })
  })

  it('keeps a solid crash-free cell and raises nothing for a tile no release of which has sessions: the web bundle sends no release health', () => {
    const obs = run(withSessions())
    expect(obs.firing).toEqual([])
    const cells = obs.checks!.cells.filter((c) => c.service === 'Acme web')
    expect(cells).toHaveLength(4)
    expect(new Set(cells.map((c) => c.state))).toEqual(new Set(['ok']))
    // The honest reading, not a false alarm and not a silent solid: no release has the 50 sessions a rate needs.
    expect(cells.find((c) => c.checkId === 'SentryCrashFreeLow')).toMatchObject({ state: 'ok', detail: 'none low; no release has enough sessions in 24 h' })
  })

  it('reads an empty sessions answer as no sessions rather than an error, so a web-only org still polls', () => {
    const obs = run(data({ sessions: { groups: [] } }))
    expect(obs.complete).toBe(true)
    expect(obs.firing.filter((a) => a.rule === 'SentryCrashFreeLow')).toEqual([])
    expect(obs.checks!.cells.filter((c) => c.checkId === 'SentryCrashFreeLow').every((c) => c.state === 'ok')).toBe(true)
  })
})

describe('which issues are alerts', () => {
  it('maps Sentry substatus to the rule: new, regressed, escalating; ongoing and archived are left alone', () => {
    expect(ruleOfIssue('new')).toBe('SentryNewIssue')
    expect(ruleOfIssue('regressed')).toBe('SentryRegression')
    expect(ruleOfIssue('escalating')).toBe('SentrySpike')
    expect(ruleOfIssue('ongoing')).toBeNull()
    expect(ruleOfIssue('archived_until_escalating')).toBeNull()
  })

  it.each([
    ['regressed', 'SentryRegression', 'regression'],
    ['escalating', 'SentrySpike', 'spike']
  ])('a %s issue is a %s alert', (substatus, rule, word) => {
    const a = run(crash({ substatus, environment: 'testflight' })).firing[0]
    expect(a).toMatchObject({ rule, host: 'APP-HELPER-9' })
    expect(a.labels.issue_type).toBe(word)
  })

  it('ignores an issue Sentry resolved or archived, one below warning, and one of a project that is not listed', () => {
    const d = crash({ environment: 'testflight' })
    expect(run(d).firing).toHaveLength(1)
    expect(run({ ...d, issues: [{ ...(d.issues[0] as object), status: 'resolved' }] }).firing).toEqual([])
    expect(run({ ...d, issues: [{ ...(d.issues[0] as object), level: 'info' }] }).firing).toEqual([])
    expect(run({ ...d, issues: [{ ...(d.issues[0] as object), project: { id: '1', slug: 'acme-server' } }] }).firing).toEqual([])
  })

  it('goes quiet: an issue with no event for the quiet window is no longer in the set, so the engine resolves it', () => {
    const d = crash({ environment: 'testflight', lastSeen: '2026-10-14T21:25:00Z' })
    expect(run(d, '2026-10-15T03:00:00.000Z').firing).toHaveLength(1)
    expect(run(d, '2026-10-15T03:26:00.000Z').firing).toEqual([])
  })

  it('ignores developer builds whatever their environment says, and environments that are not alerted', () => {
    expect(run(crash({ release: 'acme-helper@1.0.13-dev.183' })).firing).toEqual([])
    expect(run(crash({ release: 'com.example.acme.dev@1.0.13+7503', environment: 'testflight' })).firing).toEqual([])
    expect(run(crash({ environment: 'dev' })).firing).toEqual([])
    expect(run(crash({ environment: 'e2e' })).firing).toEqual([])
    expect(run(crash({ environment: 'production' })).firing).toHaveLength(1)
  })

  it('takes the release and environment labels from the issue\'s newest alerted row', () => {
    const d = crash()
    const rows = [
      { 'issue.id': 9000001, release: 'acme-helper@1.0.13', environment: 'production', 'count()': 3, 'count_unique(user)': 0, 'max(timestamp)': '2026-10-14T20:00:00+00:00' },
      { 'issue.id': 9000001, release: 'acme-helper@1.0.14', environment: 'production', 'count()': 5, 'count_unique(user)': 0, 'max(timestamp)': '2026-10-14T21:20:00+00:00' }
    ]
    expect(run({ ...d, rows24h: rows }).firing[0].labels.release).toBe('acme-helper@1.0.14')
  })
})

describe('when it pages', () => {
  it('pages for a fatal crash on a production release at 20 events in the last hour, with the reason and a fresh clock', () => {
    const a = run(crash({ count1h: 20 })).firing[0]
    expect(a.severity).toBe('page')
    expect(a.labels.severity).toBe('page')
    expect(a.annotations.page_reason).toMatch(/20 crash events in the last hour on a production release/)
    expect(a.startsAt).toBe(NOW)
  })

  it('stays a warning under 20 events in the hour, and keeps the issue\'s own onset as its start', () => {
    const a = run(crash({ count1h: 19 })).firing[0]
    expect(a.severity).toBe('warning')
    expect(a.annotations.page_reason).toBeUndefined()
    expect(a.startsAt).toBe('2026-10-14T21:00:00Z')
  })

  it('pages at 5 distinct users in 24 h as well', () => {
    expect(run(crash({ users: 5 })).firing[0].severity).toBe('page')
    expect(run(crash({ users: 4 })).firing[0].severity).toBe('warning')
  })

  it('never pages for a non-fatal, handled issue, a TestFlight build, or a developer build', () => {
    const handled = crash({ count1h: 500, level: 'error' })
    handled.issues = [{ ...(handled.issues[0] as object), isUnhandled: false }]
    expect(run(handled).firing[0].severity).toBe('warning')
    expect(run(crash({ count1h: 500, environment: 'testflight' })).firing[0].severity).toBe('warning')
    expect(run(crash({ count1h: 500, release: 'acme-helper@1.0.13-dev.9' })).firing).toEqual([])
  })

  it('makes a page a different alert from the warning it replaces, so the warning resolves and the page starts its own escalation clock', () => {
    const warn = run(crash({ count1h: 1 })).firing[0]
    const page = run(crash({ count1h: 30 })).firing[0]
    expect(page.key).not.toBe(warn.key)
    expect(run(crash({ count1h: 30 })).firing[0].key).toBe(page.key)
  })

  it('routes: a page reaches a phone, a warning goes to Chat #notifications and nowhere else', () => {
    const reach = (severity: 'page' | 'warning') => matchedRoutes(cfg.routes, { severity, origin: 'sentry', labels: { alertname: 'SentryNewIssue' } }).flatMap((r) => [...r.receivers, ...(r.escalate ?? []).flatMap((e) => e.receivers)])
    expect(reach('page')).toEqual(expect.arrayContaining(['ntfy', 'webpush']))
    expect(reach('warning')).toEqual(['hook'])
  })

  it('pages a production release under 95 % crash-free sessions, and warns under 98 %', () => {
    const low = run(withSessions(session(PROJECT.helper, 'acme-helper@1.0.14', 'production', 200, 0.9)))
    expect(low.firing).toHaveLength(1)
    expect(low.firing[0]).toMatchObject({ rule: 'SentryCrashFreeLow', severity: 'page', host: 'acme-helper@1.0.14', service: 'Acme helper' })
    expect(low.firing[0].annotations.summary).toBe('acme-helper@1.0.14 – 90% of 200 sessions crash-free in 24 h')
    expect(low.firing[0].generatorURL).toBe(`https://example.sentry.io/issues/?project=${PROJECT.helper}&query=release%3Aacme-helper%401.0.14`)
    expect(run(withSessions(session(PROJECT.helper, 'acme-helper@1.0.14', 'production', 200, 0.97))).firing[0].severity).toBe('warning')
    expect(run(withSessions(session(PROJECT.helper, 'acme-helper@1.0.14', 'production', 200, 0.99))).firing).toEqual([])
  })

  it('ignores a release with too few sessions, a developer build, and never pages a TestFlight release', () => {
    expect(run(withSessions(session(PROJECT.helper, 'acme-helper@1.0.14', 'production', 49, 0.5))).firing).toEqual([])
    expect(run(withSessions(session(PROJECT.helper, 'acme-helper@1.0.13-dev.9', 'production', 500, 0.5))).firing).toEqual([])
    expect(run(withSessions(session(PROJECT.mobile, 'com.example.acme@1.0.12+7009', 'testflight', 500, 0.5))).firing[0].severity).toBe('warning')
    expect(run(withSessions(session(PROJECT.helper, 'acme-helper@1.0.14', 'production', 500, null))).firing).toEqual([])
  })

  it('the recorded sessions are all healthy, so none is low', () => {
    expect(run(data({ issues: [], rows24h: [] })).firing).toEqual([])
  })
})

describe('no personal data', () => {
  it('replaces an email address and an IP address in a message, and leaves release names alone', () => {
    expect(scrubText('mail someone@example.com from 192.0.2.3 now', 200)).toBe('mail [email] from [ip] now')
    expect(scrubText('bad host [192.168.0.1]:8080) and fe80:0:0:0:1:2:3:4', 200)).toBe('bad host [ip] and [ip]')
    expect(scrubText('crash in acme-desktop@1.0.12 and com.example.acme@1.0.12+7009 build 1.0.13+7512', 200)).toBe('crash in acme-desktop@1.0.12 and com.example.acme@1.0.12+7009 build 1.0.13+7512')
    expect(scrubText('x'.repeat(5000), 50)).toHaveLength(50)
  })

  it('scrubs the title of an alert', () => {
    const d = crash({ environment: 'testflight' })
    d.issues = [{ ...(d.issues[0] as object), title: 'Error: user someone@example.com at 192.0.2.9 refused' }]
    const a = run(d).firing[0]
    expect(a.annotations.summary).toBe('Socket.write(helper) – Error: user [email] at [ip] refused')
    expect(JSON.stringify(a)).not.toContain('someone@')
  })
})

describe('the engine', () => {
  const engineAt = (clock: { now: number }) => new Engine(openDb(':memory:'), cfg, () => clock.now)

  it('shows one tile per issue, resolves it when the next poll omits it, and keeps a solid cell for each class', () => {
    const clock = { now: Date.parse(NOW) }
    const engine = engineAt(clock)
    engine.ingest(run())
    const w = engine.wall()
    expect(w.incidents.filter((i) => i.service === 'Acme mobile' && i.rule === 'SentryNewIssue')).toHaveLength(3)
    expect(w.incidents.every((i) => i.instance !== null)).toBe(true)
    expect(w.sources.find((s) => s.id === 'sentry')?.kind).toBe('sentry')
    clock.now = Date.parse(LATER)
    engine.ingest(run(data(), LATER))
    const after = engine.wall()
    expect(after.incidents.filter((i) => i.service === 'Acme mobile')).toHaveLength(0)
    const tile = after.health.find((h) => h.service === 'Acme mobile')!
    expect(new Set(tile.cells.map((c) => c.state))).toEqual(new Set(['ok']))
    expect(tile.cells).toHaveLength(4)
  })
})

describe('the poll', () => {
  const API = 'https://us.sentry.io'
  interface Call {
    url: string
    headers: Record<string, string>
  }
  function fakeSentry(
    over: { status?: Partial<Record<'projects' | 'issues' | 'events' | 'sessions', number>>; issuesPages?: unknown[][]; throwOn?: string; sessions?: unknown } = {}
  ): { fetch: typeof fetch; calls: Call[] } {
    const calls: Call[] = []
    const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input))
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
      const path = url.pathname.replace('/api/0/organizations/example-org/', '')
      const which = path.startsWith('projects') ? 'projects' : path.startsWith('issues') ? 'issues' : path.startsWith('events') ? 'events' : path.startsWith('sessions') ? 'sessions' : 'other'
      if (over.throwOn === which) throw new TypeError('fetch failed')
      const status = (over.status as Record<string, number> | undefined)?.[which] ?? 200
      if (status !== 200) return new Response('{"detail":"nope"}', { status })
      if (which === 'projects') return Response.json(recorded('sentry-projects'))
      if (which === 'sessions') return Response.json(over.sessions ?? recorded('sentry-sessions'))
      if (which === 'events') return Response.json(url.searchParams.get('statsPeriod') === '1h' ? recorded('sentry-events-1h') : recorded('sentry-events-24h'))
      const cursor = Number(url.searchParams.get('cursor') ?? 0)
      const pages = over.issuesPages ?? [recorded('sentry-issues')]
      const link = cursor + 1 < pages.length ? `<${API}/api/0/organizations/example-org/issues/?cursor=${cursor + 1}>; rel="next"; results="true"; cursor="${cursor + 1}"` : `<${API}/api/0/organizations/example-org/issues/?cursor=${cursor + 1}>; rel="next"; results="false"; cursor="x"`
      return new Response(JSON.stringify(pages[cursor]), { headers: { link } })
    }
    return { fetch: impl as typeof fetch, calls }
  }
  const deps = (f: { fetch: typeof fetch }, env: NodeJS.ProcessEnv = { SENTRY_READ_TOKEN: 'sntryu_not_a_real_token' }): SourceDeps => ({ fetch: f.fetch, env, nowIso: () => NOW, serviceMap: cfg.serviceMap })

  it('reads projects, issues, the two Discover windows and the sessions, with the token, for the listed projects only', async () => {
    const f = fakeSentry()
    const obs = await createSentrySource(source, deps(f)).poll()
    expect(obs.firing).toHaveLength(3)
    expect(f.calls.map((c) => new URL(c.url).pathname.split('/').pop() || new URL(c.url).pathname.split('/').slice(-2)[0])).toEqual(['projects', 'issues', 'events', 'events', 'sessions'])
    for (const c of f.calls) expect(c.headers.Authorization).toBe('Bearer sntryu_not_a_real_token')
    const issues = new URL(f.calls[1].url)
    expect(issues.origin).toBe(API)
    expect(issues.searchParams.get('query')).toBe('is:unresolved')
    expect(issues.searchParams.getAll('project').sort()).toEqual([PROJECT.desktop, PROJECT.helper, PROJECT.mobile, PROJECT.web].sort())
    expect(f.calls[2].url).toContain('statsPeriod=24h')
    expect(f.calls[3].url).toContain('statsPeriod=1h')
    expect(new URL(f.calls[4].url).searchParams.getAll('groupBy')).toEqual(['project', 'release', 'environment'])
  })

  it('follows the Link header to the next page, and only on the API origin', async () => {
    const all = recorded('sentry-issues') as unknown[]
    const f = fakeSentry({ issuesPages: [all.slice(0, 20), all.slice(20)] })
    const obs = await createSentrySource(source, deps(f)).poll()
    expect(obs.firing).toHaveLength(3)
    expect(f.calls.filter((c) => c.url.includes('/issues/'))).toHaveLength(2)
    expect(nextPage('<https://evil.example/a>; rel="next"; results="true"', API)).toBeNull()
    expect(nextPage(`<${API}/a?cursor=1>; rel="next"; results="true"`, API)).toBe(`${API}/a?cursor=1`)
    expect(nextPage(`<${API}/a?cursor=1>; rel="next"; results="false"`, API)).toBeNull()
    expect(nextPage(null, API)).toBeNull()
  })

  it('fails the whole poll when any request fails, naming the request and the status and never the token or the URL', async () => {
    for (const [which, status] of [['issues', 401], ['events', 500], ['sessions', 403], ['projects', 429]] as const) {
      const err = await createSentrySource(source, deps(fakeSentry({ status: { [which]: status } })))
        .poll()
        .then(() => null, (e: Error) => e)
      expect(err?.message).toMatch(new RegExp(`^Sentry ${which}.* returned HTTP ${status}$`))
      expect(err?.message).not.toMatch(/sntryu|example-org|project=/)
    }
    const net = await createSentrySource(source, deps(fakeSentry({ throwOn: 'sessions' })))
      .poll()
      .then(() => null, (e: Error) => e)
    expect(net?.message).toMatch(/^Sentry sessions request failed/)
  })

  it('fails when the token is not in the environment, naming the variable', async () => {
    await expect(createSentrySource(source, deps(fakeSentry(), {})).poll()).rejects.toThrow('missing environment variable SENTRY_READ_TOKEN')
  })

  it('completes the poll on an empty sessions answer (`groups: []`), the shape acme-web returns, with no crash-free alert', async () => {
    const obs = await createSentrySource(source, deps(fakeSentry({ sessions: { groups: [] } }))).poll()
    expect(obs.complete).toBe(true)
    expect(obs.firing.filter((a) => a.rule === 'SentryCrashFreeLow')).toEqual([])
    const web = obs.checks!.cells.filter((c) => c.service === 'Acme web')
    expect(web).toHaveLength(4)
    expect(web.find((c) => c.checkId === 'SentryCrashFreeLow')).toMatchObject({ state: 'ok', detail: 'none low; no release has enough sessions in 24 h' })
  })
})

describe('config', () => {
  it('watch.json names the source, its tiles and the per-issue split', () => {
    expect(source).toMatchObject({ type: 'sentry', org: 'example-org', tokenEnv: 'SENTRY_READ_TOKEN', url: 'https://us.sentry.io' })
    expect(source.projects).toEqual({ 'acme-desktop': 'Acme desktop', 'acme-mobile': 'Acme mobile', 'acme-helper': 'Acme helper', 'acme-web': 'Acme web' })
    expect(cfg.splitIncidents).toContainEqual({ match: { origin: '^sentry$' }, by: 'instance' })
  })

  it('refuses a source that sends the token over plain http, names no project, or has an upside-down page line', () => {
    const bad = (over: Partial<SentrySourceConfig>): (() => unknown) => () => {
      const c = { ...cfg, sources: [{ ...source, ...over }] }
      return loadConfigFrom(c)
    }
    expect(bad({ url: 'http://us.sentry.io' })).toThrow(/https url/)
    expect(bad({ projects: {} })).toThrow(/needs projects/)
    expect(bad({ crashFreePageBelow: 0.99, crashFreeWarnBelow: 0.98 })).toThrow(/crashFreePageBelow/)
    expect(bad({ devReleases: '(' })).toThrow(/regular expression/)
  })
})

/** loadConfig reads a file; this writes the candidate config to a temp file first. */
function loadConfigFrom(c: WatchConfig): WatchConfig {
  const dir = mkdtempSync(join(tmpdir(), 'watch-sentry-'))
  const p = join(dir, 'watch.json')
  writeFileSync(p, JSON.stringify(c))
  return loadConfig(p)
}
