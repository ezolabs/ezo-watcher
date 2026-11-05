import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/server/config.ts'
import type { VmalertSourceConfig, WatchConfig } from '../src/server/config.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { createVmalertSource } from '../src/server/sources/vmalert.ts'
import type { SourceDeps } from '../src/server/sources/types.ts'
import type { Observation } from '../src/shared/types.ts'

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
// Recorded from the api VictoriaMetrics on 2026-10-15 (the router's vmalert, 70 alerting rules), one file per query the source makes.
const recorded = (name: string): any => JSON.parse(readFileSync(here(`./fixtures/${name}.json`), 'utf8'))
const cfg: WatchConfig = loadConfig(here('./fixtures/watch.config.json'))

const NOW = '2026-10-15T15:00:00.000Z'
const source: VmalertSourceConfig = { id: 'vmalert', type: 'vmalert', url: 'http://127.0.0.1:8428/', pollSec: 30 }

interface Call {
  url: string
  headers: Record<string, string>
}
interface Fake {
  timestamp?: unknown
  known?: unknown
  increase?: unknown
  status?: Partial<Record<'timestamp' | 'known' | 'increase', number>>
  throwOn?: 'timestamp' | 'known' | 'increase'
}

function fakeVm(over: Fake = {}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const q = decodeURIComponent(new URL(url).searchParams.get('query') ?? '')
    const which = q.startsWith('timestamp(') ? 'timestamp' : q.startsWith('last_over_time(') ? 'known' : q.startsWith('increase(') ? 'increase' : null
    if (!which) return new Response('{}', { status: 400 })
    if (over.throwOn === which) throw new TypeError('fetch failed')
    const body = over[which] ?? recorded({ timestamp: 'vmalert-timestamp', known: 'vmalert-known', increase: 'vmalert-increase' }[which])
    return new Response(JSON.stringify(body), { status: over.status?.[which] ?? 200 })
  }
  return { fetch: impl as typeof fetch, calls }
}

const deps = (f: { fetch: typeof fetch }, extra: Partial<SourceDeps> = {}): SourceDeps => ({ fetch: f.fetch, env: {}, nowIso: () => NOW, serviceMap: cfg.serviceMap, ...extra })
const poll = (f: { fetch: typeof fetch }, c: VmalertSourceConfig = source, extra: Partial<SourceDeps> = {}): Promise<Observation> => createVmalertSource(c, deps(f, extra)).poll()

/** A copy of a recorded vector with `edit` applied to the result array. */
function edited(name: string, edit: (r: any[]) => any[]): unknown {
  const j = recorded(name)
  return { ...j, data: { ...j.data, result: edit(j.data.result) } }
}
const sample = (alertname: string, group: string, value: string, id = '1') => ({
  metric: { alertname, group, id, file: '/etc/vmalert/api.rules.yml', instance: 'api-vmalert:8880', job: 'vmalert' },
  value: [1792076564, value]
})

describe('the recorded api vmalert responses', () => {
  it('make 70 cells, all evaluating normally, all on the API router tile', async () => {
    const obs = await poll(fakeVm())
    expect(obs).toMatchObject({ source: 'vmalert', kind: 'vmalert', at: NOW, firing: [], resolved: [], complete: true })
    expect(obs.rules).toHaveLength(70)
    expect(new Set(obs.rules!.map((c) => c.state))).toEqual(new Set(['ok']))
    expect(new Set(obs.rules!.map((c) => c.service))).toEqual(new Set(['API router']))
    expect(new Set(obs.rules!.map((c) => c.id)).size).toBe(70)
    expect(obs.rules!.every((c) => c.source === 'vmalert')).toBe(true)
  })

  it('names the rules as vmalert does, including the three the wall used to show only as dotted history', async () => {
    const names = (await poll(fakeVm())).rules!.map((c) => c.name)
    for (const n of ['ApiWedge', 'ApiSliFastBurn', 'ApiWatchdog', 'ApiDeployTtftRegression', 'ApiSliSlowBurn', 'ApiTokenizationDivergence']) expect(names).toContain(n)
    expect(names.filter((n) => !n.startsWith('Api'))).toEqual([])
  })

  it('reads the age of each reading from the sample time, so a frozen scrape dashes the cell through the engine', async () => {
    const obs = await poll(fakeVm())
    const c = obs.rules!.find((x) => x.name === 'ApiAuthStoreUnavailable')!
    expect(c.evaluatedAt).toBe(new Date(1792076522.001 * 1000).toISOString())
    expect(c.intervalSec).toBe(90)
    expect(c.url).toBeUndefined()
  })

  it('treats a fetch of zero series as normal, not as no data (20 of the 70 rules fetched none on 2026-10-15)', async () => {
    const known = recorded('vmalert-known').data.result as any[]
    const zero = known.filter((r) => r.value[1] === '0')
    expect(zero.length).toBeGreaterThan(10)
    const obs = await poll(fakeVm())
    for (const z of zero) expect(obs.rules!.find((c) => c.name === z.metric.alertname)!.state).toBe('ok')
  })
})

describe('the three queries', () => {
  it('asks for the sample time, the rules seen in the last hour, and the error increase over five minutes', async () => {
    const f = fakeVm()
    await poll(f)
    expect(f.calls).toHaveLength(3)
    const queries = f.calls.map((c) => decodeURIComponent(new URL(c.url).searchParams.get('query')!)).sort()
    expect(queries).toEqual([
      'increase(vmalert_alerting_rules_errors_total[300s])',
      'last_over_time(vmalert_alerting_rules_last_evaluation_series_fetched[3600s])',
      'timestamp(vmalert_alerting_rules_last_evaluation_series_fetched)'
    ])
    expect(f.calls.every((c) => c.url.startsWith('http://127.0.0.1:8428/api/v1/query?query='))).toBe(true)
  })

  it('honours the configured windows, and never a window under a minute', async () => {
    const f = fakeVm()
    await poll(f, { ...source, errorWindowSec: 600, knownWindowSec: 7200 })
    const q = f.calls.map((c) => decodeURIComponent(new URL(c.url).searchParams.get('query')!))
    expect(q).toContain('increase(vmalert_alerting_rules_errors_total[600s])')
    expect(q).toContain('last_over_time(vmalert_alerting_rules_last_evaluation_series_fetched[7200s])')
    const g = fakeVm()
    await poll(g, { ...source, errorWindowSec: 5 })
    expect(g.calls.map((c) => decodeURIComponent(new URL(c.url).searchParams.get('query')!))).toContain('increase(vmalert_alerting_rules_errors_total[60s])')
  })

  it('sends no credential: the VictoriaMetrics is a loopback forward', async () => {
    const f = fakeVm()
    await poll(f)
    for (const c of f.calls) expect(Object.keys(c.headers)).toEqual(['Accept'])
  })
})

describe('rule states', () => {
  it('a rule whose error counter rose in the window is "error", the others stay ok', async () => {
    const increase = edited('vmalert-increase', (r) => r.map((x) => (x.metric.alertname === 'ApiSliFastBurn' ? { ...x, value: [x.value[0], '2'] } : x)))
    const obs = await poll(fakeVm({ increase }))
    expect(obs.rules!.filter((c) => c.state === 'error').map((c) => c.name)).toEqual(['ApiSliFastBurn'])
    expect(obs.rules!.filter((c) => c.state === 'ok')).toHaveLength(69)
  })

  it('a rule that was there within the hour and is gone now is "no data", with no reading time', async () => {
    const timestamp = edited('vmalert-timestamp', (r) => r.filter((x) => x.metric.alertname !== 'ApiWedge'))
    const obs = await poll(fakeVm({ timestamp }))
    const gone = obs.rules!.find((c) => c.name === 'ApiWedge')!
    expect(gone.state).toBe('nodata')
    expect(gone.evaluatedAt).toBeUndefined()
    expect(obs.rules).toHaveLength(70)
  })

  it('a rule gone for longer than the window is not listed at all (a deleted rule stops being watched)', async () => {
    const timestamp = edited('vmalert-timestamp', (r) => r.filter((x) => x.metric.alertname !== 'ApiWedge'))
    const known = edited('vmalert-known', (r) => r.filter((x) => x.metric.alertname !== 'ApiWedge'))
    expect((await poll(fakeVm({ timestamp, known }))).rules).toHaveLength(69)
  })

  it('a new rule is a cell as soon as it shows in the metrics', async () => {
    const timestamp = edited('vmalert-timestamp', (r) => [...r, sample('ApiBrandNewRule', 'api-new', '1792076560', '99')])
    const obs = await poll(fakeVm({ timestamp }))
    expect(obs.rules).toHaveLength(71)
    expect(obs.rules!.find((c) => c.name === 'ApiBrandNewRule')).toMatchObject({ state: 'ok', service: 'API router' })
  })

  it('keeps two rules of one name in two groups apart, and skips a series with no alertname', async () => {
    const t = {
      status: 'success',
      data: { resultType: 'vector', result: [sample('ApiX', 'g1', '1792076500', '1'), sample('ApiX', 'g2', '1792076500', '2'), { metric: { group: 'g3' }, value: [1, '1792076500'] }] }
    }
    const obs = await poll(fakeVm({ timestamp: t, known: t, increase: { status: 'success', data: { resultType: 'vector', result: [] } } }))
    expect(obs.rules!.map((c) => c.id).sort()).toEqual(['vmalert:g1/ApiX:1', 'vmalert:g2/ApiX:2'])
  })

  it('every rule lands on a service tile on purpose, never a stray one named for the source or the job', async () => {
    const t = { status: 'success', data: { resultType: 'vector', result: [sample('R14Something', 'g', '1792076500'), sample('NotAnApiName', 'g', '1792076500', '2'), sample('ApiOk', 'g', '1792076500', '3')] } }
    const obs = await poll(fakeVm({ timestamp: t, known: t }))
    expect(obs.rules!.map((c) => c.service)).toEqual(['API router', 'API router', 'API router'])
    // with no service map at all the fallback is the source id, which is why the map carries an origin entry
    const bare = await poll(fakeVm({ timestamp: t, known: t }), source, { serviceMap: [] })
    expect(new Set(bare.rules!.map((c) => c.service))).toEqual(new Set(['vmalert']))
  })
})

describe('when the VictoriaMetrics does not answer', () => {
  it.each([
    ['an HTTP error', { status: { known: 502 } }, 'vmalert rule history returned HTTP 502'],
    ['a network failure', { throwOn: 'timestamp' as const }, 'vmalert rules request failed: network error'],
    ['a body that is not a vector', { increase: { status: 'error', error: 'bad query' } }, 'vmalert errors returned an unexpected shape'],
    ['a matrix instead of a vector', { timestamp: { status: 'success', data: { resultType: 'matrix', result: [] } } }, 'vmalert rules returned an unexpected shape']
  ])('%s throws, so the poller counts a miss, and names neither the URL nor a header', async (_name, over, message) => {
    const err = await poll(fakeVm(over as Fake)).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(message)
    expect((err as Error).message).not.toContain('127.0.0.1')
  })

  it('an answer with no rules at all is a miss, not an empty inventory: the cells already held are dashed instead of deleted', async () => {
    const none = { status: 'success', data: { resultType: 'vector', result: [] } }
    await expect(poll(fakeVm({ timestamp: none, known: none }))).rejects.toThrow('vmalert reported no rules in the last 3600 s')
    // rules gone from the metrics for less than the window are no data, not a miss
    const goneNow = await poll(fakeVm({ timestamp: none }))
    expect(new Set(goneNow.rules!.map((c) => c.state))).toEqual(new Set(['nodata']))
    expect(goneNow.rules).toHaveLength(70)

    const engine = new Engine(openDb(':memory:'), cfg, () => Date.parse(NOW))
    engine.ingest(await poll(fakeVm()))
    for (let i = 0; i < 3; i++) engine.recordSource('vmalert', false, 'vmalert reported no rules in the last 3600 s')
    const tile = engine.wall().health.find((h) => h.service === 'API router')!
    expect(tile.cells).toHaveLength(70)
    expect(new Set(tile.cells.map((c) => c.state))).toEqual(new Set(['stale']))
  })

  it('three misses make the source stale, dash every one of its cells and raise the stale alert; one answer clears them', async () => {
    let clock = Date.parse(NOW)
    const engine = new Engine(openDb(':memory:'), cfg, () => clock)
    const obs = await poll(fakeVm())
    engine.ingest(obs)
    engine.recordSource('vmalert', true, null)
    const cellsOf = (): string[] => engine.wall().health.find((h) => h.service === 'API router')!.cells.map((c) => c.state)
    expect(new Set(cellsOf())).toEqual(new Set(['ok']))
    expect(engine.sources().find((s) => s.id === 'vmalert')).toMatchObject({ state: 'ok', rules: 70, kind: 'vmalert' })
    for (let i = 0; i < 3; i++) engine.recordSource('vmalert', false, 'vmalert rules request failed: network error')
    expect(engine.sources().find((s) => s.id === 'vmalert')?.state).toBe('stale')
    expect(new Set(cellsOf())).toEqual(new Set(['stale']))
    expect(engine.staleAlerts((id, name) => ({ id, name }) as never).map((a: any) => a.id)).toContain('vmalert')
    expect(engine.wall().header.stale).toBe(true)
    engine.recordSource('vmalert', true, null)
    expect(new Set(cellsOf())).toEqual(new Set(['ok']))
    clock += 1
  })

  it('a frozen reading dashes the cell by itself, before the source is declared stale', async () => {
    let clock = Date.parse('2026-10-15T15:00:00.000Z')
    const engine = new Engine(openDb(':memory:'), cfg, () => clock)
    engine.ingest({ ...(await poll(fakeVm())), rules: (await poll(fakeVm())).rules!.map((c) => ({ ...c, evaluatedAt: new Date(clock - 30_000).toISOString() })) })
    const states = (): Set<string> => new Set(engine.wall().health.find((h) => h.service === 'API router')!.cells.map((c) => c.state))
    expect(states()).toEqual(new Set(['ok']))
    clock += 200_000
    expect(states()).toEqual(new Set(['stale']))
  })
})

describe('the wall with the 70 cells', () => {
  let engine: Engine
  let clock: number
  beforeEach(() => {
    clock = Date.parse(NOW)
    engine = new Engine(openDb(':memory:'), cfg, () => clock)
  })

  it('counts them in rulesWatched and puts them on one API router tile', async () => {
    const before = engine.wall().header.rulesWatched
    engine.ingest(await poll(fakeVm()))
    const w = engine.wall()
    expect(w.header.rulesWatched - before).toBe(70)
    expect(w.health.map((h) => [h.service, h.cells.length])).toEqual([['API router', 70]])
    expect(w.sources.find((s) => s.id === 'vmalert')).toMatchObject({ rules: 70, firing: 0 })
  })

  it('lists the cells that need a look first, so a strip clipped to its tile never hides an error', async () => {
    const increase = edited('vmalert-increase', (r) => r.map((x) => (x.metric.alertname === 'ApiWedge' ? { ...x, value: [x.value[0], '1'] } : x)))
    const timestamp = edited('vmalert-timestamp', (r) => r.filter((x) => x.metric.alertname !== 'ApiWatchdog'))
    engine.ingest(await poll(fakeVm({ increase, timestamp })))
    const cells = engine.wall().health.find((h) => h.service === 'API router')!.cells
    expect(cells.slice(0, 2).map((c) => [c.name, c.state])).toEqual([['ApiWedge', 'error'], ['ApiWatchdog', 'nodata']])
    expect(cells.slice(2).every((c) => c.state === 'ok')).toBe(true)
    expect(cells.slice(2).map((c) => c.name)).toEqual(cells.slice(2).map((c) => c.name).sort())
  })

  it('removes the dotted history cells of a service the rules now cover, whatever their names (a rule of the same name, a retired rule); a test class never had one', async () => {
    // history first: three classes on the router tile, one with a real rule (ApiSliSlowBurn) and one without (a retired rule); the
    // config keeps the third, a wiring test, out of the dotted cells altogether
    const { makeAlert } = await import('../src/server/derive.ts')
    const resolvedAlert = (rule: string, origin: string, n: number): Observation => {
      const a = makeAlert({ origin, fingerprint: `${n}${n}aabbccddeeff0011`, rule, labels: { alertname: rule, severity: 'warning' }, startsAt: new Date(clock - 3600_000).toISOString(), via: { source: origin, kind: 'webhook', lastSeen: NOW }, raw: {} }, cfg.serviceMap, NOW)
      return { source: origin, kind: 'webhook', at: NOW, firing: [a], resolved: [], complete: false }
    }
    for (const [i, rule] of ['ApiSliSlowBurn', 'WatchWiringTest', 'ApiRetiredLongAgo'].entries()) {
      engine.ingest(resolvedAlert(rule, 'prod', i + 1))
      clock += 60_000
      engine.ingest({ source: 'prod', kind: 'webhook', at: new Date(clock).toISOString(), firing: [], resolved: resolvedAlert(rule, 'prod', i + 1).firing, complete: false })
    }
    const inferredBefore = engine.wall().health.find((h) => h.service === 'API router')!.cells
    expect(inferredBefore.map((c) => c.name)).toEqual(['ApiRetiredLongAgo', 'ApiSliSlowBurn'])
    expect(inferredBefore.map((c) => c.state)).toEqual(['inferred', 'inferred'])
    engine.ingest(await poll(fakeVm()))
    const cells = engine.wall().health.find((h) => h.service === 'API router')!.cells
    expect(cells).toHaveLength(70)
    expect(cells.filter((c) => c.state === 'inferred')).toEqual([])
    expect(cells.filter((c) => c.name === 'ApiSliSlowBurn')).toHaveLength(1)
  })
})
