// The heartbeat source: one scheduled job pings GET|POST /ingest/heartbeat/<id>, Watch computes from the config's own schedule
// whether a run was missed (next due + grace), and a later ok ping resolves the incident. These tests cover the schedule parsing
// (crontabs in a zone, DST included), the deadline arithmetic, the alert/cell contract, the ping paths and tokens, the engine
// round trip a missed run makes, and the config and route wiring.
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.ts'
import type { AppDeps } from '../../src/server/app.ts'
import { configServiceNames, validateConfig } from '../../src/server/config.ts'
import type { SourceConfig, WatchConfig } from '../../src/server/config.ts'
import { openDb } from '../../src/server/db.ts'
import { makeAlert } from '../../src/server/derive.ts'
import { Engine } from '../../src/server/engine.ts'
import { POLLED } from '../../src/server/source-registry.ts'
import {
  HEARTBEAT_ASSERT,
  HEARTBEAT_POLL_SEC,
  HEARTBEAT_RULE,
  HeartbeatSource,
  evaluateHeartbeat,
  heartbeatProblems,
  heartbeatSource,
  heartbeatSourceOf,
  isTimeZone,
  nextCronTick,
  parseCron,
  parseDurationSec,
  parseHeartbeatAction,
  proveHeartbeat,
  resetHeartbeatSources
} from '../../src/server/sources/heartbeat.ts'
import type { HeartbeatSourceConfig, HeartbeatState } from '../../src/server/sources/heartbeat.ts'
import type { SourceDeps } from '../../src/server/sources/types.ts'
import { SqlitePushStore } from '../../src/server/stores.ts'
import { kindLabel, quietText } from '../../src/web/lib/sources.ts'
import type { Alert, Observation, WallState } from '../../src/shared/types.ts'

const TOKEN = 'job-ping-token'
const T0 = Date.parse('2026-11-04T00:00:00Z')
const S = 1000
const M = 60_000
let clock = T0
const iso = (ms = clock): string => new Date(ms).toISOString()

const noFetch = ((): never => {
  throw new Error('a heartbeat never fetches')
}) as unknown as typeof fetch

function deps(env: Record<string, string> = { JOB_TOKEN: TOKEN }): SourceDeps {
  return { fetch: noFetch, env, nowIso: () => iso(), serviceMap: [] }
}

function job(over: Record<string, unknown> = {}): HeartbeatSourceConfig {
  return { id: 'nightly', type: 'heartbeat', name: 'Nightly backup', every: '5m', grace: '2m', tokenEnv: 'JOB_TOKEN', ...over } as unknown as HeartbeatSourceConfig
}

const state = (over: Partial<HeartbeatState> = {}): HeartbeatState => ({ startedMs: T0, lastPingMs: T0, lastKind: 'ok', failedSinceMs: null, ...over })

// ---- durations and crontabs -----------------------------------------------------------------------------

describe('durations', () => {
  it('reads s, m, h and d as seconds', () => {
    expect(parseDurationSec('30s')).toBe(30)
    expect(parseDurationSec('5m')).toBe(300)
    expect(parseDurationSec('2h')).toBe(7200)
    expect(parseDurationSec('1d')).toBe(86_400)
  })

  it('refuses a bare number, an unknown unit and zero, naming the shape and never the value', () => {
    for (const bad of ['', '5', '5x', '0s', 'm', '-1m', '1.5m']) {
      expect(() => parseDurationSec(bad), bad).toThrow(/duration|above zero/)
    }
  })
})

describe('crontabs', () => {
  it('parses steps, ranges and lists', () => {
    const every5 = parseCron('*/5 * * * *')
    expect(every5.minutes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
    expect(every5.hours.length).toBe(24)
    const workday = parseCron('0 9-17 * * 1-5')
    expect(workday.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(workday.daysOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(parseCron('1,3,5 * * * *').minutes).toEqual([1, 3, 5])
  })

  it('reads day-of-week 7 as Sunday, and remembers which day field was a star', () => {
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0])
    const both = parseCron('0 0 13 * 5')
    expect([both.domStar, both.dowStar]).toEqual([false, false])
    const either = parseCron('0 0 * * 5')
    expect([either.domStar, either.dowStar]).toEqual([true, false])
  })

  it('refuses a field it cannot read, out of range or empty', () => {
    for (const bad of ['* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 32 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', 'a * * * *']) {
      expect(() => parseCron(bad), bad).toThrow()
    }
  })

  it('finds the next run strictly after an instant, in UTC', () => {
    const every5 = parseCron('*/5 * * * *')
    expect(new Date(nextCronTick(every5, Date.parse('2026-11-04T12:02:00Z'), 'UTC') as number).toISOString()).toBe('2026-11-04T12:05:00.000Z')
    const daily = parseCron('0 4 * * *')
    // Exactly on the tick is not the next one: the run at 04:00 has happened, the next is tomorrow's.
    expect(new Date(nextCronTick(daily, Date.parse('2026-11-04T04:00:00Z'), 'UTC') as number).toISOString()).toBe('2026-11-05T04:00:00.000Z')
  })

  it('reads a crontab in its own zone', () => {
    const daily = parseCron('0 4 * * *')
    // 2026-11-04T00:00Z is 18:00 CST on the 3rd, so 04:00 on the 4th is 10:00Z (CST, UTC-6).
    expect(new Date(nextCronTick(daily, Date.parse('2026-11-04T00:00:00Z'), 'America/Chicago') as number).toISOString()).toBe('2026-11-04T10:00:00.000Z')
  })

  it('keeps a daily local time across a spring DST change and skips a time the change removes', () => {
    // DST starts 2026-03-08: 02:00 CST becomes 03:00 CDT.
    const daily = parseCron('0 4 * * *')
    expect(new Date(nextCronTick(daily, Date.parse('2026-03-07T12:00:00Z'), 'America/Chicago') as number).toISOString()).toBe('2026-03-08T09:00:00.000Z')
    const at230 = parseCron('30 2 * * *')
    // 02:30 does not exist on the 8th, so the next run is the 9th's, at 02:30 CDT (UTC-5).
    expect(new Date(nextCronTick(at230, Date.parse('2026-03-08T00:00:00Z'), 'America/Chicago') as number).toISOString()).toBe('2026-03-09T07:30:00.000Z')
  })

  it('keeps a daily local time across a fall DST change', () => {
    // DST ends 2026-11-01: 02:00 CDT becomes 01:00 CST. 04:00 on the 1st is CST (UTC-6).
    const daily = parseCron('0 4 * * *')
    expect(new Date(nextCronTick(daily, Date.parse('2026-10-31T12:00:00Z'), 'America/Chicago') as number).toISOString()).toBe('2026-11-01T10:00:00.000Z')
  })

  it('ORs a restricted day-of-month with a restricted day-of-week, as Vixie cron does', () => {
    const thirtiethOrFriday = parseCron('0 0 13 * 5')
    // 2026-11-04 is a Wednesday: the next match is Friday the 6th, before the 13th.
    expect(new Date(nextCronTick(thirtiethOrFriday, Date.parse('2026-11-04T00:00:00Z'), 'UTC') as number).toISOString()).toBe('2026-11-06T00:00:00.000Z')
  })

  it('answers null for a crontab that can never match', () => {
    expect(nextCronTick(parseCron('0 0 30 2 *'), T0, 'UTC')).toBeNull()
  })

  it('knows a real IANA zone from a typo', () => {
    expect(isTimeZone('America/Chicago')).toBe(true)
    expect(isTimeZone('America/Chicagoo')).toBe(false)
  })
})

// ---- the deadline arithmetic ---------------------------------------------------------------------------

describe('evaluateHeartbeat', () => {
  it('is healthy until the next run plus its grace, then missed', () => {
    const cfg = job()
    const before = evaluateHeartbeat(cfg, state(), T0 + 7 * M)
    expect([before.health, before.badSinceMs]).toEqual(['ok', null])
    const after = evaluateHeartbeat(cfg, state(), T0 + 7 * M + 1)
    expect(after.health).toBe('missed')
    // The trouble began when the run was due, not when Watch noticed.
    expect(after.badSinceMs).toBe(T0 + 5 * M)
    expect(after.detail).toContain('overdue')
  })

  it('counts from the source start for a job that never pinged, so a fresh Watch pages nobody at boot', () => {
    const cfg = job()
    expect(evaluateHeartbeat(cfg, state({ lastPingMs: null, lastKind: null }), T0 + 7 * M).health).toBe('ok')
    expect(evaluateHeartbeat(cfg, state({ lastPingMs: null, lastKind: null }), T0 + 7 * M + 1).health).toBe('missed')
  })

  it('judges a crontab by its next tick plus the grace', () => {
    const cfg = job({ every: undefined, schedule: '0 4 * * *' })
    const lastOk = Date.parse('2026-11-04T03:50:00Z')
    const st = state({ lastPingMs: lastOk })
    expect(evaluateHeartbeat(cfg, st, Date.parse('2026-11-04T04:02:00Z')).health).toBe('ok')
    expect(evaluateHeartbeat(cfg, st, Date.parse('2026-11-04T04:02:01Z')).health).toBe('missed')
  })

  it('keeps a declared failure until an ok ping, and a run that reported failure is failing at once', () => {
    const cfg = job()
    const failed = state({ lastKind: 'fail', failedSinceMs: T0 + M })
    const r = evaluateHeartbeat(cfg, failed, T0 + 2 * M)
    expect([r.health, r.badSinceMs]).toEqual(['failed', T0 + M])
    expect(r.detail).toContain('reported failure')
    const exited = evaluateHeartbeat(cfg, state({ lastKind: 'exit', failedSinceMs: T0 + M, exitCode: 3 }), T0 + 2 * M)
    expect(exited.health).toBe('failed')
    expect(exited.detail).toContain('(exit 3)')
  })

  it('reads a start as liveness: it moves the deadline but never clears a failure', () => {
    const cfg = job()
    const started = state({ lastKind: 'start', lastPingMs: T0 + 4 * M })
    expect(evaluateHeartbeat(cfg, started, T0 + 4 * M + 7 * M - 1).health).toBe('ok')
    const startedAfterFailure = state({ lastKind: 'start', lastPingMs: T0 + 4 * M, failedSinceMs: T0 })
    expect(evaluateHeartbeat(cfg, startedAfterFailure, T0 + 5 * M).health).toBe('failed')
  })
})

// ---- the alert and the cell ----------------------------------------------------------------------------

describe('the Observation', () => {
  it('is complete, so an ok ping resolves the incident by omitting the alert', async () => {
    resetHeartbeatSources()
    const source = new HeartbeatSource(job({ service: 'backups' }), deps())
    const ok = source.ping('', iso(T0))
    expect(ok.status).toBe(200)
    expect(ok.observation?.complete).toBe(true)
    expect(ok.observation?.firing).toEqual([])
    expect(ok.observation?.kind).toBe('heartbeat')
  })

  it('raises one page named for the job, with the same key every time, and a cell that asserts on-time', async () => {
    resetHeartbeatSources()
    const source = new HeartbeatSource(job({ service: 'backups' }), deps())
    source.ping('', iso(T0))
    clock = T0 + 8 * M
    const missed = await source.poll()
    expect(missed.firing).toHaveLength(1)
    const alert: Alert = missed.firing[0]
    expect(alert.rule).toBe(HEARTBEAT_RULE)
    expect(alert.severity).toBe('page')
    expect(alert.origin).toBe('nightly')
    expect(alert.labels.job).toBe('nightly')
    expect(alert.service).toBe('Backups')
    expect(alert.startsAt).toBe(new Date(T0 + 5 * M).toISOString())
    expect(alert.annotations.summary).toContain('Nightly backup missed a scheduled run')
    const again = await source.poll()
    expect(again.firing[0].key).toBe(alert.key)
    const cell = missed.rules?.[0]
    expect(cell?.id).toBe('heartbeat:nightly')
    expect(cell?.state).toBe('firing')
    expect(cell?.checkId).toBe(HEARTBEAT_RULE)
    expect(cell?.asserts).toEqual([HEARTBEAT_ASSERT])
    expect(cell?.staleAfterSec).toBe(5 * 60 + 2 * 60)
    expect(cell?.detail).toContain('overdue')
  })

  it('marks a healthy job green and leaves the next run in the detail', async () => {
    resetHeartbeatSources()
    clock = T0
    const source = new HeartbeatSource(job(), deps())
    source.ping('', iso(T0))
    const obs = await source.poll()
    expect(obs.rules?.[0].state).toBe('ok')
    expect(obs.rules?.[0].detail).toContain('next run is due at')
    expect(obs.firing).toEqual([])
  })
})

// ---- pings and tokens ----------------------------------------------------------------------------------

describe('the ping paths and the token', () => {
  beforeEach(() => {
    resetHeartbeatSources()
    clock = T0
  })

  it('reads the healthchecks.io suffixes: 0 is a success, another exit status a failure, /start liveness only', () => {
    expect(parseHeartbeatAction(undefined)).toEqual({ kind: 'ok' })
    expect(parseHeartbeatAction('')).toEqual({ kind: 'ok' })
    expect(parseHeartbeatAction('0')).toEqual({ kind: 'ok' })
    expect(parseHeartbeatAction('start')).toEqual({ kind: 'start' })
    expect(parseHeartbeatAction('fail')).toEqual({ kind: 'fail' })
    expect(parseHeartbeatAction('2')).toEqual({ kind: 'exit', exitCode: 2 })
    expect(parseHeartbeatAction('nope')).toBeNull()
    expect(parseHeartbeatAction('1000')).toBeNull()
  })

  it('takes the token as a Bearer or ?token=, and refuses a wrong or missing one', () => {
    const source = new HeartbeatSource(job(), deps())
    expect(source.handle(undefined, undefined, undefined).status).toBe(401)
    expect(source.handle(undefined, 'wrong', undefined).status).toBe(401)
    expect(source.handle(undefined, TOKEN, undefined).status).toBe(200)
    expect(source.handle(undefined, undefined, `Bearer ${TOKEN}`).status).toBe(200)
    expect(source.handle(undefined, ' ', `Bearer ${TOKEN}`).status).toBe(200)
    expect(new HeartbeatSource(job({ id: 'other' }), deps({})).handle(undefined, TOKEN, `Bearer ${TOKEN}`).status).toBe(401)
  })

  it('answers an unknown suffix with 404 and records nothing', () => {
    const source = new HeartbeatSource(job(), deps())
    const answer = source.handle('nope', TOKEN, undefined)
    expect(answer.status).toBe(404)
    expect(answer.observation).toBeUndefined()
  })

  it('keeps the incident open across a start and closes it on an ok ping', () => {
    const source = new HeartbeatSource(job(), deps())
    expect(source.handle('fail', TOKEN, undefined).body.health).toBe('failed')
    clock += M
    const started = source.handle('start', TOKEN, undefined)
    expect(started.body.health).toBe('failed')
    expect(started.observation?.firing).toHaveLength(1)
    clock += M
    const ok = source.handle('0', TOKEN, undefined)
    expect(ok.body.health).toBe('ok')
    expect(ok.observation?.firing).toEqual([])
  })

  it('turns silence into a missed run on the source\'s own poll, with no ping at all', async () => {
    const source = new HeartbeatSource(job(), deps())
    expect((await source.poll()).firing).toEqual([])
    clock = T0 + 8 * M
    const missed = await source.poll()
    expect(missed.firing[0].rule).toBe(HEARTBEAT_RULE)
    expect(missed.firing[0].annotations.summary).toContain('missed a scheduled run')
  })
})

// ---- the engine round trip -----------------------------------------------------------------------------

function engineFor(sources: SourceConfig[]): { engine: Engine; cfg: WatchConfig } {
  const cfg: WatchConfig = {
    baseUrl: 'https://watch.example.com',
    dataDir: ':memory:',
    historyHours: 24,
    staleAfterMisses: 3,
    sources,
    serviceMap: [],
    channels: [],
    routes: [],
    quietHours: null
  }
  return { engine: new Engine(openDb(':memory:'), cfg, () => clock), cfg }
}

describe('a heartbeat through the engine', () => {
  beforeEach(() => {
    resetHeartbeatSources()
    clock = T0
  })

  it('shows its cell with the assertion, raises the page after the grace, and resolves it on an ok ping', async () => {
    const cfg = job({ service: 'backups' })
    const { engine } = engineFor([cfg])
    const source = heartbeatSource(cfg, deps())
    engine.ingest(source.ping('', iso(T0)).observation as Observation)
    let wall: WallState = engine.wall()
    expect(wall.sources.find((s) => s.id === 'nightly')?.kind).toBe('heartbeat')
    const cell = wall.health.find((h) => h.service === 'Backups')?.cells.find((c) => c.id === 'heartbeat:nightly')
    expect([cell?.state, cell?.asserts]).toEqual(['ok', [HEARTBEAT_ASSERT]])
    expect(wall.incidents).toEqual([])

    clock = T0 + 8 * M
    engine.ingest(await source.poll())
    wall = engine.wall()
    const incident = wall.incidents.find((i) => i.rule === HEARTBEAT_RULE)
    expect(incident?.severity).toBe('page')
    expect(incident?.alerts[0].labels.job).toBe('nightly')
    expect(wall.health.find((h) => h.service === 'Backups')?.cells[0].state).toBe('firing')

    clock += M
    engine.ingest(source.ping('', iso()).observation as Observation)
    wall = engine.wall()
    expect(wall.incidents).toEqual([])
    expect(engine.history(24).some((r) => r.rule === HEARTBEAT_RULE)).toBe(true)
  })

  it('pages at once for a /fail, and a non-zero exit names its status', async () => {
    const cfg = job()
    const { engine } = engineFor([cfg])
    const source = heartbeatSource(cfg, deps())
    engine.ingest(source.ping('2', iso(T0)).observation as Observation)
    const incident = engine.wall().incidents.find((i) => i.rule === HEARTBEAT_RULE)
    expect(incident?.alerts[0].annotations.summary).toContain('reported a failed run (exit 2)')
  })
})

// ---- the config ----------------------------------------------------------------------------------------

function fullConfig(sources: unknown[]): Record<string, unknown> {
  return { baseUrl: 'https://watch.example.com', dataDir: ':memory:', sources, serviceMap: [], channels: [], routes: [], historyHours: 24, staleAfterMisses: 3 }
}

describe('the config entry', () => {
  it('accepts a heartbeat source and puts its tile among the config\'s service names', () => {
    const checked = validateConfig(fullConfig([job({ service: 'backups' })]))
    expect(checked.ok).toBe(true)
    const names = configServiceNames({ serviceMap: [], sources: [job({ service: 'backups' })] })
    expect(names.has('backups')).toBe(true)
  })

  it('refuses both schedules or neither, a bad schedule, a bad grace and a bad zone', () => {
    const cases: Array<[HeartbeatSourceConfig, RegExp]> = [
      [job({ every: '5m', schedule: '0 4 * * *' }), /exactly one of every and schedule/],
      [job({ every: undefined }), /exactly one of every and schedule/],
      [job({ schedule: '0 4 * *', every: undefined }), /five fields/],
      [job({ schedule: '0 0 30 2 *', every: undefined }), /matches no run/],
      [job({ grace: 'soon' }), /grace/],
      [job({ timezone: 'Mars/Olympus' }), /IANA zone/],
      [job({ tokenEnv: '' }), /tokenEnv/],
      [job({ every: '5' }), /every/]
    ]
    for (const [s, re] of cases) {
      const checked = validateConfig(fullConfig([s]))
      expect(checked.ok, JSON.stringify(s)).toBe(false)
      if (!checked.ok) expect(checked.errors[0]).toMatch(re)
    }
  })

  it('names every problem in one call, so a caller sees the whole list', () => {
    const problems = heartbeatProblems(job({ every: undefined, tokenEnv: '', grace: '0s' }))
    expect(problems.length).toBeGreaterThanOrEqual(3)
  })
})

describe('a webhook source that promised a schedule', () => {
  beforeEach(() => {
    clock = T0
  })

  it('pages when it goes silent, at its staleSeverity, default page', () => {
    const { engine } = engineFor([{ id: 'pusher', type: 'webhook', tokenEnv: 'T', staleAfterSec: 600 }])
    engine.recordSource('pusher', true, null)
    clock = T0 + 601 * S
    const alerts = engine.staleAlerts(staleAlert)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('page')
    expect(alerts[0].labels.severity).toBe('page')
    expect(alerts[0].annotations.summary).toContain('has pushed nothing for')
    expect(alerts[0].annotations.summary).toContain('promised a push at least every')
  })

  it('keeps the severity the config names', () => {
    const { engine } = engineFor([{ id: 'pusher', type: 'webhook', tokenEnv: 'T', staleAfterSec: 600, staleSeverity: 'warning' }])
    engine.recordSource('pusher', true, null)
    clock = T0 + 601 * S
    expect(engine.staleAlerts(staleAlert)[0].severity).toBe('warning')
  })

  it('stays quiet for a webhook that never promised a schedule, and a polled source keeps its warning', () => {
    const { engine } = engineFor([
      { id: 'chatter', type: 'webhook', tokenEnv: 'T' },
      { id: 'grafana', type: 'grafana', url: 'https://grafana.example.com', tokenEnv: 'G', pollSec: 60 }
    ])
    engine.recordSource('chatter', true, null)
    for (let i = 0; i < 3; i++) engine.recordSource('grafana', false, 'HTTP 500')
    clock = T0 + 601 * S
    const alerts = engine.staleAlerts(staleAlert)
    expect(alerts.map((a) => [a.labels.source, a.severity])).toEqual([['grafana', 'warning']])
  })

  it('refuses a staleSeverity with no staleAfterSec to be judged against', () => {
    const checked = validateConfig(fullConfig([{ id: 'pusher', type: 'webhook', tokenEnv: 'T', staleSeverity: 'page' }]))
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.errors[0]).toMatch(/needs staleAfterSec/)
  })

  it('refuses a staleAfterSec that is not a positive number of seconds', () => {
    for (const bad of [0, -5, '600']) {
      const checked = validateConfig(fullConfig([{ id: 'pusher', type: 'webhook', tokenEnv: 'T', staleAfterSec: bad }]))
      expect(checked.ok, String(bad)).toBe(false)
      if (!checked.ok) expect(checked.errors[0]).toMatch(/staleAfterSec/)
    }
  })
})

/** The makeAlert main.ts's tick hands the engine: the source-stale alert as it was built before the push source's severity was read from the config. */
function staleAlert(id: string, name: string): Alert {
  return makeAlert(
    {
      origin: 'self',
      fingerprint: `source-stale:${id}`,
      rule: `${id} is not answering`,
      labels: { alertname: 'source-stale', severity: 'warning', source: id, service: 'Watcher sources' },
      annotations: { summary: `${name} has not been heard from` },
      startsAt: iso(),
      via: { source: 'self', kind: 'self', lastSeen: iso() },
      raw: { source: id }
    },
    [],
    iso()
  )
}

describe('the Sources page words', () => {
  it('names a heartbeat by what it does, and its own schedule as what decides a page', () => {
    expect(kindLabel('heartbeat')).toMatch(/Heartbeat/)
    expect(quietText({ kind: 'heartbeat' })).toContain('HeartbeatDown')
  })

  it('says a webhook that promised a schedule raises a source-stale alert, and one that did not raises nothing', () => {
    expect(quietText({ kind: 'webhook', staleAfterSec: 600 })).toContain('raises a source-stale alert')
    expect(quietText({ kind: 'webhook' })).toContain('nothing flags it')
  })
})

// ---- the registry and the route ------------------------------------------------------------------------

describe('the source registry', () => {
  beforeEach(() => {
    resetHeartbeatSources()
    clock = T0
  })

  it('starts a heartbeat poller from POLLED and hands the route the same instance', () => {
    const cfg = job()
    const built = POLLED.heartbeat?.(cfg, deps(), { loadNodes: [] })
    expect(built?.source.id).toBe('nightly')
    expect(built?.source.kind).toBe('heartbeat')
    expect(built?.source.pollSec).toBe(HEARTBEAT_POLL_SEC)
    expect(heartbeatSourceOf('nightly')).toBe(built?.source)
    expect(heartbeatSource(cfg, deps())).toBe(built?.source)
  })

  it('evaluates a fast job faster than the default tick, so its cell never dashes between two checks of a healthy run', () => {
    expect(new HeartbeatSource(job({ every: '4s' }), deps()).pollSec).toBe(2)
    expect(new HeartbeatSource(job({ every: '5m' }), deps()).pollSec).toBe(HEARTBEAT_POLL_SEC)
    expect(new HeartbeatSource(job({ every: undefined, schedule: '0 4 * * *' }), deps()).pollSec).toBe(HEARTBEAT_POLL_SEC)
  })
})

describe('GET|POST /ingest/heartbeat/<id>', () => {
  const appCfg: WatchConfig = {
    baseUrl: 'https://watch.example.com',
    dataDir: ':memory:',
    historyHours: 24,
    staleAfterMisses: 3,
    sources: [job({ service: 'backups' })],
    serviceMap: [],
    channels: [],
    routes: [],
    quietHours: null
  }
  let app: ReturnType<typeof createApp>
  let eng: Engine

  beforeEach(() => {
    resetHeartbeatSources()
    clock = T0
    const db = openDb(':memory:')
    eng = new Engine(db, appCfg, () => clock)
    const appDeps: AppDeps = {
      engine: eng,
      cfg: appCfg,
      env: { JOB_TOKEN: TOKEN },
      db,
      push: new SqlitePushStore(db),
      ackSecret: 'ack',
      webDir: '/nonexistent',
      normalizeWebhook: () => {
        throw new Error('not used in this test')
      },
      testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
      nudge: () => undefined,
      vapidPublicKey: null,
      now: () => clock
    }
    app = createApp(appDeps)
  })

  const ping = (path: string, token = TOKEN): Promise<Response> =>
    Promise.resolve(app.request(path, { method: 'POST', headers: token === '' ? {} : { authorization: `Bearer ${token}` } }))

  it('takes a ping, shows the cell and records the source as heard', async () => {
    const r = await ping('/ingest/heartbeat/nightly')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, at: iso(T0), health: 'ok' })
    const wall = (await (await app.request('/api/state')).json()) as WallState
    expect(wall.sources.find((s) => s.id === 'nightly')?.state).toBe('ok')
    expect(wall.health.find((h) => h.service === 'Backups')?.cells[0].state).toBe('ok')
  })

  it('takes the suffix paths: /fail raises at once, /0 resolves, a non-zero exit is a page', async () => {
    expect((await ((await ping('/ingest/heartbeat/nightly/fail')).json()) as { health: string }).health).toBe('failed')
    let wall = (await (await app.request('/api/state')).json()) as WallState
    expect(wall.incidents.find((i) => i.rule === HEARTBEAT_RULE)?.alerts[0].annotations.summary).toContain('reported a failed run')

    expect((await ((await ping('/ingest/heartbeat/nightly/0')).json()) as { health: string }).health).toBe('ok')
    wall = (await (await app.request('/api/state')).json()) as WallState
    expect(wall.incidents).toEqual([])

    expect((await ((await ping('/ingest/heartbeat/nightly/3')).json()) as { health: string }).health).toBe('failed')
    wall = (await (await app.request('/api/state')).json()) as WallState
    expect(wall.incidents.find((i) => i.rule === HEARTBEAT_RULE)?.alerts[0].annotations.summary).toContain('(exit 3)')
  })

  it('takes GET and ?token=, as healthchecks.io callers send it', async () => {
    const r = await app.request(`/ingest/heartbeat/nightly/start?token=${TOKEN}`)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { health: string }).health).toBe('ok')
  })

  it('refuses a wrong token, an unknown id and an unknown suffix', async () => {
    expect((await ping('/ingest/heartbeat/nightly', 'wrong')).status).toBe(401)
    expect((await ping('/ingest/heartbeat/nightly', '')).status).toBe(401)
    expect((await ping('/ingest/heartbeat/other')).status).toBe(404)
    expect((await ping('/ingest/heartbeat/nightly/nope')).status).toBe(404)
    expect(eng.wall().health).toEqual([])
  })
})

describe('proveHeartbeat: a healthy job that goes silent fires HeartbeatDown', () => {
  it('turns a run that is past every plus grace red, with no ping and no server', () => {
    const cfg: HeartbeatSourceConfig = { id: 'proof', type: 'heartbeat', every: '5m', grace: '2m', tokenEnv: 'PROOF_TOKEN' }
    const out = proveHeartbeat(cfg, T0)
    expect(out.red).toBe(true)
    expect(out.runs).toHaveLength(1)
    expect(out.runs[0].ok).toBe(false)
    expect(out.runs[0].mutation).toContain('no ping after the run due at')
  })

  it('does the same for a crontab read in a zone', () => {
    const cfg: HeartbeatSourceConfig = { id: 'cron-proof', type: 'heartbeat', schedule: '0 4 * * *', timezone: 'America/Chicago', grace: '10m', tokenEnv: 'PROOF_TOKEN' }
    expect(proveHeartbeat(cfg, T0).red).toBe(true)
  })
})
