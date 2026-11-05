import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { GrafanaSourceConfig, ServiceRule } from '../src/server/config.ts'
import { alertKey } from '../src/server/derive.ts'
import { createGrafanaSource } from '../src/server/sources/grafana.ts'
import type { SourceDeps } from '../src/server/sources/types.ts'

function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

const NOW = '2026-10-15T05:45:00.000Z'
// A stand-in value; the point is only that it must never show up in an error message.
const FAKE_TOKEN = 'fake-bearer-for-tests'

const cfg: GrafanaSourceConfig = {
  id: 'grafana',
  type: 'grafana',
  url: 'http://grafana.example.net:3000/',
  publicUrl: 'https://grafana.example.com',
  tokenEnv: 'GRAFANA_TOKEN',
  pollSec: 30
}

interface Call {
  url: string
  headers: Record<string, string>
  signal: AbortSignal | null | undefined
}

interface FakeOpts {
  alerts?: unknown
  rules?: unknown
  alertsStatus?: number
  rulesStatus?: number
  throwOn?: 'alerts' | 'rules'
  error?: Error
}

function fakeGrafana(opts: FakeOpts = {}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, headers: init?.headers as Record<string, string>, signal: init?.signal })
    const isAlerts = url.includes('/api/v2/alerts')
    if (opts.throwOn === (isAlerts ? 'alerts' : 'rules')) throw opts.error ?? new TypeError('fetch failed')
    const status = (isAlerts ? opts.alertsStatus : opts.rulesStatus) ?? 200
    const body = isAlerts ? (opts.alerts ?? []) : (opts.rules ?? fixture('grafana-rules.json'))
    return new Response(JSON.stringify(body), { status })
  }
  return { fetch: impl as typeof fetch, calls }
}

function deps(f: { fetch: typeof fetch }, extra: Partial<SourceDeps> = {}): SourceDeps {
  return { fetch: f.fetch, env: { GRAFANA_TOKEN: FAKE_TOKEN }, nowIso: () => NOW, serviceMap: [], ...extra }
}

describe('grafana source with the recorded responses', () => {
  it('reads the 12 real rules as cells and no firing alerts', async () => {
    const f = fakeGrafana({ alerts: fixture('grafana-alerts-empty.json') })
    const obs = await createGrafanaSource(cfg, deps(f)).poll()
    expect(obs).toMatchObject({ source: 'grafana', kind: 'grafana', at: NOW, complete: true })
    expect(obs.firing).toEqual([])
    expect(obs.resolved).toEqual([])
    expect(obs.rules).toHaveLength(12)
    const states = (obs.rules ?? []).map((c) => c.state)
    expect(states.every((s) => s === 'ok' || s === 'nodata')).toBe(true)
    expect(states.filter((s) => s === 'ok')).toHaveLength(4)
    expect(states.filter((s) => s === 'nodata')).toHaveLength(8)
  })

  it('fills a cell from the rule: id, name, evaluation time, group interval, link', async () => {
    const f = fakeGrafana()
    const obs = await createGrafanaSource(cfg, deps(f)).poll()
    const cell = obs.rules?.find((c) => c.name === 'API probe down (4 min streak)')
    expect(cell).toEqual({
      id: 'grafana:api-probe-streak',
      source: 'grafana',
      name: 'API probe down (4 min streak)',
      service: 'Edge probes',
      state: 'nodata',
      evaluatedAt: '2026-10-15T05:21:20Z',
      intervalSec: 60,
      url: 'https://grafana.example.com/alerting/grafana/api-probe-streak/view'
    })
    const ok = obs.rules?.find((c) => c.name === 'API edge dead (no http_events for 5 min)')
    expect(ok?.state).toBe('ok')
  })

  it('maps the service from the service map, falling back to the component label', async () => {
    const map: ServiceRule[] = [{ match: { labels: { component: '^clickhouse-' } }, service: 'clickhouse' }]
    const obs = await createGrafanaSource(cfg, deps(fakeGrafana(), { serviceMap: map })).poll()
    const services = Object.fromEntries((obs.rules ?? []).map((c) => [c.name, c.service]))
    expect(services['API ClickHouse disk at 80%']).toBe('clickhouse')
    expect(services['API ClickHouse disk at 90%']).toBe('clickhouse')
    expect(services['API billing freeze active (probe)']).toBe('Billing')
    expect(services['API vendor balance: a prepaid balance is under its minimum']).toBe('Vendor balance')
  })

  it('makes two GETs with the bearer token, the documented query, and an 8 s timeout', async () => {
    const f = fakeGrafana()
    await createGrafanaSource(cfg, deps(f)).poll()
    expect(f.calls.map((c) => c.url).sort()).toEqual([
      'http://grafana.example.net:3000/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=true&inhibited=true',
      'http://grafana.example.net:3000/api/prometheus/grafana/api/v1/rules'
    ])
    for (const c of f.calls) {
      expect(c.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`)
      expect(c.signal).toBeInstanceOf(AbortSignal)
    }
  })
})

describe('rule cell states', () => {
  function withRule(patch: Record<string, unknown>): Promise<string | undefined> {
    const rules = fixture('grafana-rules.json')
    Object.assign(rules.data.groups[0].rules[2], patch)
    const f = fakeGrafana({ rules })
    return createGrafanaSource(cfg, deps(f))
      .poll()
      .then((o) => o.rules?.find((c) => c.id === 'grafana:api-5xx-ratio')?.state)
  }

  it('maps rule.state and rule.health to the cell state', async () => {
    expect(await withRule({ state: 'firing' })).toBe('firing')
    expect(await withRule({ state: 'pending' })).toBe('pending')
    expect(await withRule({ health: 'nodata' })).toBe('nodata')
    expect(await withRule({ health: 'error' })).toBe('error')
    expect(await withRule({})).toBe('ok')
  })

  it('reads the per-instance state text', async () => {
    const alert = (state: string) => [{ labels: {}, annotations: {}, state, activeAt: '', value: '' }]
    expect(await withRule({ alerts: alert('Normal (NoData)') })).toBe('nodata')
    expect(await withRule({ alerts: alert('Normal (Error)') })).toBe('error')
    expect(await withRule({ alerts: alert('Normal') })).toBe('ok')
  })

  it('lets firing beat nodata, and shows a paused rule as stale', async () => {
    expect(await withRule({ state: 'firing', health: 'nodata' })).toBe('firing')
    expect(await withRule({ isPaused: true })).toBe('stale')
  })

  it('leaves out an evaluation time Grafana has not set and falls back to group+name ids', async () => {
    const rules = fixture('grafana-rules.json')
    delete rules.data.groups[0].rules[0].uid
    rules.data.groups[0].rules[0].lastEvaluation = '0001-01-01T00:00:00Z'
    const obs = await createGrafanaSource(cfg, deps(fakeGrafana({ rules }))).poll()
    const cell = obs.rules?.[0]
    expect(cell?.id).toBe('grafana:api/API probe down (4 min streak)')
    expect(cell?.evaluatedAt).toBeUndefined()
    expect(cell?.url).toBeUndefined()
  })
})

describe('grafana alerts from the Alertmanager v2 shape', () => {
  async function poll(extra: Partial<FakeOpts> = {}) {
    const f = fakeGrafana({ alerts: fixture('synthetic-grafana-alerts-firing.json'), ...extra })
    return createGrafanaSource(cfg, deps(f)).poll()
  }

  it('turns active and suppressed alerts into firing alerts built by makeAlert', async () => {
    const obs = await poll()
    expect(obs.firing.map((a) => a.key)).toEqual(['grafana:a1b2c3d4', 'grafana:ffeeddcc', 'grafana:00112233'])
    expect(obs.resolved).toEqual([])
    const disk = obs.firing[0]
    expect(disk).toMatchObject({
      origin: 'grafana',
      fingerprint: 'a1b2c3d4e5f60718',
      rule: 'API ClickHouse disk at 80%',
      service: 'Clickhouse disk',
      host: 'prod-node-2',
      severity: 'warning',
      severityLabel: 'warn',
      startsAt: '2026-10-15T03:40:20.000Z',
      endsAt: null,
      resolvedAt: null,
      value: 'B=77.2, C=1',
      generatorURL: 'https://grafana.example.com/alerting/grafana/api-disk-80/view?orgId=1'
    })
    expect(disk.status).toEqual({ state: 'active', silencedBy: [], inhibitedBy: [], mutedBy: [] })
    expect(disk.annotations.summary).toBe('ClickHouse disk default is 77.2% full')
    expect(disk.via).toEqual([
      {
        source: 'grafana',
        kind: 'grafana',
        lastSeen: NOW,
        url: 'https://grafana.example.com/alerting/grafana/api-disk-80/view'
      }
    ])
    expect(disk.raw).toMatchObject({ fingerprint: 'a1b2c3d4e5f60718' })
  })

  it('has the same key as a webhook row with the same fp8 would', async () => {
    const obs = await poll()
    expect(obs.firing[0].key).toBe(alertKey('grafana', 'a1b2c3d4'))
  })

  it('builds every link Grafana documents, from the public URL', async () => {
    const links = (await poll()).firing[0].links
    expect(links.generator).toBe('https://grafana.example.com/alerting/grafana/api-disk-80/view?orgId=1')
    expect(links.dashboard).toBe('https://grafana.example.com/d/api-clickhouse')
    expect(links.panel).toBe('https://grafana.example.com/d/api-clickhouse?viewPanel=7')
    expect(links.rule).toBe('https://grafana.example.com/alerting/grafana/api-disk-80/view')
    expect(links.runbook).toBe('https://runbooks.example.com/clickhouse-disk')
    expect(links.silence).toBe('https://grafana.example.com/alerting/silence/new?matcher=alertname%3DAPI+ClickHouse+disk+at+80%25')
  })

  it('links Explore to the rule query from an hour before the alert began', async () => {
    const explore = new URL((await poll()).firing[0].links.explore as string)
    expect(explore.origin + explore.pathname).toBe('https://grafana.example.com/explore')
    expect(explore.searchParams.get('schemaVersion')).toBe('1')
    const pane = JSON.parse(explore.searchParams.get('panes') as string).a
    expect(pane.datasource).toBe('ch-k8s-prod')
    expect(pane.queries).toHaveLength(1)
    expect(pane.queries[0]).toMatchObject({ refId: 'A', datasource: { uid: 'ch-k8s-prod' } })
    expect(pane.queries[0].rawSql).toContain('FROM')
    expect(pane.range).toEqual({ from: String(Date.parse('2026-10-15T03:40:20.000Z') - 3_600_000), to: 'now' })
  })

  it('omits what it cannot build: no dashboard annotations, no rule in the inventory', async () => {
    const alerts = fixture('synthetic-grafana-alerts-firing.json')
    alerts[0].labels.__alert_rule_uid__ = 'gone'
    alerts[0].labels.alertname = 'A rule no longer in the inventory'
    delete alerts[0].annotations.__dashboardUid__
    const links = (await poll({ alerts })).firing[0].links
    expect(links.dashboard).toBeUndefined()
    expect(links.panel).toBeUndefined()
    expect(links.rule).toBeUndefined()
    expect(links.explore).toBeUndefined()
    expect(links.silence).toContain('/alerting/silence/new?matcher=alertname%3DA+rule')
  })

  it('does not build a panel link from a panel id alone', async () => {
    const alerts = fixture('synthetic-grafana-alerts-firing.json')
    delete alerts[0].annotations.__dashboardUid__
    expect((await poll({ alerts })).firing[0].links.panel).toBeUndefined()
  })

  it('falls back to the API url when there is no public url', async () => {
    const f = fakeGrafana({ alerts: fixture('synthetic-grafana-alerts-firing.json') })
    const obs = await createGrafanaSource({ ...cfg, publicUrl: undefined }, deps(f)).poll()
    expect(obs.firing[0].links.dashboard).toBe('http://grafana.example.net:3000/d/api-clickhouse')
    expect(obs.rules?.[0].url).toMatch(/^http:\/\/grafana\.example\.net:3000\/alerting\/grafana\//)
  })

  it('keeps a DatasourceNoData pseudo-alert as a firing alert named for the real rule', async () => {
    const nodata = (await poll()).firing[1]
    expect(nodata.rule).toBe('API probe down (4 min streak)')
    expect(nodata.labels.alertname).toBe('DatasourceNoData')
    expect(nodata.labels.rulename).toBe('API probe down (4 min streak)')
    expect(nodata.severity).toBe('page')
    expect(nodata.service).toBe('Edge probes')
    expect(nodata.links.rule).toBe('https://grafana.example.com/alerting/grafana/api-probe-streak/view')
    // Silencing alertname alone would mute the NoData alert of every rule.
    const silence = new URL(nodata.links.silence as string)
    expect(silence.searchParams.getAll('matcher')).toEqual([
      'alertname=DatasourceNoData',
      'rulename=API probe down (4 min streak)'
    ])
  })

  it('treats DatasourceError the same way', async () => {
    const alerts = fixture('synthetic-grafana-alerts-firing.json')
    alerts[1].labels.alertname = 'DatasourceError'
    const err = (await poll({ alerts })).firing[1]
    expect(err.rule).toBe('API probe down (4 min streak)')
    expect(err.labels.alertname).toBe('DatasourceError')
  })

  it('keeps a suppressed alert and flags it through status', async () => {
    const suppressed = (await poll()).firing[2]
    expect(suppressed.status).toEqual({
      state: 'suppressed',
      silencedBy: ['00000000-0000-4000-8000-000000000013'],
      inhibitedBy: [],
      mutedBy: []
    })
    expect(suppressed.rule).toBe('API edge 5xx ratio (10 min)')
  })

  it('reads an unknown status state as active, and tolerates a missing status', async () => {
    const alerts = fixture('synthetic-grafana-alerts-firing.json')
    alerts[0].status.state = 'firing'
    delete alerts[1].status
    const obs = await poll({ alerts })
    expect(obs.firing[0].status.state).toBe('active')
    expect(obs.firing[1].status.state).toBe('active')
  })

  it('puts an alert whose endsAt has already passed in resolved, not firing', async () => {
    const alerts = fixture('synthetic-grafana-alerts-firing.json')
    alerts[0].endsAt = '2026-10-15T05:40:00.000Z'
    const obs = await poll({ alerts })
    expect(obs.firing.map((a) => a.key)).toEqual(['grafana:ffeeddcc', 'grafana:00112233'])
    expect(obs.resolved).toHaveLength(1)
    expect(obs.resolved[0].resolvedAt).toBe('2026-10-15T05:40:00.000Z')
  })

  it('never links a javascript: runbook and ignores a Go zero-time endsAt', async () => {
    const alerts = fixture('synthetic-grafana-alerts-firing.json')
    alerts[0].annotations.runbook_url = 'javascript:alert(1)'
    alerts[0].endsAt = '0001-01-01T00:00:00.000Z'
    const a = (await poll({ alerts })).firing[0]
    expect(a.links.runbook).toBeUndefined()
    expect(a.endsAt).toBeNull()
  })

  it('derives a fingerprint from the labels when the alert has none', async () => {
    const alerts = fixture('synthetic-grafana-alerts-firing.json')
    delete alerts[0].fingerprint
    const a = (await poll({ alerts })).firing[0]
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(a.key).toBe(`grafana:${a.fingerprint.slice(0, 8)}`)
  })
})

describe('grafana source errors', () => {
  function pollError(f: ReturnType<typeof fakeGrafana>, extra: Partial<SourceDeps> = {}): Promise<Error> {
    return createGrafanaSource(cfg, deps(f, extra)).poll().then(
      () => {
        throw new Error('poll should have failed')
      },
      (e: Error) => e
    )
  }

  it('reports an HTTP error with the status and nothing else', async () => {
    const e = await pollError(fakeGrafana({ alertsStatus: 401 }))
    expect(e.message).toBe('Grafana alerts returned HTTP 401')
    const e2 = await pollError(fakeGrafana({ rulesStatus: 502 }))
    expect(e2.message).toBe('Grafana rules returned HTTP 502')
  })

  it('names a network failure by code, without the URL or the token', async () => {
    const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    const e = await pollError(fakeGrafana({ throwOn: 'rules', error: boom }))
    expect(e.message).toBe('Grafana rules request failed: ECONNREFUSED')
  })

  it('says so when a request times out', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const e = await pollError(fakeGrafana({ throwOn: 'alerts', error: timeout }))
    expect(e.message).toBe('Grafana alerts request failed: timed out after 8 s')
  })

  it('never leaks the token or the query string into any error message', async () => {
    const leaky = new Error(`connect failed http://grafana.example.net:3000/x?active=true token=${FAKE_TOKEN}`)
    const errors = [
      await pollError(fakeGrafana({ throwOn: 'alerts', error: leaky })),
      await pollError(fakeGrafana({ alertsStatus: 403 })),
      await pollError(fakeGrafana({ rules: { status: 'success' } }))
    ]
    for (const e of errors) {
      expect(e.message).not.toContain(FAKE_TOKEN)
      expect(e.message).not.toContain('active=true')
      expect(e.message).not.toContain('grafana.example.net')
    }
  })

  it('names the missing environment variable, not a value', async () => {
    const e = await pollError(fakeGrafana(), { env: {} })
    expect(e.message).toBe('missing environment variable GRAFANA_TOKEN')
  })

  it('rejects an alerts body that is not a list and a rules body of the wrong shape', async () => {
    expect((await pollError(fakeGrafana({ alerts: { message: 'x' } }))).message).toBe('Grafana alerts response is not a list')
    expect((await pollError(fakeGrafana({ rules: [] }))).message).toBe('Grafana rules response has an unexpected shape')
  })

  it('describes itself for the poller', () => {
    const source = createGrafanaSource(cfg, deps(fakeGrafana()))
    expect(source).toMatchObject({ id: 'grafana', kind: 'grafana', name: 'Grafana', pollSec: 30 })
  })
})

describe('heartbeat rules', () => {
  const rulesWith = (state: string, alerts: unknown[]) => ({
    status: 'success',
    data: { groups: [{ name: 'alert-pipeline', file: 'API alerts', interval: 60, rules: [{ uid: 'grafana-heartbeat', name: 'Grafana alert heartbeat', state, health: 'ok', labels: { severity: 'heartbeat', component: 'alert-pipeline' }, alerts, lastEvaluation: '2026-10-15T06:00:00Z' }] }] }
  })
  const heartbeatAlert = {
    labels: { alertname: 'Grafana alert heartbeat', severity: 'heartbeat', component: 'alert-pipeline', __alert_rule_uid__: 'grafana-heartbeat' },
    annotations: { summary: 'fires on purpose' },
    startsAt: '2026-10-15T05:00:00Z',
    endsAt: '2026-10-15T07:00:00Z',
    fingerprint: '09c994cc64b92c63',
    status: { state: 'active', silencedBy: [], inhibitedBy: [], mutedBy: [] },
    receivers: [],
    updatedAt: '2026-10-15T06:00:00Z'
  }

  it('shows an always-firing heartbeat as a healthy cell, never as an incident, and a silent one as an error cell', async () => {
    const alive = await createGrafanaSource(cfg, deps(fakeGrafana({ rules: rulesWith('firing', [{ state: 'Alerting' }]), alerts: [heartbeatAlert] }))).poll()
    expect(alive.firing).toHaveLength(0)
    expect(alive.rules?.[0].state).toBe('ok')
    const dead = await createGrafanaSource(cfg, deps(fakeGrafana({ rules: rulesWith('inactive', []), alerts: [] }))).poll()
    expect(dead.rules?.[0].state).toBe('error')
  })
})
