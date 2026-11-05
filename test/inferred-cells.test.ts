import { describe, expect, it } from 'vitest'
import type { WatchConfig } from '../src/server/config.ts'
import { makeAlert, matchService } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import type { Alert, Observation, RuleCell } from '../src/shared/types.ts'

const NOW = '2026-10-15T15:00:00.000Z'

/** The config these tests read: a service map with two classes of rule, a vmalert source on the router tile, and the test classes excluded. */
const cfg: WatchConfig = {
  baseUrl: 'https://watch.example.com',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [
    { id: 'vmalert', type: 'vmalert', url: 'http://127.0.0.1:8428', pollSec: 30 },
    { id: 'sweep', type: 'webhook', tokenEnv: 'T' },
    { id: 'webhook', type: 'webhook', tokenEnv: 'T' }
  ],
  serviceMap: [
    { match: { origin: '^sweep$', rule: '^Sink' }, service: 'ClickHouse' },
    { match: { origin: '^sweep$', labels: { service: '^clickhouse$' } }, service: 'ClickHouse' },
    { match: { origin: '^vmalert$' }, service: 'API router' }
  ],
  inferredCellExclude: [
    { origin: '^grafana$', rule: 'AlertTest$' },
    { origin: '^sweep$', rule: '^BugFiled' }
  ],
  channels: [],
  routes: [],
  quietHours: null
}

describe('the service map: where the sweep and the router put their cells', () => {
  const sweep = (rule: string, service: string | undefined) => matchService('sweep', rule, { alertname: rule, ...(service ? { service } : {}) }, cfg.serviceMap)

  it('puts the ClickHouse sweep classes on the ClickHouse tile, whatever case the sweep wrote the service in', () => {
    for (const service of ['clickhouse', 'Clickhouse', 'ClickHouse']) expect(sweep('SinkLiveness', service), service).toBe('ClickHouse')
    expect(sweep('SinkStale', undefined)).toBe('ClickHouse')
    expect(sweep('SinkLiveness', 'something-else')).toBe('ClickHouse')
  })

  it('leaves the other sweep classes to their own service label', () => {
    expect(sweep('HelperLag', 'helper')).toBeUndefined()
    expect(sweep('CiRedMain', 'api')).toBeUndefined()
    expect(sweep('FleetDisk', undefined)).toBeUndefined()
  })

  it('does not move another origin: only the sweep is mapped by its class or its lower-case service label', () => {
    expect(matchService('grafana', 'SinkLiveness', { service: 'clickhouse' }, cfg.serviceMap)).toBeUndefined()
  })

  it('keeps the vmalert source on the router tile even for a rule name the pattern does not know', () => {
    expect(matchService('vmalert', 'RouterWedge', {}, cfg.serviceMap)).toBe('API router')
    expect(matchService('vmalert', 'SomethingNew', {}, cfg.serviceMap)).toBe('API router')
  })

  it('registers the vmalert source against the VictoriaMetrics loopback forward, polled every 30 s', () => {
    expect(cfg.sources.find((s) => s.id === 'vmalert')).toEqual({ id: 'vmalert', type: 'vmalert', url: 'http://127.0.0.1:8428', pollSec: 30 })
  })
})

describe('classes that are tests (or that the Watcher reads itself) are never dotted cells, real classes still are', () => {
  const excludes = (origin: string, rule: string): boolean =>
    (cfg.inferredCellExclude ?? []).some((x) => (x.origin === undefined || new RegExp(x.origin).test(origin)) && (x.rule === undefined || new RegExp(x.rule).test(rule)))

  it.each([
    ['grafana', 'WiringAlertTest'],
    ['grafana', 'SampleAlertTest'],
    ['sweep', 'BugFiledByPerson']
  ])('%s %s is excluded', (origin, rule) => {
    expect(excludes(origin, rule)).toBe(true)
  })

  it.each([
    ['sweep', 'AlertUndelivered'],
    ['sweep', 'FleetDisk'],
    ['sweep', 'IntakeToolCallFailure'],
    ['api-uptime', 'ProbeDown'],
    ['sweep', 'ZombieProcesses'],
    ['prod', 'SliSlowBurn'],
    ['grafana', 'Testimonials down']
  ])('%s %s is not', (origin, rule) => {
    expect(excludes(origin, rule)).toBe(false)
  })
})

// ---- the engine --------------------------------------------------------------------------------------

function resolvedOnce(engine: Engine, clock: { ms: number }, cfg: WatchConfig, origin: string, rule: string, labels: Record<string, string>, map = cfg.serviceMap): void {
  const make = (): Alert =>
    makeAlert({ origin, fingerprint: `${rule.length}${origin.length}cafebabe0123456789`.slice(0, 16), rule, labels: { alertname: rule, severity: 'warning', ...labels }, startsAt: new Date(clock.ms).toISOString(), via: { source: origin, kind: 'webhook', lastSeen: NOW }, raw: {} }, map, new Date(clock.ms).toISOString())
  const fire: Observation = { source: origin, kind: 'webhook', at: new Date(clock.ms).toISOString(), firing: [make()], resolved: [], complete: false }
  engine.ingest(fire)
  clock.ms += 60_000
  engine.ingest({ ...fire, at: new Date(clock.ms).toISOString(), firing: [], resolved: [make()] })
}

const rulesOf = (source: string, service: string, names: string[], state: RuleCell['state'] = 'nodata'): Observation => ({
  source,
  kind: 'grafana',
  at: NOW,
  firing: [],
  resolved: [],
  complete: true,
  rules: names.map((name) => ({ id: `${source}:${name}`, source, name, service, state }))
})

describe('the wall folds a service name that differs only in case into the tile the rules inventory names', () => {
  it('an event stored as "Clickhouse" (before the service map knew the sweep) adds no second tile beside "ClickHouse"', () => {
    const clock = { ms: Date.parse(NOW) }
    const engine = new Engine(openDb(':memory:'), cfg, () => clock.ms)
    // what the production database holds: the sweep class stored under the service name the old map produced
    resolvedOnce(engine, clock, cfg, 'sweep', 'SinkLiveness', { service: 'clickhouse' }, [])
    engine.ingest(rulesOf('grafana', 'ClickHouse', ['ClickHouse degraded (node-1)', 'ClickHouse unhealthy (node-1)']))
    const tiles = engine.wall().health.map((h) => h.service)
    expect(tiles).toEqual(['ClickHouse'])
    expect(engine.wall().health[0].cells.map((c) => c.state)).toEqual(['nodata', 'nodata'])
  })

  it('the same class stored under the new mapping lands on the same tile', () => {
    const clock = { ms: Date.parse(NOW) }
    const engine = new Engine(openDb(':memory:'), cfg, () => clock.ms)
    resolvedOnce(engine, clock, cfg, 'sweep', 'SinkLiveness', { service: 'clickhouse' })
    engine.ingest(rulesOf('grafana', 'ClickHouse', ['ClickHouse degraded (node-1)']))
    expect(engine.wall().health.map((h) => h.service)).toEqual(['ClickHouse'])
  })

  it('a firing sweep finding for ClickHouse is an incident on the ClickHouse tile, not on a tile of its own', () => {
    const clock = { ms: Date.parse(NOW) }
    const engine = new Engine(openDb(':memory:'), cfg, () => clock.ms)
    const a = makeAlert({ origin: 'sweep', fingerprint: 'abcdef0123456789', rule: 'SinkStale', labels: { alertname: 'SinkStale', severity: 'warning', service: 'clickhouse' }, startsAt: NOW, via: { source: 'sweep', kind: 'webhook', lastSeen: NOW }, raw: {} }, cfg.serviceMap, NOW)
    engine.ingest({ source: 'sweep', kind: 'webhook', at: NOW, firing: [a], resolved: [], complete: false })
    expect(engine.wall().incidents.map((i) => i.key)).toEqual(['ClickHouse|SinkStale'])
  })

  it('two history rows whose service names differ only in case make one dotted tile, not two', () => {
    const clock = { ms: Date.parse(NOW) }
    const engine = new Engine(openDb(':memory:'), cfg, () => clock.ms)
    resolvedOnce(engine, clock, cfg, 'sweep', 'ClassA', { service: 'Mixed Case Service' }, [])
    resolvedOnce(engine, clock, cfg, 'sweep', 'ClassB', { service: 'mixed case service' }, [])
    const tiles = engine.wall().health
    expect(tiles).toHaveLength(1)
    expect(tiles[0].cells.map((c) => c.name)).toEqual(['ClassA', 'ClassB'])
    expect(tiles[0].cells.every((c) => c.state === 'inferred')).toBe(true)
  })

  it('a service with a rules inventory shows its rules and nothing from its history, even a class with the same name as a rule', () => {
    const clock = { ms: Date.parse(NOW) }
    const engine = new Engine(openDb(':memory:'), cfg, () => clock.ms)
    resolvedOnce(engine, clock, cfg, 'grafana', 'Ingest lagging (node-1)', { service: 'Ingest' })
    resolvedOnce(engine, clock, cfg, 'grafana', 'A class with no rule', { service: 'Ingest' })
    engine.ingest(rulesOf('grafana', 'Ingest', ['Ingest lagging (node-1)']))
    expect(engine.wall().health.find((h) => h.service === 'Ingest')!.cells.map((c) => [c.name, c.state])).toEqual([['Ingest lagging (node-1)', 'nodata']])
  })

  it('a test class leaves no dotted cell, and a real class on the same tile still does', () => {
    const clock = { ms: Date.parse(NOW) }
    const engine = new Engine(openDb(':memory:'), cfg, () => clock.ms)
    resolvedOnce(engine, clock, cfg, 'grafana', 'WiringAlertTest', { service: 'grafana' })
    resolvedOnce(engine, clock, cfg, 'api-uptime', 'ProbeDown', { service: 'Uptime' })
    const tiles = engine.wall().health
    expect(tiles.map((h) => [h.service, h.cells.map((c) => c.name)])).toEqual([['Uptime', ['ProbeDown']]])
  })
})
