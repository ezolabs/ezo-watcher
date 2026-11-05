// Check lists: a sender says which checks it runs and when each last ran, and the wall draws one real cell per check
// (solid when it last passed, half when pending, dashed when it could not run or went stale), never a dotted history guess.
import { beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import { loadConfig } from '../src/server/config.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { makeAlert } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { MAX_CHECKS, checkCellId, parseChecks } from '../src/server/sources/checks.ts'
import { BadPayload, normalizeWebhook } from '../src/server/sources/webhook.ts'
import type { SourceDeps } from '../src/server/sources/types.ts'
import { SqlitePushStore } from '../src/server/stores.ts'
import type { Alert, Observation, RuleCell, WallState } from '../src/shared/types.ts'

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const T0 = Date.parse('2026-10-15T12:00:00Z')
const H = 3600_000
let clock = T0
const iso = (ms = clock): string => new Date(ms).toISOString()
const NOW = iso(T0)

const deps: SourceDeps = {
  fetch: (() => {
    throw new Error('a webhook never fetches')
  }) as unknown as typeof fetch,
  env: {},
  nowIso: () => iso(),
  serviceMap: []
}
const ctx = (origin = 'api-uptime') => ({ origin, source: 'webhook', now: iso() })

const check = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'ProbeDown', instance: 'api-rooms', service: 'Uptime', state: 'ok', lastRunAt: iso(T0 - 30_000), ...over })
const list = (checks: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> => ({ list: checks, ...over })

describe('parseChecks: the contract', () => {
  it('turns each check into a cell: ok solid, failing filled, pending half, skipped dashed no-data', () => {
    const push = parseChecks(
      list([check({ instance: 'a', state: 'ok' }), check({ instance: 'b', state: 'failing' }), check({ instance: 'c', state: 'pending' }), check({ instance: 'd', state: 'skipped', detail: 'ntfy.sh unreachable' })]),
      ctx()
    )
    expect(push.origin).toBe('api-uptime')
    expect(push.complete).toBe(true)
    expect(push.cells.map((c) => [c.name, c.state])).toEqual([
      ['a', 'ok'],
      ['b', 'firing'],
      ['c', 'pending'],
      ['d', 'nodata']
    ])
    expect(push.cells[3].detail).toBe('ntfy.sh unreachable')
  })

  it('names a cell by its instance, else by its id, and keeps the class as checkId and the run as evaluatedAt', () => {
    const [a, b] = parseChecks(list([check({ id: 'ProbeDown', instance: 'zulip' }), check({ id: 'FleetDisk', instance: undefined, service: 'Regression sweep' })]), ctx('sweep')).cells
    expect([a.name, a.checkId, a.service, a.source, a.evaluatedAt]).toEqual(['zulip', 'ProbeDown', 'Uptime', 'sweep', iso(T0 - 30_000)])
    expect([b.name, b.checkId, b.service]).toEqual(['FleetDisk', 'FleetDisk', 'Regression sweep'])
    expect(a.id).toBe(checkCellId('sweep', 'Uptime', 'ProbeDown', 'zulip'))
    expect(b.id).toBe('check:sweep:Regression sweep/FleetDisk')
  })

  it('lists one class on two services as two cells, and the same check twice as one', () => {
    const cells = parseChecks(
      list([check({ id: 'ZombieProcesses', instance: undefined, service: 'prod/scraper' }), check({ id: 'ZombieProcesses', instance: undefined, service: 'prod/docs' }), check({ id: 'ZombieProcesses', instance: undefined, service: 'prod/docs', state: 'failing' })]),
      ctx('sweep')
    ).cells
    expect(cells.map((c) => [c.service, c.state])).toEqual([
      ['prod/scraper', 'ok'],
      ['prod/docs', 'firing']
    ])
  })

  it('reads a check with no time as run now, a skipped one as never run, and a time ahead of this clock as now', () => {
    const cells = parseChecks(list([check({ instance: 'a', lastRunAt: undefined }), check({ instance: 'b', state: 'skipped', lastRunAt: undefined }), check({ instance: 'c', lastRunAt: iso(T0 + 6 * H) })]), ctx()).cells
    expect(cells[0].evaluatedAt).toBe(iso())
    expect(cells[1].evaluatedAt).toBeUndefined()
    expect(cells[2].evaluatedAt).toBe(iso())
  })

  it('holds staleAfterSec between a minute and a week, 6 h when the sender names none', () => {
    const at = (staleAfterSec?: number) => parseChecks(list([check()], staleAfterSec === undefined ? {} : { staleAfterSec }), ctx()).cells[0].staleAfterSec
    expect(at()).toBe(6 * H / 1000)
    expect(at(300)).toBe(300)
    expect(at(1)).toBe(60)
    expect(at(10 * 24 * 3600)).toBe(7 * 24 * 3600)
  })

  it('is complete by default and says so when it is not', () => {
    expect(parseChecks(list([check()]), ctx()).complete).toBe(true)
    expect(parseChecks(list([check()], { complete: false }), ctx()).complete).toBe(false)
  })

  it('keeps only an http(s) link and one line of text', () => {
    const [c] = parseChecks(list([check({ url: 'javascript:alert(1)', detail: 'line one\nline two\u0000' })]), ctx()).cells
    expect(c.url).toBeUndefined()
    expect(c.detail).toBe('line one line two')
    expect(parseChecks(list([check({ url: 'https://watch.example.com/x' })]), ctx()).cells[0].url).toBe('https://watch.example.com/x')
  })

  it.each([
    ['a non-object', 'nope', /checks must be an object/],
    ['no list', {}, /checks.list must be an array/],
    ['an empty list', list([]), /empty/],
    ['too many', list(Array.from({ length: MAX_CHECKS + 1 }, (_, i) => check({ instance: `t${i}` }))), /more than/],
    ['a non-object check', list(['x']), /list\[0\] must be an object/],
    ['no id', list([check({ id: undefined })]), /list\[0\].id is required/],
    ['no service', list([check({ service: '' })]), /list\[0\].service is required/],
    ['an unknown state', list([check({ state: 'green' })]), /state must be ok, failing, pending or skipped/],
    ['a blank instance', list([check({ instance: ' ' })]), /instance must be a non-empty string/],
    ['a bad time', list([check({ lastRunAt: 'yesterday' })]), /lastRunAt must be an ISO time/],
    ['a bad complete', list([check()], { complete: 'yes' }), /complete must be true or false/],
    ['a bad staleAfterSec', list([check()], { staleAfterSec: '300' }), /staleAfterSec must be a number/]
  ])('refuses %s with a message that names a field, never a value', (_n, body, message) => {
    const run = () => parseChecks(body, ctx())
    expect(run).toThrow(BadPayload)
    expect(run).toThrow(message)
  })
})

describe('normalizeWebhook: a body may carry a check list, alone or beside its alerts', () => {
  const am = (alerts: unknown[], extra: Record<string, unknown> = {}) => ({ version: '4', groupKey: 'g', status: 'firing', receiver: 'x', alerts, ...extra })
  const firing = { status: 'firing', labels: { alertname: 'ProbeDown', instance: 'api-rooms', severity: 'page', component: 'uptime' }, annotations: {}, startsAt: iso(T0 - 60_000), fingerprint: 'aabbccdd11223344' }

  it('reads a body with only checks: no alerts, the sender from X-Alert-Source', () => {
    const obs = normalizeWebhook({ checks: list([check()]) }, { source: 'webhook', headerSource: 'api-uptime', deps })
    expect([obs.firing.length, obs.resolved.length, obs.complete]).toEqual([0, 0, false])
    expect(obs.checks?.origin).toBe('api-uptime')
    expect(obs.checks?.cells).toHaveLength(1)
  })

  it('reads the source id as the sender when the header names none', () => {
    const obs = normalizeWebhook({ checks: list([check()]) }, { source: 'sweep', deps })
    expect(obs.checks?.origin).toBe('sweep')
  })

  it('reads the alerts and the checks of one body', () => {
    const obs = normalizeWebhook(am([firing], { checks: list([check()]) }), { source: 'webhook', headerSource: 'api-uptime', deps })
    expect(obs.firing).toHaveLength(1)
    expect(obs.checks?.cells).toHaveLength(1)
  })

  it('leaves a body without checks exactly as it was', () => {
    expect(normalizeWebhook(am([firing]), { source: 'webhook', deps }).checks).toBeUndefined()
  })

  it('still refuses a body with neither alerts nor checks, and a bad check list', () => {
    expect(() => normalizeWebhook({ foo: 1 }, { source: 'webhook', deps })).toThrow(BadPayload)
    expect(() => normalizeWebhook({ checks: { list: [{ id: 'x' }] } }, { source: 'webhook', deps })).toThrow(/list\[0\].service is required/)
  })
})

// ---- the engine --------------------------------------------------------------------------------------

const cfg = loadConfig(here('../config/watch.example.json'))
let engine: Engine
beforeEach(() => {
  clock = T0
  engine = new Engine(openDb(':memory:'), cfg, () => clock)
})

const push = (body: Record<string, unknown>, origin: string, source = 'webhook'): void => {
  engine.ingest(normalizeWebhook(body, { source, headerSource: origin, deps }))
}
const cellsOf = (w: WallState, service: string): RuleCell[] => w.health.find((h) => h.service === service)?.cells ?? []
const states = (w: WallState, service: string): Array<[string, string]> => cellsOf(w, service).map((c): [string, string] => [c.name, c.state]).sort((a, b) => (a[0] < b[0] ? -1 : 1))

describe('the wall draws a check list as real cells', () => {
  it('puts one cell per check on its tile, with the sender and the run time', () => {
    push({ checks: list([check({ instance: 'api-rooms' }), check({ instance: 'site', state: 'pending' }), check({ instance: 'zulip', state: 'failing' }), check({ instance: 'heartbeat', state: 'skipped', lastRunAt: undefined })], { staleAfterSec: 300 }) }, 'api-uptime')
    const w = engine.wall()
    expect(states(w, 'Uptime')).toEqual([
      ['api-rooms', 'ok'],
      ['heartbeat', 'nodata'],
      ['site', 'pending'],
      ['zulip', 'firing']
    ])
    expect(cellsOf(w, 'Uptime').every((c) => c.state !== 'inferred')).toBe(true)
    expect(w.header.rulesWatched).toBe(4)
    expect(cellsOf(w, 'Uptime').find((c) => c.name === 'api-rooms')?.evaluatedAt).toBe(iso(T0 - 30_000))
  })

  it('replaces the dotted history cell of a class the sender now lists', () => {
    resolvedOnce('api-uptime', 'ProbeDown', { service: 'Uptime', instance: 'zulip', component: 'uptime' })
    expect(states(engine.wall(), 'Uptime')).toEqual([['ProbeDown', 'inferred']])
    push({ checks: list([check({ instance: 'zulip' }), check({ instance: 'site' })]) }, 'api-uptime')
    expect(states(engine.wall(), 'Uptime')).toEqual([
      ['site', 'ok'],
      ['zulip', 'ok']
    ])
  })

  it('a complete list drops the check the sender no longer lists, a partial one keeps it', () => {
    push({ checks: list([check({ instance: 'a' }), check({ instance: 'b' })]) }, 'api-uptime')
    push({ checks: list([check({ instance: 'a', state: 'failing' })], { complete: false }) }, 'api-uptime')
    expect(states(engine.wall(), 'Uptime')).toEqual([
      ['a', 'firing'],
      ['b', 'ok']
    ])
    push({ checks: list([check({ instance: 'a' })]) }, 'api-uptime')
    expect(states(engine.wall(), 'Uptime')).toEqual([['a', 'ok']])
  })

  it('keeps two senders of one webhook apart: one sender\'s list never drops the other\'s cells', () => {
    push({ checks: list([check({ instance: 'a' })]) }, 'api-uptime')
    push({ checks: list([check({ id: 'RouterUp', instance: undefined, service: 'API router', state: 'ok' })]) }, 'prod')
    expect(states(engine.wall(), 'Uptime')).toEqual([['a', 'ok']])
    expect(states(engine.wall(), 'API router')).toEqual([['RouterUp', 'ok']])
  })

  it('never drops another source\'s rules, even when the sender is named like that source', () => {
    engine.ingest({ source: 'grafana', kind: 'grafana', at: NOW, firing: [], resolved: [], complete: true, rules: [{ id: 'grafana:r1', source: 'grafana', name: 'r1', service: 'Ingest', state: 'ok' }] })
    push({ checks: list([check({ instance: 'a' })]) }, 'grafana')
    expect(states(engine.wall(), 'Ingest')).toEqual([['r1', 'ok']])
    expect(states(engine.wall(), 'Uptime')).toEqual([['a', 'ok']])
  })

  it('leaves the header\'s oldest evaluation to the polled rules: a check list runs hours apart by design', () => {
    engine.ingest({ source: 'grafana', kind: 'grafana', at: NOW, firing: [], resolved: [], complete: true, rules: [{ id: 'grafana:r1', source: 'grafana', name: 'r1', service: 'Ingest', state: 'ok', evaluatedAt: iso(T0 - 20_000), intervalSec: 60 }] })
    push({ checks: list([check({ lastRunAt: iso(T0 - 5 * H) })], { staleAfterSec: 10 * 3600 }) }, 'sweep')
    const w = engine.wall()
    expect(w.header.rulesWatched).toBe(2)
    expect(w.header.oldestEvaluationAt).toBe(iso(T0 - 20_000))
  })
})

describe('staleness: a list that stops arriving goes dashed', () => {
  const sweepList = (ranAt: number) => ({ checks: list([check({ id: 'FleetDisk', instance: undefined, service: 'Regression sweep', lastRunAt: iso(ranAt) })], { staleAfterSec: 10 * 3600 }) })

  it('the sweep, run four times a day (longest gap 9 h): solid inside 10 h, dashed after', () => {
    push(sweepList(T0), 'sweep', 'sweep')
    expect(states(engine.wall(), 'Regression sweep')).toEqual([['FleetDisk', 'ok']])
    clock = T0 + 9 * H + 30 * 60_000
    expect(states(engine.wall(), 'Regression sweep')).toEqual([['FleetDisk', 'ok']])
    clock = T0 + 10 * H + 60_000
    expect(states(engine.wall(), 'Regression sweep')).toEqual([['FleetDisk', 'stale']])
  })

  it('the prober, run every minute: solid inside 5 minutes, dashed after', () => {
    push({ checks: list([check({ lastRunAt: iso(T0) })], { staleAfterSec: 300 }) }, 'api-uptime')
    clock = T0 + 4 * 60_000
    expect(states(engine.wall(), 'Uptime')).toEqual([['api-rooms', 'ok']])
    clock = T0 + 5 * 60_000 + 1000
    expect(states(engine.wall(), 'Uptime')).toEqual([['api-rooms', 'stale']])
  })

  it('a new list brings the cells back', () => {
    push({ checks: list([check({ lastRunAt: iso(T0) })], { staleAfterSec: 300 }) }, 'api-uptime')
    clock = T0 + 20 * 60_000
    expect(states(engine.wall(), 'Uptime')).toEqual([['api-rooms', 'stale']])
    push({ checks: list([check({ lastRunAt: iso(clock) })], { staleAfterSec: 300 }) }, 'api-uptime')
    expect(states(engine.wall(), 'Uptime')).toEqual([['api-rooms', 'ok']])
  })

  it('judges each check by its own last run: a check the sender did not re-run goes stale while its neighbour stays solid', () => {
    push({ checks: list([check({ instance: 'a', lastRunAt: iso(T0 - 2 * H) }), check({ instance: 'b', lastRunAt: iso(T0 - 60_000) })], { staleAfterSec: 3600 }) }, 'api-uptime')
    expect(states(engine.wall(), 'Uptime')).toEqual([
      ['a', 'stale'],
      ['b', 'ok']
    ])
  })

  it('a check that could not run stays no-data until it is stale-able, and is never claimed as passed', () => {
    push({ checks: list([check({ instance: 'blind', state: 'skipped', lastRunAt: undefined })]) }, 'api-uptime')
    clock = T0 + 30 * H
    expect(states(engine.wall(), 'Uptime')).toEqual([['blind', 'nodata']])
  })

  it('a polled rule keeps its old rule: stale after two intervals, whatever a check list says', () => {
    engine.ingest({ source: 'grafana', kind: 'grafana', at: NOW, firing: [], resolved: [], complete: true, rules: [{ id: 'grafana:r1', source: 'grafana', name: 'r1', service: 'Ingest', state: 'ok', evaluatedAt: iso(T0 - 150_000), intervalSec: 60 }] })
    expect(states(engine.wall(), 'Ingest')).toEqual([['r1', 'stale']])
  })
})

function resolvedOnce(origin: string, rule: string, labels: Record<string, string>): void {
  const make = (): Alert =>
    makeAlert({ origin, fingerprint: `${rule.length}${origin.length}cafebabe0123456789`.slice(0, 16), rule, labels: { alertname: rule, severity: 'warning', ...labels }, startsAt: iso(), via: { source: origin, kind: 'webhook', lastSeen: NOW }, raw: {} }, cfg.serviceMap, iso())
  const fire: Observation = { source: origin, kind: 'webhook', at: iso(), firing: [make()], resolved: [], complete: false }
  engine.ingest(fire)
  clock += 60_000
  engine.ingest({ ...fire, at: iso(), firing: [], resolved: [make()] })
}

describe('a class the sender lists is never a dotted cell, on any tile its history put it on', () => {
  it('shows the sender\'s real cell where the history saw the class, and keeps every other class there dotted', () => {
    resolvedOnce('sweep', 'IntakeContainerLogFailure', { service: 'docs' })
    resolvedOnce('sweep', 'SomeRetiredClass', { service: 'docs' })
    push({ checks: list([check({ id: 'IntakeContainerLogFailure', instance: undefined, service: 'Regression sweep', state: 'ok', lastRunAt: iso(clock - 60_000) })], { staleAfterSec: 36000 }) }, 'sweep', 'sweep')
    expect(states(engine.wall(), 'Docs')).toEqual([
      ['IntakeContainerLogFailure', 'ok'],
      ['SomeRetiredClass', 'inferred']
    ])
  })

  it('takes the worst reading when the sender lists the class on more than one service', () => {
    resolvedOnce('sweep', 'ZombieProcesses', { service: 'prod/scraper' })
    push(
      {
        checks: list([
          check({ id: 'ZombieProcesses', instance: undefined, service: 'prod/docs', state: 'ok' }),
          check({ id: 'ZombieProcesses', instance: undefined, service: 'prod/edge', state: 'failing' })
        ])
      },
      'sweep',
      'sweep'
    )
    expect(states(engine.wall(), 'prod/scraper')).toEqual([['ZombieProcesses', 'firing']])
  })

  it('does not take a class from another sender: the same name from another origin stays dotted', () => {
    resolvedOnce('other-sender', 'ZombieProcesses', { service: 'router-pod' })
    push({ checks: list([check({ id: 'ZombieProcesses', instance: undefined, service: 'prod/docs' })]) }, 'sweep', 'sweep')
    expect(states(engine.wall(), 'Router pod')).toEqual([['ZombieProcesses', 'inferred']])
  })

  it('a tile whose service the sender lists directly shows its checks and nothing from its history', () => {
    resolvedOnce('sweep', 'FleetDisk', {})
    resolvedOnce('sweep', 'RetiredClass', {})
    push({ checks: list([check({ id: 'FleetDisk', instance: undefined, service: 'Regression sweep' })]) }, 'sweep', 'sweep')
    expect(states(engine.wall(), 'Regression sweep')).toEqual([['FleetDisk', 'ok']])
  })

  it('draws no dotted copy of a rule its own source lists on another tile (a Zulip row of the same Grafana alert names the service "grafana")', () => {
    engine.ingest({ source: 'grafana', kind: 'grafana', at: NOW, firing: [], resolved: [], complete: true, rules: [{ id: 'grafana:r1', source: 'grafana', name: 'Metrics job silent (vm-rc-node-4)', service: 'Metrics pipeline', state: 'ok' }] })
    resolvedOnce('grafana', 'Metrics job silent (vm-rc-node-4)', { service: 'grafana' })
    resolvedOnce('grafana', 'A rule nobody lists', { service: 'grafana' })
    const w = engine.wall()
    expect(w.health.map((h) => h.service)).toEqual(['Grafana', 'Metrics pipeline'])
    expect(states(w, 'Grafana')).toEqual([['A rule nobody lists', 'inferred']])
    expect(states(w, 'Metrics pipeline')).toEqual([['Metrics job silent (vm-rc-node-4)', 'ok']])
  })

  it('keeps the promoted cell stale when the sender stops sending', () => {
    resolvedOnce('sweep', 'IntakeContainerLogFailure', { service: 'docs' })
    push({ checks: list([check({ id: 'IntakeContainerLogFailure', instance: undefined, service: 'Regression sweep', lastRunAt: iso(clock) })], { staleAfterSec: 36000 }) }, 'sweep', 'sweep')
    clock += 11 * H
    expect(states(engine.wall(), 'Docs')).toEqual([['IntakeContainerLogFailure', 'stale']])
  })
})

// ---- the endpoint ------------------------------------------------------------------------------------

describe('POST /ingest/<source> with a check list', () => {
  const TOKEN = 'test-ingest-token'
  const appCfg: WatchConfig = {
    baseUrl: 'https://watch.test',
    port: 0,
    host: '127.0.0.1',
    dataDir: ':memory:',
    historyHours: 24,
    staleAfterMisses: 3,
    sources: [
      { id: 'webhook', type: 'webhook', tokenEnv: 'INGEST_TOKEN' },
      { id: 'sweep', type: 'webhook', tokenEnv: 'INGEST_TOKEN', staleAfterSec: 43200 }
    ],
    serviceMap: [],
    channels: [],
    routes: [],
    quietHours: null
  }
  let app: ReturnType<typeof createApp>
  let eng: Engine
  beforeEach(() => {
    const db = openDb(':memory:')
    eng = new Engine(db, appCfg, () => clock)
    const appDeps: AppDeps = {
      engine: eng,
      cfg: appCfg,
      env: { INGEST_TOKEN: TOKEN },
      db,
      push: new SqlitePushStore(db),
      ackSecret: 'ack',
      webDir: '/nonexistent',
      normalizeWebhook: (payload, c) => normalizeWebhook(payload, { ...c, deps }),
      testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
      nudge: () => undefined,
      vapidPublicKey: null,
      now: () => clock
    }
    app = createApp(appDeps)
  })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    Promise.resolve(app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) }))

  it('answers with the number of checks and puts them on /api/state', async () => {
    const r = await post('/ingest/webhook', { checks: list([check({ instance: 'a' }), check({ instance: 'b', state: 'failing' })], { staleAfterSec: 300 }) }, { 'x-alert-source': 'api-uptime' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, firing: 0, resolved: 0, checks: 2 })
    const state = (await (await app.request('/api/state')).json()) as WallState
    expect(states(state, 'Uptime')).toEqual([
      ['a', 'ok'],
      ['b', 'firing']
    ])
    expect(state.sources.find((s) => s.id === 'webhook')?.state).toBe('ok')
  })

  it('counts the sender\'s cells as the rules of its source on the Sources page', async () => {
    await post('/ingest/sweep', { checks: list([check({ id: 'FleetDisk', instance: undefined, service: 'Regression sweep' }), check({ id: 'FleetSwap', instance: undefined, service: 'Regression sweep' })]) })
    const state = (await (await app.request('/api/state')).json()) as WallState
    expect(state.sources.find((s) => s.id === 'sweep')?.rules).toBe(2)
  })

  it('refuses a bad list with 400 and a message that names the field; an alert-only body answers as before', async () => {
    const bad = await post('/ingest/webhook', { checks: list([check({ state: 'green' })]) })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'bad payload', detail: 'checks.list[0].state must be ok, failing, pending or skipped' })
    const alertOnly = await post('/ingest/webhook', { version: '4', groupKey: 'g', alerts: [] })
    expect(alertOnly.status).toBe(200)
    expect(await alertOnly.json()).toEqual({ ok: true, firing: 0, resolved: 0 })
  })

  it('asks for the Bearer token like every ingest', async () => {
    const r = await app.request('/ingest/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checks: list([check()]) }) })
    expect(r.status).toBe(401)
    expect(eng.wall().health).toEqual([])
  })
})
