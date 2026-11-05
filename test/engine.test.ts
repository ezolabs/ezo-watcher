import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { makeAlert } from '../src/server/derive.ts'
import type { AlertDraft } from '../src/server/derive.ts'
import type { WatchConfig } from '../src/server/config.ts'
import type { Alert, Observation, RuleCell } from '../src/shared/types.ts'
import { fingerprintDigest } from '../src/server/notify/plan.ts'

const T0 = Date.parse('2026-10-14T12:00:00Z')
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
    // A second polled source that sees the same alerts with fewer labels (it was the Zulip bridge poll; the id and kind stay so the stored shapes keep being tested).
    { id: 'zulip-alerts', type: 'vmalert', url: 'http://z', pollSec: 15 },
    { id: 'webhook', type: 'webhook', tokenEnv: 'T' },
    { id: 'sweep', type: 'webhook', tokenEnv: 'T', staleAfterSec: 43200, presenceTtlSec: 86400 }
  ],
  serviceMap: [{ match: { origin: '^(?:prod|dev)$' }, service: 'API router' }],
  channels: [],
  routes: [{ id: 'page', match: { severity: ['page'] }, receivers: [], mode: 'all', groupWaitSec: 0, groupIntervalSec: 60, repeatIntervalSec: 600, escalate: [{ afterSec: 600, receivers: [] }] }],
  quietHours: null
}

function draft(over: Partial<AlertDraft> & { source?: string; kind?: 'grafana' | 'zulip' | 'webhook' } = {}): AlertDraft {
  const source = over.source ?? 'grafana'
  return {
    origin: over.origin ?? 'grafana',
    fingerprint: over.fingerprint ?? 'a1b2c3d4e5f60718',
    rule: over.rule ?? 'API edge dead',
    labels: over.labels ?? { alertname: 'API edge dead', component: 'edge', severity: 'page', instance: 'edge-1:9100' },
    annotations: over.annotations ?? { summary: 'No http_events for 5 minutes' },
    startsAt: over.startsAt ?? iso(clock - 60_000),
    via: { source, kind: over.kind ?? 'grafana', lastSeen: iso() },
    raw: over.raw ?? { from: source },
    links: over.links ?? {}
  }
}

const alert = (d: AlertDraft): Alert => makeAlert(d, cfg.serviceMap, iso())

function obs(source: string, firing: Alert[], extra: Partial<Observation> = {}): Observation {
  return { source, kind: source === 'zulip-alerts' ? 'zulip' : source === 'webhook' ? 'webhook' : 'grafana', at: iso(), firing, resolved: [], complete: source !== 'webhook', ...extra }
}

let engine: Engine
beforeEach(() => {
  clock = T0
  engine = new Engine(openDb(':memory:'), cfg, () => clock)
})

describe('a source taken out of the config (the Zulip bridge poll)', () => {
  // The engine is restarted on a config without the source; the DB still holds what the source reported.
  const without = (...ids: string[]): Engine => new Engine(engine.db, { ...cfg, sources: cfg.sources.filter((s) => !ids.includes(s.id)) }, () => clock)

  it('resolves an alert only that source reported, with the resolved event, and leaves the history alone', () => {
    engine.ingest(obs('zulip-alerts', [alert(draft({ source: 'zulip-alerts', kind: 'zulip', fingerprint: 'a1b2c3d4', labels: { alertname: 'API edge dead' } }))]))
    expect(engine.wall().incidents).toHaveLength(1)
    clock += 60_000
    const after = without('zulip-alerts')
    expect(after.dropRemovedSources()).toEqual({ presenceRows: 1, resolved: 1, firingEdited: 0 })
    expect(after.wall().incidents).toHaveLength(0)
    expect(after.history(24)).toHaveLength(1)
    expect(after.notifyViews().views).toEqual([])
    expect(after.notifyViews().resolved).toHaveLength(1)
  })

  it('keeps an alert another source still reports firing, drops the removed source from where it was seen, and lets it resolve with that source', () => {
    engine.ingest(obs('grafana', [alert(draft())]))
    engine.ingest(obs('zulip-alerts', [alert(draft({ source: 'zulip-alerts', kind: 'zulip', fingerprint: 'a1b2c3d4', labels: { alertname: 'API edge dead' } }))]))
    expect(engine.wall().incidents[0].alerts[0].via.map((v) => v.source).sort()).toEqual(['grafana', 'zulip-alerts'])
    clock += 60_000
    const after = without('zulip-alerts')
    expect(after.dropRemovedSources()).toEqual({ presenceRows: 1, resolved: 0, firingEdited: 1 })
    expect(after.wall().incidents[0].alerts[0].via.map((v) => v.source)).toEqual(['grafana'])
    // Before this, the removed source's presence row held the alert firing after Grafana dropped it, for good.
    clock += 15_000
    after.ingest(obs('grafana', []))
    expect(after.wall().incidents).toHaveLength(0)
    expect(after.history(24)).toHaveLength(1)
  })

  it('changes nothing when every source is still configured, and never touches the engine\'s own source-stale alerts', () => {
    engine.ingest(obs('grafana', [alert(draft())]))
    engine.ingest({ source: 'self', kind: 'self', at: iso(), firing: [alert(draft({ source: 'self', kind: 'grafana', origin: 'self', fingerprint: 'source-stale:x', rule: 'x is not answering', labels: { alertname: 'source-stale', severity: 'warning', source: 'x', service: 'Watcher sources' } }))], resolved: [], complete: true })
    expect(engine.dropRemovedSources()).toEqual({ presenceRows: 0, resolved: 0, firingEdited: 0 })
    expect(engine.wall().incidents).toHaveLength(2)
    expect(without('zulip-alerts').dropRemovedSources().presenceRows).toBe(0)
  })
})

describe('reconcile', () => {
  it('merges the same alert seen by two channels into one, keeping both vias and all links', () => {
    engine.ingest(obs('grafana', [alert(draft({ links: { panel: 'http://g/d/x?viewPanel=2' } }))]))
    engine.ingest(
      obs('zulip-alerts', [
        alert(draft({ source: 'zulip-alerts', kind: 'zulip', fingerprint: 'a1b2c3d4', labels: { alertname: 'API edge dead' }, links: { dashboard: 'https://chat.test/d/x' } }))
      ])
    )
    const wall = engine.wall()
    expect(wall.incidents).toHaveLength(1)
    const a = wall.incidents[0].alerts[0]
    expect(a.via.map((v) => v.source).sort()).toEqual(['grafana', 'zulip-alerts'])
    expect(a.links.panel).toBeDefined()
    expect(a.links.dashboard).toBeDefined()
    expect(a.labels.component).toBe('edge')
  })

  it('resolves only when no channel still reports it, then drops it off the wall into history', () => {
    const g = alert(draft())
    const z = alert(draft({ source: 'zulip-alerts', kind: 'zulip', fingerprint: 'a1b2c3d4', labels: { alertname: 'API edge dead' } }))
    engine.ingest(obs('grafana', [g]))
    engine.ingest(obs('zulip-alerts', [z]))
    clock += 30_000
    engine.ingest(obs('grafana', []))
    expect(engine.wall().incidents).toHaveLength(1)
    clock += 15_000
    engine.ingest(obs('zulip-alerts', []))
    expect(engine.wall().incidents).toHaveLength(0)
    const hist = engine.history(24)
    expect(hist).toHaveLength(1)
    expect(hist[0].rule).toBe('API edge dead')
    expect(hist[0].durationSec).toBeGreaterThan(0)
  })

  it('re-fires a resolved alert as a new episode', () => {
    engine.ingest(obs('grafana', [alert(draft())]))
    clock += 10_000
    engine.ingest(obs('grafana', []))
    clock += 10_000
    engine.ingest(obs('grafana', [alert(draft({ startsAt: iso() }))]))
    expect(engine.wall().incidents).toHaveLength(1)
    expect(engine.history(24)).toHaveLength(1)
  })

  it('expires webhook presence when no resend arrives, since a webhook is never a complete state', () => {
    const w = alert(draft({ source: 'webhook', kind: 'webhook', origin: 'prod', fingerprint: 'ffeeddcc99887766', labels: { alertname: 'ApiWedge', severity: 'warning' } }))
    engine.ingest(obs('webhook', [w], { complete: false }))
    expect(engine.wall().incidents[0].service).toBe('API router')
    clock += 7 * 3600_000
    engine.sweep()
    expect(engine.wall().incidents).toHaveLength(0)
  })

  it('seeds history from resolved topics exactly once', () => {
    const r = alert(draft({ source: 'zulip-alerts', kind: 'zulip', origin: 'prod', fingerprint: '11223344', rule: 'ApiSliSlowBurn', labels: { alertname: 'ApiSliSlowBurn' }, startsAt: iso(clock - 3600_000) }))
    r.resolvedAt = iso(clock - 1800_000)
    engine.ingest(obs('zulip-alerts', [], { resolvedHistory: [r] }))
    engine.ingest(obs('zulip-alerts', [], { resolvedHistory: [r] }))
    expect(engine.history(24)).toHaveLength(1)
  })
})

describe('a webhook source that pushes on a schedule (sweep)', () => {
  const sweepAlert = (fp = 'a1b2c3d4e5f60718') =>
    alert(draft({ source: 'sweep', kind: 'webhook', origin: 'sweep', fingerprint: fp, rule: 'ZombieProcesses', labels: { alertname: 'ZombieProcesses', severity: 'warning', service: 'prod/scraper' } }))
  const push = (list: Alert[]): void => {
    engine.ingest(obs('sweep', list, { kind: 'webhook', complete: false }))
    engine.recordSource('sweep', true, null) // what the ingest handler does after a good POST
  }
  const sweepSource = () => engine.sources().find((s) => s.id === 'sweep')!

  it('is idle until its first push, ok after it, stale once silent longer than staleAfterSec, and ok again on the next push', () => {
    expect(sweepSource().state).toBe('idle')
    push([sweepAlert()])
    expect(sweepSource().state).toBe('ok')
    clock += 43200_000 - 1000
    expect(sweepSource().state).toBe('ok')
    clock += 2000
    const s = sweepSource()
    expect(s.state).toBe('stale')
    expect(s.error).toMatch(/Nothing pushed for 12\u00a0h \(it should push at least every 12\u00a0h\)/)
    expect(engine.wall().header.stale).toBe(true)
    push([sweepAlert()])
    expect(sweepSource().state).toBe('ok')
    expect(engine.wall().header.stale).toBe(false)
  })

  it('tells the page how long it may be silent: a source that promised a schedule carries it, one that did not carries nothing', () => {
    expect(sweepSource().staleAfterSec).toBe(43200)
    expect(engine.sources().find((s) => s.id === 'webhook')?.staleAfterSec).toBeUndefined()
    expect(engine.sources().find((s) => s.kind === 'grafana')?.staleAfterSec).toBeUndefined()
  })

  it('a stale push source that promised a schedule raises a page of its own; one that promised nothing stays quiet', () => {
    push([])
    clock += 13 * 3600_000
    expect(sweepSource().state).toBe('stale')
    const alerts = engine.staleAlerts((id, name) => alert(draft({ origin: 'self', fingerprint: `s:${id}`, rule: name })))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('page')
    expect(alerts[0].rule).toBe('sweep')
  })

  it('keeps a pushed alert firing for its own presenceTtlSec (24 h), not the 6 h default, then drops it', () => {
    push([sweepAlert()])
    clock += 9 * 3600_000 // the longest gap between scheduled runs
    engine.sweep()
    expect(engine.wall().incidents).toHaveLength(1)
    clock += 14 * 3600_000 // 23 h since the last push
    engine.sweep()
    expect(engine.wall().incidents).toHaveLength(1)
    clock += 2 * 3600_000 // 25 h
    engine.sweep()
    expect(engine.wall().incidents).toHaveLength(0)
  })

  it('a re-push keeps the same alert (one tile, no new fired event) and a resolved push removes it', () => {
    push([sweepAlert()])
    const fired = () => engine.incidentDetail(engine.wall().incidents[0].key).events.filter((e) => e.kind === 'fired').length
    const before = fired()
    clock += 5 * 3600_000
    push([sweepAlert()])
    clock += 5 * 3600_000
    push([sweepAlert()])
    expect(engine.wall().incidents).toHaveLength(1)
    expect(engine.wall().incidents[0].alerts).toHaveLength(1)
    expect(fired()).toBe(before)
    const gone = { ...sweepAlert(), endsAt: iso() }
    engine.ingest({ source: 'sweep', kind: 'webhook', at: iso(), firing: [], resolved: [gone], complete: false })
    expect(engine.wall().incidents).toHaveLength(0)
  })

  it('a page that joins an older warning of the same incident starts its own clock, so it does not escalate as if it were hours old', () => {
    const at = (fp: string, severity: string, startsAt: string): Alert =>
      alert(draft({ source: 'sweep', kind: 'webhook', origin: 'sweep', fingerprint: fp, rule: 'FleetDisk', startsAt, labels: { alertname: 'FleetDisk', severity, host: fp } }))
    push([at('aa11bb22cc33dd44', 'warning', iso(clock - 5 * 3600_000))])
    expect(engine.notifyViews().views[0].unattendedSec).toBeGreaterThan(4.9 * 3600)
    push([at('aa11bb22cc33dd44', 'warning', iso(clock - 5 * 3600_000)), at('ee55ff66aa77bb88', 'page', iso())])
    const v = engine.notifyViews().views[0]
    expect(v.severity).toBe('page')
    expect(v.instances).toHaveLength(1) // the pager speaks for the page-level alerts only
    expect(engine.wall().incidents[0].alerts).toHaveLength(2) // the wall still shows both
    expect(v.unattendedSec).toBeLessThan(5)
    expect(v.startsAt).toBe(iso())
    clock += 700_000
    expect(engine.notifyViews().views[0].unattendedSec).toBeGreaterThan(600) // the SMS step is due 10 min after the PAGE began
  })

  it('a warning leaving or joining a page\'s incident does not change what the pager dedupes on, so the page is not re-sent', () => {
    const at = (fp: string, severity: string): Alert =>
      alert(draft({ source: 'sweep', kind: 'webhook', origin: 'sweep', fingerprint: fp, rule: 'FleetDisk', labels: { alertname: 'FleetDisk', severity, host: fp } }))
    const digest = () => fingerprintDigest(engine.notifyViews().views[0])
    push([at('aa11bb22cc33dd44', 'warning'), at('ee55ff66aa77bb88', 'page')])
    const v = engine.notifyViews().views[0]
    expect(v.severity).toBe('page')
    expect(v.instances.map((x) => x.fingerprint)).toEqual(['ee55ff66aa77bb88'])
    const before = digest()
    // the warning clears: the page's digest is unchanged
    engine.ingest({ source: 'sweep', kind: 'webhook', at: iso(), firing: [], resolved: [{ ...at('aa11bb22cc33dd44', 'warning'), endsAt: iso() }], complete: false })
    expect(digest()).toBe(before)
    // a second page joins: now it IS news
    push([at('ee55ff66aa77bb88', 'page'), at('99887766aabbccdd', 'page')])
    expect(digest()).not.toBe(before)
  })

  it('a source with no setting is never stale and keeps the 6 h presence', () => {
    engine.recordSource('webhook', true, null)
    clock += 30 * 24 * 3600_000
    expect(engine.sources().find((s) => s.id === 'webhook')!.state).toBe('ok')
  })
})

describe('attention', () => {
  it('ack shrinks the tile and is visible; silence drops it to the quiet tier; unack restores it', () => {
    engine.ingest(obs('grafana', [alert(draft({ startsAt: iso(clock - 3 * 3600_000) }))]))
    const key = engine.wall().incidents[0].key
    const open = engine.wall().incidents[0].state.R
    expect(engine.ack(key, 'the operator')).toBe(true)
    const acked = engine.wall().incidents[0]
    expect(acked.state.attention).toBe('acked')
    expect(acked.state.R).toBeLessThan(open)
    expect(acked.ackedBy).toBe('the operator')
    expect(engine.silence(key, 60, 'the operator')).toBe(true)
    expect(engine.wall().incidents[0].state.tier).toBe('quiet')
    engine.unack(key, 'the operator')
    expect(engine.wall().incidents[0].state.attention).toBe('none')
  })

  it('refuses to ack something that is not firing', () => {
    expect(engine.ack('nothing|here', 'the operator')).toBe(false)
  })
})

describe('proof of watch', () => {
  const cell = (over: Partial<RuleCell>): RuleCell => ({ id: 'grafana:r1', source: 'grafana', name: 'r1', service: 'API edge', state: 'ok', evaluatedAt: iso(clock - 20_000), intervalSec: 60, ...over })

  it('counts rules, reports the oldest evaluation, and never claims an all clear from a stale source', () => {
    engine.recordSource('grafana', true, null)
    engine.ingest(obs('grafana', [], { rules: [cell({}), cell({ id: 'grafana:r2', name: 'r2', evaluatedAt: iso(clock - 45_000) })] }))
    let w = engine.wall()
    expect(w.header.rulesWatched).toBe(2)
    expect(w.header.firing).toBe(0)
    expect(w.header.oldestEvaluationAt).toBe(iso(clock - 45_000))
    expect(w.header.stale).toBe(false)
    expect(w.health[0].cells.every((c) => c.state === 'ok')).toBe(true)
    for (let i = 0; i < 3; i++) engine.recordSource('grafana', false, 'timeout')
    w = engine.wall()
    expect(w.header.stale).toBe(true)
    expect(w.health[0].cells.every((c) => c.state === 'stale')).toBe(true)
    expect(engine.staleAlerts((id, name) => alert(draft({ origin: 'self', fingerprint: `s:${id}`, rule: name })))).toHaveLength(1)
    engine.recordSource('grafana', true, null)
    expect(engine.wall().header.stale).toBe(false)
  })

  it('marks a cell stale when its rule has not run for two intervals', () => {
    engine.recordSource('grafana', true, null)
    engine.ingest(obs('grafana', [], { rules: [cell({ evaluatedAt: iso(clock - 150_000) })] }))
    expect(engine.wall().health[0].cells[0].state).toBe('stale')
  })
})

describe('what the pager reads', () => {
  it('reports unattended seconds that stop at the ack, and flags flapping after three flips in 30 minutes', () => {
    engine.ingest(obs('grafana', [alert(draft({ startsAt: iso(clock - 120_000) }))]))
    clock += 60_000
    let v = engine.notifyViews().views[0]
    expect(v.unattendedSec).toBeGreaterThanOrEqual(180)
    engine.ack(v.key, 'the operator')
    clock += 600_000
    v = engine.notifyViews().views[0]
    expect(v.attention).toBe('acked')
    expect(v.unattendedSec).toBeLessThan(200)
    // flap: resolve, refire, resolve
    engine.ingest(obs('grafana', []))
    clock += 20_000
    engine.ingest(obs('grafana', [alert(draft({ startsAt: iso() }))]))
    expect(engine.notifyViews().views[0].flapping).toBe(true)
  })
})

describe('identity across channels', () => {
  it('keeps the incident the poll chose when a chat row with fewer labels arrives later', () => {
    engine.ingest(obs('grafana', [alert(draft({ labels: { alertname: 'API edge dead', component: 'edge', severity: 'page' } }))]))
    const key = engine.wall().incidents[0].key
    engine.ingest(obs('zulip-alerts', [alert(draft({ source: 'zulip-alerts', kind: 'zulip', fingerprint: 'a1b2c3d4', labels: { alertname: 'API edge dead' } }))]))
    const w = engine.wall()
    expect(w.incidents).toHaveLength(1)
    expect(w.incidents[0].key).toBe(key)
    expect(w.incidents[0].alerts[0].labels.component).toBe('edge')
  })
})

describe('worst first and wall-only', () => {
  const disk = (host: string, severity: string, summary: string) =>
    alert(draft({ origin: 'sweep', source: 'sweep', kind: 'webhook', fingerprint: `${host}00000000aabb`, rule: 'FleetDisk', labels: { alertname: 'FleetDisk', severity, host }, annotations: { summary }, startsAt: iso(clock - 3600_000) }))

  it('lists the instances worst first: the page, then the shortest ETA, so the headline names node-5 and not the first host', () => {
    const node4 = disk('node-4', 'warning', 'node-4 disk / 89.3% (100 GB free, full in ~1.9d)')
    const node5 = disk('node-5', 'page', 'node-5 disk / 81% (175 GB free, full in ~8h)')
    const node6 = disk('node-6', 'warning', 'node-6 disk / 88.1% (111 GB free, full in ~1.1d)')
    engine.ingest(obs('webhook', [node4, node5, node6], { complete: false }))
    const inc = engine.wall().incidents[0]
    expect(inc.alerts.map((a) => a.host)).toEqual(['node-5', 'node-6', 'node-4'])
    expect(inc.summary).toBe('node-5 disk / 81% (175 GB free, full in ~8h)')
    expect(inc.severity).toBe('page')
  })

  it('hands the notifier the same order, with each instance own severity, summary and annotations for the email', () => {
    const pages = ['node-4', 'node-5', 'node-6'].map((h, i) => disk(h, 'page', `${h} disk / ${80 + i}% (full in ~${[46, 8, 26][i]}h)`))
    engine.ingest(obs('webhook', pages, { complete: false }))
    const [view] = engine.notifyViews().views
    expect(view.instances.map((i) => i.name)).toEqual(['node-5', 'node-6', 'node-4'])
    expect(view.summary).toBe('node-5 disk / 81% (full in ~8h)')
    expect(view.instances[0]).toMatchObject({ severity: 'page', summary: 'node-5 disk / 81% (full in ~8h)' })
    expect(view.instances[0].annotations?.summary).toBe('node-5 disk / 81% (full in ~8h)')
  })

  it('flags an incident whose routes have no receivers as wall-only, and not one that can notify or escalate', () => {
    const page = (receivers: string[], escalate: string[]) =>
      new Engine(openDb(':memory:'), { ...cfg, routes: [{ ...cfg.routes[0], receivers, escalate: [{ afterSec: 600, receivers: escalate }] }] }, () => clock)
    const wallOnly = (e: Engine): boolean => {
      e.ingest(obs('grafana', [alert(draft())]))
      return e.wall().incidents[0].wallOnly
    }
    expect(wallOnly(page([], []))).toBe(true)
    expect(wallOnly(page(['ntfy'], []))).toBe(false)
    expect(wallOnly(page([], ['sms']))).toBe(false)
    // an incident no route matches notifies nobody either
    engine.ingest(obs('grafana', [alert(draft({ labels: { alertname: 'Noted', severity: 'info' } }))]))
    expect(engine.wall().incidents[0].wallOnly).toBe(true)
  })

  it('names an instance with no host by its own summary, never by the alertname the incident is titled with', () => {
    const finding = (n: number, summary: string) =>
      alert(draft({ origin: 'sweep', source: 'sweep', kind: 'webhook', fingerprint: `f${n}00000000aabb`, rule: 'IntakeSinkStale', labels: { alertname: 'IntakeSinkStale', severity: 'warning', probe: 'intake', source: 'sink_stale' }, annotations: { summary } }))
    engine.ingest(obs('webhook', [finding(1, 'ClickHouse tables unread/stale: 0 unread, 1 stale'), finding(2, 'sink_stale: sink_stale/app_telemetry.engine_events x302')], { complete: false }))
    const [view] = engine.notifyViews().views
    expect(view.rule).toBe('IntakeSinkStale')
    expect(view.instances.map((i) => [i.name, i.nameSource])).toEqual([
      ['ClickHouse tables unread/stale: 0 unread, 1 stale', 'summary'],
      ['sink_stale: sink_stale/app_telemetry.engine_events x302', 'summary']
    ])
    // a host still names its instance
    engine.ingest(obs('webhook', [disk('node-5', 'warning', 'node-5 disk / 81%')], { complete: false }))
    expect(engine.notifyViews().views.find((v) => v.rule === 'FleetDisk')?.instances[0]).toMatchObject({ name: 'node-5', nameSource: 'host' })
  })

  it('names no next step for an escalation step that has no receivers', () => {
    engine.ingest(obs('grafana', [alert(draft({ startsAt: iso(clock - 60_000) }))]))
    expect(engine.wall().incidents[0].nextStep).toBeNull()
  })
})

describe('one alert seen through the webhook and the Zulip poll is one history row', () => {
  // The dev drill: the router posts to Watch and to the alert bridge, so Watch hears the Alertmanager alert twice.
  // Identity already merged the live copies (`dev:daa2e807`, the first 8 hex of the Alertmanager fingerprint).
  // The second row came from the closed Zulip topic: the bridge stamps the episode with the sender's endsAt, the poll that
  // noticed it with its own clock, and the exact-timestamp check on seeding history could not tell them apart.
  const FP = 'daa2e8076667ed9e'
  const LABELS = { alertname: 'WatchWiringTest', job: 'dev', severity: 'warning' }
  const wh = (over: Partial<AlertDraft> = {}): Alert =>
    alert(draft({ source: 'webhook', kind: 'webhook', origin: 'dev', fingerprint: FP, rule: 'WatchWiringTest', labels: LABELS, startsAt: iso(clock - 300_000), ...over }))
  const zl = (over: Partial<AlertDraft> = {}): Alert =>
    alert(draft({ source: 'zulip-alerts', kind: 'zulip', origin: 'dev', fingerprint: FP.slice(0, 8), rule: 'WatchWiringTest', labels: { alertname: 'WatchWiringTest', instance: 'dev', severity: 'warning' }, startsAt: iso(clock - 300_000), ...over }))
  const closed = (endsAt: string): Alert => ({ ...zl(), resolvedAt: endsAt, endsAt })
  const resolvedRows = (): number => (engine.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'resolved' AND alert_key IS NULL").get() as { n: number }).n

  it('records one incident and one history row, though the webhook and the closed topic end it seconds apart', () => {
    engine.ingest(obs('webhook', [wh()], { complete: false }))
    engine.ingest(obs('zulip-alerts', [zl()]))
    expect(engine.wall().incidents).toHaveLength(1)
    expect(engine.wall().incidents[0].alerts).toHaveLength(1)
    clock += 270_000
    const endsAt = iso() // the Alertmanager endsAt, 07:12:31Z in the drill
    engine.ingest(obs('webhook', [], { complete: false, resolved: [{ ...wh(), endsAt }] }))
    expect(engine.wall().incidents).toHaveLength(1) // the Zulip channel still reports it
    clock += 5_500
    engine.ingest(obs('zulip-alerts', [], { resolvedHistory: [closed(endsAt)] })) // the poll that sees the topic closed
    expect(engine.wall().incidents).toHaveLength(0)
    const rows = engine.history(24)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ incidentKey: 'API router|WatchWiringTest', source: 'dev', instances: 1 })
    expect(resolvedRows()).toBe(1)
    // and the next polls, which list the same closed topic again, add nothing
    clock += 15_000
    engine.ingest(obs('zulip-alerts', [], { resolvedHistory: [closed(endsAt)] }))
    expect(engine.history(24)).toHaveLength(1)
  })

  it('does not seed a closed topic while the engine still holds the incident firing (the webhook resolves after the poll)', () => {
    engine.ingest(obs('webhook', [wh()], { complete: false }))
    engine.ingest(obs('zulip-alerts', [zl()]))
    clock += 270_000
    const endsAt = iso()
    engine.ingest(obs('zulip-alerts', [], { resolvedHistory: [closed(endsAt)] })) // the poll gets there first
    expect(engine.wall().incidents).toHaveLength(1) // the webhook still says firing
    clock += 4_000
    engine.ingest(obs('webhook', [], { complete: false, resolved: [{ ...wh(), endsAt }] }))
    expect(engine.wall().incidents).toHaveLength(0)
    expect(engine.history(24)).toHaveLength(1)
    expect(resolvedRows()).toBe(1)
  })

  it('merges a closed topic whose rows carry the chat origin and a labels hash, so no fingerprint can match', () => {
    // ApiTokenizationDivergence in the drill: the rule map puts both copies in one service, but their keys share nothing.
    const map = [...cfg.serviceMap, { match: { rule: '^Api' }, service: 'API router' }]
    const e = new Engine(openDb(':memory:'), { ...cfg, serviceMap: map }, () => clock)
    const live = makeAlert(draft({ source: 'webhook', kind: 'webhook', origin: 'dev', fingerprint: 'c0ffee00c0ffee00', rule: 'ApiTokenizationDivergence', labels: { alertname: 'ApiTokenizationDivergence', severity: 'warning' }, startsAt: iso(clock - 270_000) }), map, iso())
    e.ingest(obs('webhook', [live], { complete: false }))
    clock += 270_000
    const endsAt = iso()
    e.ingest(obs('webhook', [], { complete: false, resolved: [{ ...live, endsAt }] }))
    const orphan = makeAlert(
      draft({ source: 'zulip-alerts', kind: 'zulip', origin: 'zulip-alerts', rule: 'ApiTokenizationDivergence', fingerprint: '', labels: { alertname: 'ApiTokenizationDivergence', instance: 'dev' }, startsAt: iso(clock - 270_000) }),
      map,
      iso()
    )
    expect(orphan.key).not.toBe(live.key)
    const bridgeEnd = iso(clock - 4_000) // the bridge stamped the clear a few seconds before the sender's own endsAt reached us
    e.ingest(obs('zulip-alerts', [], { resolvedHistory: [{ ...orphan, resolvedAt: bridgeEnd, endsAt: bridgeEnd }] }))
    expect(e.history(24)).toHaveLength(1)
    expect(e.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE key LIKE 'zulip-alerts:%'").get()).toEqual({ n: 0 })
  })

  it('still seeds an earlier episode the engine never saw, and one that ended before this one began', () => {
    const earlier = { ...zl({ startsAt: iso(clock - 7200_000), fingerprint: '11223344' }), resolvedAt: iso(clock - 6900_000), endsAt: iso(clock - 6900_000) }
    engine.ingest(obs('webhook', [wh()], { complete: false }))
    engine.ingest(obs('zulip-alerts', [], { resolvedHistory: [earlier] })) // an hour before the live episode started, while it fires
    expect(engine.history(24)).toHaveLength(1)
    expect(engine.history(24)[0].resolvedAt).toBe(earlier.resolvedAt)
    expect(engine.wall().incidents).toHaveLength(1)
  })
})

describe('history seeded while an episode fires', () => {
  it('does not move the start of the live episode to the start of an older one it was seeded beside', () => {
    // ApiTokenizationDivergence in the drill: the live episode began at 06:03, a closed topic of 02:20 was seeded after it fired,
    // and the resolve took the later (seeded) fired event for its own, so a 33 minute episode read as 4 hours.
    const live = alert(draft({ source: 'webhook', kind: 'webhook', origin: 'dev', fingerprint: 'c0ffee00c0ffee00', rule: 'ApiWedge', labels: { alertname: 'ApiWedge', severity: 'warning' }, startsAt: iso(clock - 1800_000) }))
    engine.ingest(obs('webhook', [live], { complete: false }))
    const older = { ...alert(draft({ source: 'zulip-alerts', kind: 'zulip', origin: 'prod', fingerprint: '99887766', rule: 'ApiWedge', labels: { alertname: 'ApiWedge' }, startsAt: iso(clock - 5 * 3600_000) })), resolvedAt: iso(clock - 4.5 * 3600_000) }
    engine.ingest(obs('zulip-alerts', [], { resolvedHistory: [older] }))
    clock += 60_000
    engine.ingest(obs('webhook', [], { complete: false, resolved: [{ ...live, endsAt: iso() }] }))
    const rows = engine.history(24).sort((a, b) => (a.resolvedAt < b.resolvedAt ? -1 : 1))
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ startsAt: live.startsAt, durationSec: 1860, instances: 1 })
  })
})

describe('an incident can be split per instance (the node-2 prober)', () => {
  const split: WatchConfig = { ...cfg, splitIncidents: [{ match: { origin: '^api-uptime$' }, by: 'instance' }] }
  const probe = (target: string, over: Partial<AlertDraft> = {}): Alert =>
    alert(
      draft({
        source: 'webhook',
        kind: 'webhook',
        origin: 'api-uptime',
        fingerprint: `${target.length.toString(16).padStart(2, '0')}fbb3361ea0c76${target.charCodeAt(0).toString(16)}`.slice(0, 16),
        rule: 'ProbeDown',
        labels: { alertname: 'ProbeDown', instance: target, severity: 'page', component: 'uptime' },
        annotations: { summary: `${target} failed its node-2 uptime check` },
        startsAt: iso(clock - 120_000),
        ...over
      })
    )
  const push = (e: Engine, alerts: Alert[], resolved: Alert[] = []): void => e.ingest(obs('webhook', alerts, { complete: false, resolved }))
  let e: Engine
  beforeEach(() => {
    e = new Engine(openDb(':memory:'), split, () => clock)
  })

  it('gives each target its own incident, keyed by it, so every control on one leaves the other alone', () => {
    push(e, [probe('chat.example.com'), probe('watch.example.com')])
    const incidents = e.wall().incidents
    expect(incidents.map((i) => i.key).sort()).toEqual(['Uptime|ProbeDown|chat.example.com', 'Uptime|ProbeDown|watch.example.com'])
    expect(incidents.map((i) => [i.rule, i.instance, i.alerts.length]).sort()).toEqual([
      ['ProbeDown', 'chat.example.com', 1],
      ['ProbeDown', 'watch.example.com', 1]
    ])
    expect(e.silence('Uptime|ProbeDown|chat.example.com', 60, 'the operator')).toBe(true)
    const by = (k: string) => e.wall().incidents.find((i) => i.key === k)!
    expect(by('Uptime|ProbeDown|chat.example.com').state.attention).toBe('silenced')
    expect(by('Uptime|ProbeDown|watch.example.com').state.attention).toBe('none')
    expect(e.ack('Uptime|ProbeDown|watch.example.com', 'the operator')).toBe(true)
    expect(by('Uptime|ProbeDown|chat.example.com').ackedBy).toBeNull()
    // the old shared key is no incident any more: acking it silences nothing
    expect(e.ack('Uptime|ProbeDown', 'the operator')).toBe(false)
    expect(e.silence('Uptime|ProbeDown', 60, 'the operator')).toBe(false)
  })

  it('hands the pager one view per target, so a silenced target drops out of the pager and the other still pages', () => {
    push(e, [probe('chat.example.com'), probe('watch.example.com')])
    e.silence('Uptime|ProbeDown|chat.example.com', 60, 'the operator')
    const views = e.notifyViews().views
    expect(views.map((v) => [v.key, v.attention]).sort()).toEqual([
      ['Uptime|ProbeDown|chat.example.com', 'silenced'],
      ['Uptime|ProbeDown|watch.example.com', 'none']
    ])
    expect(views.find((v) => v.key.endsWith('watch.example.com'))?.summary).toBe('watch.example.com failed its node-2 uptime check')
  })

  it('resolves one target without touching the other, and history names the target', () => {
    push(e, [probe('chat.example.com'), probe('watch.example.com')])
    clock += 60_000
    push(e, [], [{ ...probe('chat.example.com'), endsAt: iso() }])
    expect(e.wall().incidents.map((i) => i.key)).toEqual(['Uptime|ProbeDown|watch.example.com'])
    const rows = e.history(24)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ incidentKey: 'Uptime|ProbeDown|chat.example.com', instance: 'chat.example.com', rule: 'ProbeDown' })
    const resolved = e.notifyViews().resolved
    expect(resolved.map((r) => [r.key, r.summary])).toEqual([['Uptime|ProbeDown|chat.example.com', 'ProbeDown on chat.example.com']])
  })

  it('keeps one incident for the same target seen by two channels, and a re-fire on the same key', () => {
    push(e, [probe('chat.example.com')])
    e.ingest(
      obs('zulip-alerts', [alert(draft({ source: 'zulip-alerts', kind: 'zulip', origin: 'api-uptime', fingerprint: probe('chat.example.com').fingerprint.slice(0, 8), rule: 'ProbeDown', labels: { alertname: 'ProbeDown', instance: 'chat.example.com', severity: 'page' } }))])
    )
    expect(e.wall().incidents).toHaveLength(1)
    expect(e.wall().incidents[0].alerts[0].via.map((v) => v.source).sort()).toEqual(['webhook', 'zulip-alerts'])
  })

  it('leaves every other rule, other origin, and an alert with no such label in its shared incident', () => {
    push(e, [
      probe('chat.example.com', { origin: 'dev', fingerprint: 'abcdabcdabcdabcd' }),
      probe('watch.example.com', { labels: { alertname: 'ProbeDown', severity: 'page', component: 'uptime' }, fingerprint: 'eeeeeeeeeeeeeeee' })
    ])
    expect(e.wall().incidents.map((i) => [i.key, i.instance]).sort()).toEqual([
      ['API router|ProbeDown', null],
      ['Uptime|ProbeDown', null]
    ])
  })

  it('moves an alert stored under the shared key to its own incident when the config starts splitting it', () => {
    const plain = new Engine(e.db, cfg, () => clock)
    push(plain, [probe('chat.example.com'), probe('watch.example.com')])
    expect(plain.wall().incidents.map((i) => i.key)).toEqual(['Uptime|ProbeDown'])
    expect(e.rekey()).toBe(2)
    expect(e.wall().incidents.map((i) => i.key).sort()).toEqual(['Uptime|ProbeDown|chat.example.com', 'Uptime|ProbeDown|watch.example.com'])
    expect(e.rekey()).toBe(0)
  })
})

describe('a resolved class the config excludes leaves no inferred rule cell', () => {
  const excl: WatchConfig = { ...cfg, inferredCellExclude: [{ origin: '^regression-sweep$', rule: '^BugFiled' }] }
  const finding = (rule: string, origin = 'regression-sweep', n = 1): Alert =>
    alert(draft({ source: 'sweep', kind: 'webhook', origin, fingerprint: `${rule.length.toString(16).padStart(2, '0')}${n}0000000000aabb`, rule, labels: { alertname: rule, severity: 'warning' } }))
  const cellNames = (e: Engine, service: string): string[] => (e.wall().health.find((h) => h.service === service)?.cells ?? []).map((c) => c.name)
  const clear = (e: Engine, a: Alert): void => e.ingest({ source: 'sweep', kind: 'webhook', at: iso(), firing: [], resolved: [{ ...a, endsAt: iso() }], complete: false })

  it('keeps the cells of every other finding class on the quiet tile, and drops the excluded one', () => {
    const e = new Engine(openDb(':memory:'), excl, () => clock)
    const bug = finding('BugFiledByPerson')
    const disk = finding('IntakeToolCallFailure')
    e.ingest(obs('sweep', [bug, disk], { kind: 'webhook', complete: false }))
    clock += 60_000
    clear(e, bug)
    clear(e, disk)
    expect(e.wall().incidents).toHaveLength(0)
    expect(cellNames(e, 'Regression sweep')).toEqual(['IntakeToolCallFailure'])
  })

  it('shows the cell without the exclusion, so the test fails when the config entry is missing', () => {
    const e = new Engine(openDb(':memory:'), cfg, () => clock)
    const bug = finding('BugFiledByPerson')
    e.ingest(obs('sweep', [bug], { kind: 'webhook', complete: false }))
    clear(e, bug)
    expect(cellNames(e, 'Regression sweep')).toEqual(['BugFiledByPerson'])
  })

  it('matches the origin too: the same rule name from another origin keeps its cell', () => {
    const e = new Engine(openDb(':memory:'), excl, () => clock)
    const other = finding('BugFiledByPerson', 'dev')
    e.ingest(obs('webhook', [other], { kind: 'webhook', complete: false }))
    e.ingest({ source: 'webhook', kind: 'webhook', at: iso(), firing: [], resolved: [{ ...other, endsAt: iso() }], complete: false })
    expect(cellNames(e, 'API router')).toEqual(['BugFiledByPerson'])
  })
})
