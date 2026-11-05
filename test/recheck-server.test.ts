// On-demand re-check: the runner's limits (one poll in flight, one per gap, a failed click is not a missed poll), the answer for the wall and
// for one alert (a polled source, a pushing sender, Watch's own source-stale warning), the HTTP routes, and that a re-check ingests exactly as
// a scheduled poll does. Written, not run, in the session that added it (checks were off).
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { makeAlert } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { PollRunner, RECHECK_GAP_MS, createRechecker } from '../src/server/recheck.ts'
import type { PolledSource } from '../src/server/sources/types.ts'
import { SqlitePushStore } from '../src/server/stores.ts'
import { RECHECK_GAP_SEC } from '../src/shared/recheck.ts'
import type { AlertRecheck, WallRecheck } from '../src/shared/recheck.ts'
import type { Alert, Observation } from '../src/shared/types.ts'

const T0 = Date.parse('2026-10-15T12:00:00Z')
let clock = T0
const iso = (ms = clock): string => new Date(ms).toISOString()

const cfg: WatchConfig = {
  baseUrl: 'https://watch.test',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [
    { id: 'grafana', type: 'grafana', url: 'http://g', tokenEnv: 'X', pollSec: 10 },
    { id: 'vmalert', type: 'vmalert', url: 'http://v', pollSec: 30 },
    { id: 'webhook', type: 'webhook', tokenEnv: 'T' },
    { id: 'sweep', type: 'webhook', tokenEnv: 'T', staleAfterSec: 43200, presenceTtlSec: 86400 }
  ],
  serviceMap: [],
  channels: [],
  routes: [],
  quietHours: null
}

const alertOf = (source: 'grafana' | 'sweep', fingerprint: string, rule = 'DiskFull'): Alert =>
  makeAlert(
    {
      origin: source === 'grafana' ? 'grafana' : 'sweep',
      fingerprint,
      rule,
      labels: { alertname: rule, severity: 'warning', host: 'node-4' },
      annotations: { summary: `${rule} on node-4` },
      startsAt: iso(clock - 60_000),
      via: { source, kind: source === 'grafana' ? 'grafana' : 'webhook', lastSeen: iso() },
      raw: {},
      links: {}
    },
    [],
    iso()
  )

/** A polled source whose next answer the test sets; `calls` counts the polls that really ran. */
function fake(id: string, kind: PolledSource['kind'] = 'grafana') {
  const state = { calls: 0, firing: [] as Alert[], fail: null as string | null, gate: null as Promise<void> | null }
  const src: PolledSource = {
    id,
    kind,
    name: id,
    pollSec: 10,
    async poll(): Promise<Observation> {
      state.calls += 1
      if (state.gate) await state.gate
      if (state.fail) throw new Error(state.fail)
      return { source: id, kind, at: iso(), firing: state.firing, resolved: [], complete: true }
    }
  }
  return { src, state }
}

let engine: Engine
let nudges = 0
const logged: string[] = []
beforeEach(() => {
  clock = T0
  nudges = 0
  logged.length = 0
  engine = new Engine(openDb(':memory:'), cfg, () => clock)
})
const runnerOf = (): PollRunner => new PollRunner(engine, (l) => logged.push(l), () => clock)
const rechecker = (sources: PolledSource[], runner = runnerOf()) => createRechecker({ engine, cfg, runner, sources, nudge: () => void (nudges += 1), nowMs: () => clock })

describe('PollRunner', () => {
  it('a scheduled poll ingests and records, and a re-check does the same through the same door', async () => {
    const g = fake('grafana')
    g.state.firing = [alertOf('grafana', 'a1b2c3d4e5f60718')]
    const runner = runnerOf()
    await runner.scheduled(g.src)
    expect(engine.wall().incidents).toHaveLength(1)
    expect(engine.sources().find((s) => s.id === 'grafana')?.state).toBe('ok')

    clock += RECHECK_GAP_MS
    g.state.firing = []
    const r = await runner.onDemand(g.src)
    expect(r).toMatchObject({ ran: true, shared: false, throttled: false })
    expect(r.outcome.ok).toBe(true)
    // a complete poll that omits the alert resolves it, as the scheduled poll's would
    expect(engine.wall().incidents).toHaveLength(0)
    expect(engine.history(24)).toHaveLength(1)
  })

  it('shares one poll between concurrent clicks', async () => {
    const g = fake('grafana')
    let open!: () => void
    g.state.gate = new Promise<void>((r) => (open = r))
    const runner = runnerOf()
    const a = runner.onDemand(g.src)
    const b = runner.onDemand(g.src)
    const c = runner.onDemand(g.src)
    open()
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(g.state.calls).toBe(1)
    expect([ra.ran, rb.shared, rc.shared]).toEqual([true, true, true])
  })

  it('a click joins a scheduled poll that is running instead of starting a second one', async () => {
    const g = fake('grafana')
    let open!: () => void
    g.state.gate = new Promise<void>((r) => (open = r))
    const runner = runnerOf()
    const scheduled = runner.scheduled(g.src)
    const click = runner.onDemand(g.src)
    open()
    await Promise.all([scheduled, click])
    expect(g.state.calls).toBe(1)
    expect((await click).shared).toBe(true)
  })

  it('polls at most once in the gap, whoever polled last, and says so', async () => {
    const g = fake('grafana')
    const runner = runnerOf()
    await runner.scheduled(g.src)
    clock += RECHECK_GAP_MS - 1
    const inside = await runner.onDemand(g.src)
    expect(inside).toMatchObject({ ran: false, shared: false, throttled: true })
    expect(g.state.calls).toBe(1)
    clock += 1
    const outside = await runner.onDemand(g.src)
    expect(outside).toMatchObject({ ran: true, throttled: false })
    expect(g.state.calls).toBe(2)
    // a burst of clicks right after is throttled again
    for (let k = 0; k < 20; k += 1) await runner.onDemand(g.src)
    expect(g.state.calls).toBe(2)
  })

  it('a failed click is told to the asker and logged, but is not a missed poll', async () => {
    const g = fake('grafana')
    const runner = runnerOf()
    await runner.scheduled(g.src)
    const before = engine.sources().find((s) => s.id === 'grafana')
    clock += RECHECK_GAP_MS
    g.state.fail = 'grafana alerts request failed: ECONNREFUSED'
    const r = await runner.onDemand(g.src)
    expect(r.outcome).toMatchObject({ ok: false, error: 'grafana alerts request failed: ECONNREFUSED' })
    expect(logged.some((l) => l.includes('poll grafana failed'))).toBe(true)
    const after = engine.sources().find((s) => s.id === 'grafana')
    expect(after?.misses).toBe(before?.misses)
    expect(after?.state).toBe('ok')
  })

  it('a failed scheduled poll is a missed poll, as before', async () => {
    const g = fake('grafana')
    g.state.fail = 'boom'
    const runner = runnerOf()
    await runner.scheduled(g.src)
    expect(engine.sources().find((s) => s.id === 'grafana')).toMatchObject({ misses: 1, state: 'error', error: 'boom' })
  })

  it('a failed poll never changes an alert, from a click or a schedule', async () => {
    const g = fake('grafana')
    g.state.firing = [alertOf('grafana', 'a1b2c3d4e5f60718')]
    const runner = runnerOf()
    await runner.scheduled(g.src)
    clock += RECHECK_GAP_MS
    g.state.fail = 'down'
    await runner.onDemand(g.src)
    expect(engine.wall().incidents).toHaveLength(1)
  })
})

describe('the wall re-check', () => {
  it('polls every pull source and counts the alerts that cleared', async () => {
    const g = fake('grafana')
    const v = fake('vmalert', 'vmalert')
    g.state.firing = [alertOf('grafana', 'a1b2c3d4e5f60718'), alertOf('grafana', 'b1b2c3d4e5f60718', 'LoadHigh')]
    const runner = runnerOf()
    const rc = rechecker([g.src, v.src], runner)
    await runner.scheduled(g.src)
    await runner.scheduled(v.src)
    clock += RECHECK_GAP_MS
    g.state.firing = [alertOf('grafana', 'b1b2c3d4e5f60718', 'LoadHigh')]
    const r = await rc.all()
    expect(g.state.calls).toBe(2)
    expect(v.state.calls).toBe(2)
    expect(r.sources.map((s) => [s.id, s.ok, s.ran])).toEqual([
      ['grafana', true, true],
      ['vmalert', true, true]
    ])
    expect(r.cleared).toBe(1)
    expect(r.stillFiring).toBe(1)
    expect(r.pushed).toEqual(['webhook', 'sweep'])
    expect(nudges).toBe(1)
  })

  it('a second click inside the gap polls nothing and wakes nothing', async () => {
    const g = fake('grafana')
    const rc = rechecker([g.src])
    await rc.all()
    const again = await rc.all()
    expect(g.state.calls).toBe(1)
    expect(again.sources[0]).toMatchObject({ ran: false, throttled: true })
    expect(nudges).toBe(1)
    expect(RECHECK_GAP_SEC).toBe(RECHECK_GAP_MS / 1000)
  })

  it('names the sources that did not answer and leaves the alerts they hold alone', async () => {
    const g = fake('grafana')
    g.state.firing = [alertOf('grafana', 'a1b2c3d4e5f60718')]
    const v = fake('vmalert', 'vmalert')
    const runner = runnerOf()
    const rc = rechecker([g.src, v.src], runner)
    await runner.scheduled(g.src)
    clock += RECHECK_GAP_MS
    g.state.fail = 'grafana returned HTTP 502'
    const r = await rc.all()
    expect(r.sources.find((s) => s.id === 'grafana')).toMatchObject({ ok: false, error: 'grafana returned HTTP 502' })
    expect(r.cleared).toBe(0)
    expect(engine.wall().incidents).toHaveLength(1)
  })
})

describe('one alert', () => {
  it('re-polls only the source that raised it and reports a clear', async () => {
    const g = fake('grafana')
    const v = fake('vmalert', 'vmalert')
    const a = alertOf('grafana', 'a1b2c3d4e5f60718')
    g.state.firing = [a]
    const runner = runnerOf()
    const rc = rechecker([g.src, v.src], runner)
    await runner.scheduled(g.src)
    await runner.scheduled(v.src)
    clock += RECHECK_GAP_MS
    const still = (await rc.alert(a.key)) as AlertRecheck
    expect(g.state.calls).toBe(2)
    expect(v.state.calls).toBe(1)
    expect(still).toMatchObject({ before: 'firing', after: 'firing', pushed: [] })
    clock += RECHECK_GAP_MS
    g.state.firing = []
    const gone = (await rc.alert(a.key)) as AlertRecheck
    expect(gone).toMatchObject({ before: 'firing', after: 'resolved' })
    expect(gone.resolvedAt).not.toBeNull()
    expect(gone.sources.map((s) => s.id)).toEqual(['grafana'])
  })

  it('shares one poll across the alerts of one source, however many are asked about at once', async () => {
    const g = fake('grafana')
    const list = [alertOf('grafana', 'a1b2c3d4e5f60718'), alertOf('grafana', 'b1b2c3d4e5f60718', 'LoadHigh'), alertOf('grafana', 'c1b2c3d4e5f60718', 'MemHigh')]
    g.state.firing = list
    const runner = runnerOf()
    const rc = rechecker([g.src], runner)
    await runner.scheduled(g.src)
    clock += RECHECK_GAP_MS
    let open!: () => void
    g.state.gate = new Promise<void>((r) => (open = r))
    const asked = Promise.all(list.map((a) => rc.alert(a.key)))
    open()
    const answers = (await asked) as AlertRecheck[]
    expect(g.state.calls).toBe(2)
    expect(answers.filter((x) => x.sources[0].ran)).toHaveLength(1)
    expect(answers.filter((x) => x.sources[0].shared)).toHaveLength(2)
  })

  it('answers for a pushing sender with who, when it last reported and what it promised, and polls nothing', async () => {
    const g = fake('grafana')
    const a = alertOf('sweep', 'f1f2f3f4f5f60718', 'FleetDisk')
    engine.ingest({ source: 'sweep', kind: 'webhook', at: iso(), firing: [a], resolved: [], complete: false })
    const rc = rechecker([g.src])
    const r = (await rc.alert(a.key)) as AlertRecheck
    expect(g.state.calls).toBe(0)
    expect(r.sources).toEqual([])
    // this config's sweep takes no requests (test/recheck-requests.test.ts has the one that does): request null, and no schedule was pushed
    expect(r.pushed).toEqual([
      { source: 'sweep', sender: 'sweep', lastReportedAt: iso(), atLeastEverySec: 43200, clearsAfterSec: 86400, nextReportAt: null, clearsAt: iso(clock + 86400_000), request: null }
    ])
    expect(r).toMatchObject({ before: 'firing', after: 'firing' })
  })

  it('names the system that raised it when it came through a generic webhook, and falls back to the 6 h presence rule', async () => {
    const a = makeAlert(
      { origin: 'prod', fingerprint: 'e1e2e3e4e5e60718', rule: 'EdgeDead', labels: { alertname: 'EdgeDead', severity: 'page' }, annotations: {}, startsAt: iso(), via: { source: 'webhook', kind: 'webhook', lastSeen: iso() }, raw: {}, links: {} },
      [],
      iso()
    )
    engine.ingest({ source: 'webhook', kind: 'webhook', at: iso(), firing: [a], resolved: [], complete: false })
    const r = (await rechecker([]).alert(a.key)) as AlertRecheck
    expect(r.pushed[0]).toMatchObject({ sender: 'prod through webhook', atLeastEverySec: null, clearsAfterSec: 6 * 3600, clearsAt: iso(clock + 6 * 3600_000) })
  })

  it('an alert both a poll and a webhook report is re-polled and also names the pusher', async () => {
    const g = fake('grafana')
    const a = alertOf('grafana', 'a1b2c3d4e5f60718')
    g.state.firing = [a]
    const runner = runnerOf()
    await runner.scheduled(g.src)
    engine.ingest({ source: 'webhook', kind: 'webhook', at: iso(), firing: [{ ...a, via: [{ source: 'webhook', kind: 'webhook', lastSeen: iso() }] }], resolved: [], complete: false })
    clock += RECHECK_GAP_MS
    const r = (await rechecker([g.src], runner).alert(a.key)) as AlertRecheck
    expect(r.sources.map((s) => s.id)).toEqual(['grafana'])
    expect(r.pushed.map((p) => p.source)).toEqual(['webhook'])
    // the push source still holds it, so a poll that omits it does not clear it
    g.state.firing = []
    clock += RECHECK_GAP_MS
    expect(((await rechecker([g.src], runner).alert(a.key)) as AlertRecheck).after).toBe('firing')
  })

  it("asks the source a source-stale warning is about, and the warning clears once it answers", async () => {
    const g = fake('grafana')
    const runner = runnerOf()
    // three failed scheduled polls: the source reads stale and the engine's own warning is raised the way main's tick raises it
    g.state.fail = 'down'
    for (let k = 0; k < 3; k += 1) await runner.scheduled(g.src)
    const raise = (): void =>
      engine.ingest({
        source: 'self',
        kind: 'self',
        at: iso(),
        firing: engine.staleAlerts((id) =>
          makeAlert({ origin: 'self', fingerprint: `source-stale:${id}`, rule: `${id} is not answering`, labels: { alertname: 'source-stale', severity: 'warning', source: id, service: 'Watcher sources' }, annotations: {}, startsAt: iso(), via: { source: 'self', kind: 'self', lastSeen: iso() }, raw: { source: id } }, [], iso())
        ),
        resolved: [],
        complete: true
      })
    raise()
    const stale = engine.wall().incidents.flatMap((i) => i.alerts).find((x) => x.labels.alertname === 'source-stale') as Alert
    expect(stale).toBeTruthy()
    clock += RECHECK_GAP_MS
    g.state.fail = null
    // main's nudge runs a tick, which re-raises (here: clears) the warning; the test's nudge does that directly
    const rc = createRechecker({ engine, cfg, runner, sources: [g.src], nudge: raise, nowMs: () => clock })
    const r = (await rc.alert(stale.key)) as AlertRecheck
    expect(r.sources.map((s) => s.id)).toEqual(['grafana'])
    expect(r.clearsOnSweep).toBe(true)
    expect(r).toMatchObject({ before: 'firing', after: 'resolved' })
  })

  it('is null for a key Watch has never held', async () => {
    expect(await rechecker([fake('grafana').src]).alert('grafana:00000000')).toBeNull()
  })
})

describe('POST /api/recheck', () => {
  function boot(withRecheck = true) {
    const g = fake('grafana')
    const deps: AppDeps = {
      engine,
      cfg,
      env: {},
      db: engine.db,
      push: new SqlitePushStore(engine.db),
      ackSecret: ['recheck', 'test', '0001'].join('-'),
      webDir: '/nonexistent',
      normalizeWebhook: () => {
        throw new Error('unused')
      },
      testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
      nudge: () => undefined,
      ...(withRecheck ? { recheck: rechecker([g.src]) } : {}),
      vapidPublicKey: null,
      now: () => clock
    }
    return { app: createApp(deps), g }
  }

  it('answers the whole wall, uncached, and is throttled by the gap on the second call', async () => {
    const { app, g } = boot()
    const res = await app.request('/api/recheck', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as WallRecheck
    expect(body.sources).toHaveLength(1)
    const again = (await (await app.request('/api/recheck', { method: 'POST' })).json()) as WallRecheck
    expect(again.sources[0].throttled).toBe(true)
    expect(g.state.calls).toBe(1)
  })

  it('answers one alert, 404s an unknown key, and takes a key with a colon in the path', async () => {
    const { app, g } = boot()
    const a = alertOf('grafana', 'a1b2c3d4e5f60718')
    g.state.firing = [a]
    engine.ingest({ source: 'grafana', kind: 'grafana', at: iso(), firing: [a], resolved: [], complete: true })
    const ok = await app.request(`/api/recheck/${encodeURIComponent(a.key)}`, { method: 'POST' })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as AlertRecheck).key).toBe(a.key)
    expect((await app.request('/api/recheck/grafana:00000000', { method: 'POST' })).status).toBe(404)
  })

  it('refuses a cross-site request like every state-changing call, and is POST only', async () => {
    const { app, g } = boot()
    const cross = await app.request('/api/recheck', { method: 'POST', headers: { origin: 'https://evil.example', host: 'watch.test' } })
    expect(cross.status).toBe(403)
    expect(g.state.calls).toBe(0)
    expect((await app.request('/api/recheck', { method: 'GET' })).status).toBe(404)
  })

  it('answers 503 when no re-checker is wired', async () => {
    const { app } = boot(false)
    expect((await app.request('/api/recheck', { method: 'POST' })).status).toBe(503)
  })
})
