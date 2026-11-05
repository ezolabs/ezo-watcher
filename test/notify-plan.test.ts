import { describe, expect, it } from 'vitest'
import type { RouteConfig } from '../src/server/config.ts'
import { matchedRoutes, routeMatches, usableRoutes } from '../src/server/notify/match.ts'
import { backoffMs, fingerprintDigest, isDue, logKey, planSends } from '../src/server/notify/plan.ts'
import type { Plan } from '../src/server/notify/plan.ts'
import type { LogRow, NotifyView, ResolvedView } from '../src/server/notify/types.ts'

const T0 = Date.parse('2026-10-14T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

function view(over: Partial<NotifyView> = {}): NotifyView {
  return {
    key: 'edge|EdgeDead',
    service: 'edge',
    rule: 'EdgeDead',
    summary: 'API edge dead',
    severity: 'page',
    severityLabel: 'critical',
    origin: 'grafana',
    labels: { team: 'ops' },
    instances: [{ fingerprint: 'fp1', name: 'web-1', value: '0', startsAt: iso(T0) }],
    startsAt: iso(T0),
    firstSeen: iso(T0),
    attention: 'none',
    unattendedSec: 0,
    flapping: false,
    links: {},
    ...over
  }
}

function resolvedView(over: Partial<ResolvedView> = {}): ResolvedView {
  return {
    key: 'edge|EdgeDead',
    service: 'edge',
    rule: 'EdgeDead',
    summary: 'API edge dead',
    severity: 'page',
    origin: 'grafana',
    labels: { team: 'ops' },
    startsAt: iso(T0),
    resolvedAt: iso(T0 + 1_800_000),
    durationSec: 1800,
    stableForSec: 600,
    wasNotified: true,
    ...over
  }
}

function route(over: Partial<RouteConfig> = {}): RouteConfig {
  return {
    id: 'r1',
    match: {},
    receivers: ['ntfy'],
    mode: 'all',
    groupWaitSec: 30,
    groupIntervalSec: 300,
    repeatIntervalSec: 3600,
    ...over
  }
}

function okRow(key: string, sentAt: number, digest: string, over: Partial<LogRow> = {}): LogRow {
  return { key, sentAt, digest, ok: true, attempts: 0, nextAttemptAt: null, ...over }
}

interface World {
  routes?: RouteConfig[]
  views?: NotifyView[]
  resolved?: ResolvedView[]
  now?: number
  quiet?: boolean
  logs?: LogRow[]
  held?: Record<string, string[]>
}

function plan(w: World): Plan {
  const logs = new Map((w.logs ?? []).map((r) => [r.key, r]))
  return planSends({
    routes: w.routes ?? [route()],
    views: w.views ?? [view()],
    resolved: w.resolved ?? [],
    nowMs: w.now ?? T0 + 30_000,
    quiet: w.quiet ?? false,
    getLog: (k) => logs.get(k) ?? null,
    getHeld: (id) => w.held?.[id] ?? []
  })
}

const alertKey = (receiver = 'ntfy', routeId = 'r1') => logKey('edge|EdgeDead', routeId, receiver, 'alert')

describe('isDue', () => {
  const gate = { groupIntervalSec: 300, repeatIntervalSec: 3600 }
  const row = okRow('k', T0, 'a')

  it('sends when there is no row or the last attempt never landed', () => {
    expect(isDue(null, null, 'a', T0, gate)).toBe(true)
    expect(isDue({ ...row, ok: false }, null, 'a', T0, gate)).toBe(true)
  })

  it('waits out a retry gate even for a row that never landed', () => {
    expect(isDue({ ...row, ok: false }, T0 + 5000, 'a', T0 + 4999, gate)).toBe(false)
    expect(isDue({ ...row, ok: false }, T0 + 5000, 'a', T0 + 5000, gate)).toBe(true)
  })

  it('holds an unchanged digest until exactly the repeat interval', () => {
    expect(isDue(row, null, 'a', T0 + 3_599_999, gate)).toBe(false)
    expect(isDue(row, null, 'a', T0 + 3_600_000, gate)).toBe(true)
  })

  it('lets a changed digest through only after the group interval', () => {
    expect(isDue(row, null, 'b', T0 + 299_999, gate)).toBe(false)
    expect(isDue(row, null, 'b', T0 + 300_000, gate)).toBe(true)
  })

  it('never repeats a once-only stage after it landed', () => {
    expect(isDue(row, null, 'a', T0 + 99_999_999, gate, true)).toBe(false)
  })
})

describe('backoff and digest', () => {
  it('doubles from 5 s and caps at 300 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 30].map(backoffMs)).toEqual([5000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000])
  })

  it('hashes the sorted fingerprints, so order does not matter', () => {
    const a = view({ instances: [{ fingerprint: 'b', name: 'x', startsAt: '' }, { fingerprint: 'a', name: 'y', startsAt: '' }] })
    const b = view({ instances: [{ fingerprint: 'a', name: 'y', startsAt: '' }, { fingerprint: 'b', name: 'x', startsAt: '' }] })
    expect(fingerprintDigest(a)).toBe(fingerprintDigest(b))
    expect(fingerprintDigest(a)).not.toBe(fingerprintDigest(view()))
    expect(fingerprintDigest(view())).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('routing', () => {
  const item = { severity: 'warning' as const, origin: 'grafana', labels: { team: 'ops', env: 'prod' } }

  it('requires every present matcher', () => {
    expect(routeMatches(route(), item)).toBe(true)
    expect(routeMatches(route({ match: { severity: ['page'] } }), item)).toBe(false)
    expect(routeMatches(route({ match: { severity: ['page', 'warning'], origin: ['grafana'] } }), item)).toBe(true)
    expect(routeMatches(route({ match: { origin: ['prod'] } }), item)).toBe(false)
    expect(routeMatches(route({ match: { labels: { team: 'ops', env: 'prod|stage' } } }), item)).toBe(true)
    expect(routeMatches(route({ match: { labels: { team: 'ops', env: 'dev' } } }), item)).toBe(false)
  })

  it('anchors label regexps and reads an absent label as empty', () => {
    expect(routeMatches(route({ match: { labels: { team: 'op' } } }), item)).toBe(false)
    expect(routeMatches(route({ match: { labels: { team: 'o.*' } } }), item)).toBe(true)
    expect(routeMatches(route({ match: { labels: { owner: '.*' } } }), item)).toBe(true)
    expect(routeMatches(route({ match: { labels: { owner: '.+' } } }), item)).toBe(false)
    expect(routeMatches(route({ match: { labels: { team: '(' } } }), item)).toBe(false)
  })

  it('stops at the first match unless a route continues', () => {
    const a = route({ id: 'a' })
    const b = route({ id: 'b' })
    const c = route({ id: 'c' })
    expect(matchedRoutes([a, b, c], item).map((r) => r.id)).toEqual(['a'])
    expect(matchedRoutes([{ ...a, continue: true }, b, c], item).map((r) => r.id)).toEqual(['a', 'b'])
    expect(matchedRoutes([{ ...a, continue: true }, { ...b, continue: true }, c], item).map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(matchedRoutes([route({ id: 'x', match: { severity: ['page'] } }), b], item).map((r) => r.id)).toEqual(['b'])
  })
})

describe('planSends: firing incidents', () => {
  it('waits for group_wait, then plans one alert with its log key and digest', () => {
    expect(plan({ now: T0 + 29_999 }).sends).toEqual([])
    const p = plan({ now: T0 + 30_000 })
    expect(p.sends).toHaveLength(1)
    expect(p.sends[0]).toMatchObject({
      routeId: 'r1',
      incidentKey: 'edge|EdgeDead',
      kind: 'alert',
      stage: 'alert',
      mode: 'all',
      targets: [{ channelId: 'ntfy', logKey: alertKey() }],
      digest: fingerprintDigest(view()),
      record: []
    })
    expect(p.held).toEqual([])
  })

  it('plans nothing inside the repeat interval, however often it is asked', () => {
    const logs = [okRow(alertKey(), T0 + 30_000, fingerprintDigest(view()))]
    for (let i = 1; i <= 20; i++) {
      expect(plan({ logs, now: T0 + 30_000 + i * 10_000 }).sends).toEqual([])
    }
    expect(plan({ logs, now: T0 + 30_000 + 3_600_000 }).sends).toHaveLength(1)
  })

  it('plans only the receivers that are due in mode all', () => {
    const logs = [okRow(alertKey('ntfy'), T0 + 30_000, fingerprintDigest(view()))]
    const p = plan({ routes: [route({ receivers: ['ntfy', 'sms'] })], logs, now: T0 + 60_000 })
    expect(p.sends).toHaveLength(1)
    expect(p.sends[0].targets.map((t) => t.channelId)).toEqual(['sms'])
  })

  it('treats a ladder as one unit: the newest success and the latest retry gate decide', () => {
    const r = route({ receivers: ['ntfy', 'sms'], mode: 'ladder' })
    const digest = fingerprintDigest(view())
    const sentAt = T0 + 30_000
    const failedNtfy: LogRow = { key: alertKey('ntfy'), sentAt: 0, digest: '', ok: false, attempts: 1, nextAttemptAt: sentAt + 5000 }
    // sms landed: the ladder is satisfied even though ntfy failed and its gate has passed
    expect(plan({ routes: [r], logs: [failedNtfy, okRow(alertKey('sms'), sentAt, digest)], now: sentAt + 10_000 }).sends).toEqual([])
    // both failed: nothing before the later gate, then the whole ladder again, in order
    const failedSms: LogRow = { ...failedNtfy, key: alertKey('sms'), nextAttemptAt: sentAt + 10_000 }
    expect(plan({ routes: [r], logs: [failedNtfy, failedSms], now: sentAt + 9999 }).sends).toEqual([])
    const again = plan({ routes: [r], logs: [failedNtfy, failedSms], now: sentAt + 10_000 })
    expect(again.sends[0].targets.map((t) => t.channelId)).toEqual(['ntfy', 'sms'])
  })

  it('plans nothing for an acked or silenced incident, escalation included', () => {
    const r = route({ escalate: [{ afterSec: 600, receivers: ['sms'] }] })
    for (const attention of ['acked', 'silenced'] as const) {
      expect(plan({ routes: [r], views: [view({ attention, unattendedSec: 9000 })] }).sends).toEqual([])
    }
  })

  it('plans an unmatched severity as nothing', () => {
    const r = route({ match: { severity: ['page', 'warning'] } })
    expect(plan({ routes: [r], views: [view({ severity: 'info' })] }).sends).toEqual([])
  })

  it('plans each escalation step at its edge, to its own receivers and stage', () => {
    const r = route({
      escalate: [
        { afterSec: 600, receivers: ['sms'] },
        { afterSec: 3600, receivers: ['sms', 'phone'] }
      ]
    })
    const at = (unattendedSec: number) => plan({ routes: [r], views: [view({ unattendedSec })], now: T0 + 30_000 }).sends.map((s) => s.stage)
    expect(at(599)).toEqual(['alert'])
    expect(at(600)).toEqual(['alert', 'esc0'])
    expect(at(3600)).toEqual(['alert', 'esc0', 'esc1'])
    const second = plan({ routes: [r], views: [view({ unattendedSec: 3600 })] }).sends[2]
    expect(second).toMatchObject({ kind: 'escalation', targets: [{ logKey: logKey('edge|EdgeDead', 'r1', 'sms', 'esc1') }, { channelId: 'phone' }] })
  })

  it('plans one flapping notice in place of the alert, gated by the repeat interval only', () => {
    const flapping = view({ flapping: true })
    const first = plan({ views: [flapping] }).sends
    expect(first.map((s) => [s.kind, s.stage])).toEqual([['flapping', 'flap']])
    const flapKey = logKey('edge|EdgeDead', 'r1', 'ntfy', 'flap')
    const sent = [okRow(flapKey, T0 + 30_000, 'flap')]
    const changed = view({ flapping: true, instances: [{ fingerprint: 'zz', name: 'n', startsAt: '' }] })
    expect(plan({ views: [changed], logs: sent, now: T0 + 30_000 + 400_000 }).sends).toEqual([])
    expect(plan({ views: [flapping], logs: sent, now: T0 + 30_000 + 3_600_000 }).sends).toHaveLength(1)
  })

  it('applies a real clock: an unparseable firstSeen does not silence the pager', () => {
    expect(plan({ views: [view({ firstSeen: 'garbage' })], now: T0 }).sends).toHaveLength(1)
  })
})

describe('planSends: quiet hours', () => {
  const muted = route({ muteInQuietHours: true })

  it('holds a warning, remembers it, and never holds a page', () => {
    const warning = view({ key: 'svc|warn', severity: 'warning' })
    const page = view({ key: 'svc|page', severity: 'page' })
    const p = plan({ routes: [muted], views: [warning, page], quiet: true })
    expect(p.sends.map((s) => s.incidentKey)).toEqual(['svc|page'])
    expect(p.held).toEqual([{ routeId: 'r1', keys: ['svc|warn'] }])
  })

  it('does not rewrite a held list that already has the incident', () => {
    const warning = view({ key: 'svc|warn', severity: 'warning' })
    const p = plan({ routes: [muted], views: [warning], quiet: true, held: { r1: ['svc|warn'] } })
    expect(p).toEqual({ sends: [], held: [] })
  })

  it('does not hold what is not yet due', () => {
    const warning = view({ key: 'svc|warn', severity: 'warning' })
    expect(plan({ routes: [muted], views: [warning], quiet: true, now: T0 + 1000 })).toEqual({ sends: [], held: [] })
  })

  it('mutes only routes that ask for it', () => {
    const p = plan({ routes: [route()], views: [view({ severity: 'warning' })], quiet: true })
    expect(p.sends).toHaveLength(1)
  })

  it('plans one digest when quiet ends, listing the incidents still firing and no others', () => {
    const w1 = view({ key: 'svc|a', rule: 'a', severity: 'warning' })
    const w2 = view({ key: 'svc|b', rule: 'b', severity: 'warning', attention: 'acked' })
    const held = { r1: ['svc|a', 'svc|b', 'svc|gone'] }
    const p = plan({ routes: [muted], views: [w1, w2], quiet: false, held })
    expect(p.sends).toHaveLength(1)
    expect(p.sends[0]).toMatchObject({
      kind: 'digest',
      stage: 'digest',
      incidentKey: 'digest:r1',
      clearsHeld: true,
      targets: [{ channelId: 'ntfy', logKey: logKey('digest:r1', 'r1', 'ntfy', 'digest') }],
      covers: [{ incidentKey: 'svc|a', digest: fingerprintDigest(w1) }]
    })
    expect(p.sends[0].subject).toMatchObject({ type: 'digest', views: [{ key: 'svc|a' }] })
    expect(p.held).toEqual([])
  })

  it('keeps the held incidents out of the normal alert sends while the digest owns them', () => {
    const w1 = view({ key: 'svc|a', severity: 'warning' })
    const p = plan({ routes: [muted], views: [w1], quiet: false, held: { r1: ['svc|a'] } })
    expect(p.sends.map((s) => s.kind)).toEqual(['digest'])
  })

  it('clears the held list without a digest when nothing held is still firing', () => {
    const p = plan({ routes: [muted], views: [], quiet: false, held: { r1: ['svc|a'] } })
    expect(p).toEqual({ sends: [], held: [{ routeId: 'r1', keys: [] }] })
  })

  it('keeps holding while quiet continues, and waits out a failed digest backoff', () => {
    const w1 = view({ key: 'svc|a', severity: 'warning' })
    expect(plan({ routes: [muted], views: [w1], quiet: true, held: { r1: ['svc|a'] } }).sends).toEqual([])
    const failed: LogRow = { key: logKey('digest:r1', 'r1', 'ntfy', 'digest'), sentAt: 0, digest: '', ok: false, attempts: 1, nextAttemptAt: T0 + 60_000 }
    const waiting = plan({ routes: [muted], views: [w1], held: { r1: ['svc|a'] }, logs: [failed], now: T0 + 59_999 })
    expect(waiting).toEqual({ sends: [], held: [] })
    expect(plan({ routes: [muted], views: [w1], held: { r1: ['svc|a'] }, logs: [failed], now: T0 + 60_000 }).sends).toHaveLength(1)
  })
})

describe('planSends: resolved notices', () => {
  const wanting = route({ sendResolved: true })
  const key = (r: ResolvedView) => logKey(`${r.key}@${r.resolvedAt}`, 'r1', 'ntfy', 'resolved')

  it('waits until the incident has been stable for 10 minutes', () => {
    expect(plan({ routes: [wanting], views: [], resolved: [resolvedView({ stableForSec: 599 })] }).sends).toEqual([])
    const p = plan({ routes: [wanting], views: [], resolved: [resolvedView({ stableForSec: 600 })] })
    expect(p.sends).toHaveLength(1)
    expect(p.sends[0]).toMatchObject({ kind: 'resolved', stage: 'resolved', incidentKey: 'edge|EdgeDead' })
  })

  it('needs the route to ask for it and a firing notice to have gone out', () => {
    expect(plan({ routes: [route()], views: [], resolved: [resolvedView()] }).sends).toEqual([])
    expect(plan({ routes: [wanting], views: [], resolved: [resolvedView({ wasNotified: false })] }).sends).toEqual([])
  })

  it('sends once per resolution: the key includes resolvedAt', () => {
    const r = resolvedView()
    const logs = [okRow(key(r), T0, '')]
    expect(plan({ routes: [wanting], views: [], resolved: [r], logs, now: T0 + 99_999_999 }).sends).toEqual([])
    const again = resolvedView({ resolvedAt: iso(T0 + 9_000_000) })
    expect(plan({ routes: [wanting], views: [], resolved: [again], logs }).sends).toHaveLength(1)
  })

  it('stays quiet in quiet hours unless it was a page', () => {
    const muted = route({ sendResolved: true, muteInQuietHours: true })
    expect(plan({ routes: [muted], views: [], resolved: [resolvedView({ severity: 'warning' })], quiet: true }).sends).toEqual([])
    expect(plan({ routes: [muted], views: [], resolved: [resolvedView({ severity: 'page' })], quiet: true }).sends).toHaveLength(1)
  })
})

describe('a wall-only route (receivers on purpose empty)', () => {
  const wallOnly = route({ id: 'wall', match: { severity: ['warning'], origin: ['sweep'] }, receivers: [], record: ['chat-alerts'], groupWaitSec: 0 })
  const warn = route({ id: 'warn', match: { severity: ['warning'] }, receivers: ['ntfy'], groupWaitSec: 0 })
  const sweepWarning = view({ severity: 'warning', origin: 'sweep', severityLabel: 'warning' })

  it('matches, notifies nobody, and shields its alerts from the route after it', () => {
    expect(plan({ routes: [wallOnly, warn], views: [sweepWarning], now: T0 + 60_000 }).sends).toEqual([])
    expect(matchedRoutes([wallOnly, warn], sweepWarning).map((r) => r.id)).toEqual(['wall'])
  })

  it('sends no resolved notice either, and other origins still reach the next route', () => {
    expect(plan({ routes: [{ ...wallOnly, sendResolved: true }, warn], views: [], resolved: [resolvedView({ severity: 'warning', origin: 'sweep' })] }).sends).toEqual([])
    const other = view({ severity: 'warning', origin: 'grafana', severityLabel: 'warning' })
    expect(plan({ routes: [wallOnly, warn], views: [other], now: T0 + 60_000 }).sends.map((s) => s.routeId)).toEqual(['warn'])
  })

  it('a page from the same origin is not shielded: it goes through the page route', () => {
    const page = route({ id: 'page', match: { severity: ['page'] }, receivers: ['ntfy'], groupWaitSec: 0 })
    const red = view({ severity: 'page', origin: 'sweep' })
    expect(plan({ routes: [page, wallOnly, warn], views: [red], now: T0 + 60_000 }).sends.map((s) => s.routeId)).toEqual(['page'])
  })
})

describe('usableRoutes', () => {
  const has = (id: string) => id === 'ntfy'
  it('drops a channel that has no credential, and a route that loses all its receivers that way', () => {
    const routes = [route({ id: 'a', receivers: ['sms', 'ntfy'], escalate: [{ afterSec: 60, receivers: ['sms'] }] }), route({ id: 'b', receivers: ['sms'] })]
    const out = usableRoutes(routes, has)
    expect(out.map((r) => r.id)).toEqual(['a'])
    expect(out[0].receivers).toEqual(['ntfy'])
    expect(out[0].escalate).toEqual([])
  })

  it('keeps a route that was configured with no receivers', () => {
    expect(usableRoutes([route({ id: 'wall', receivers: [] }), route({ id: 'b', receivers: ['sms'] })], has).map((r) => r.id)).toEqual(['wall'])
  })
})
