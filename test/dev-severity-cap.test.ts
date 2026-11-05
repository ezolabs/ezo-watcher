// Dev is never red: a dev outage caps at warning. The `severityCaps` of the config below hold every alert from a dev environment at warning,
// where the engine takes it in and where it reads a stored one, so the tile, the counts and the pager all see a warning. Prod keeps
// its page, alone or in an incident it shares with a dev alert. The alerts below carry the labels the live senders put on them (read from watch.example.com
// on 2026-11-02): dev's backend `web-2-dev`, the sweep's prober finding with the target as its `service`, the node-2 prober's target as its `instance`.

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { CAPPED_ANNOTATION, capSeverity, makeAlert, severityCapOf } from '../src/server/derive.ts'
import { loadConfig } from '../src/server/config.ts'
import type { SeverityCap, WatchConfig } from '../src/server/config.ts'
import { matchedRoutes } from '../src/server/notify/match.ts'
import { summaryOf } from '../src/shared/summary.ts'
import type { Alert, Observation } from '../src/shared/types.ts'

const CONFIG = fileURLToPath(new URL('../config/watch.example.json', import.meta.url))
/** The parts of a Watcher config this test is about: the route ladder, the dev caps, and the tiles. */
const cfg: WatchConfig = {
  baseUrl: 'https://watch.example.com',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [
    { id: 'grafana', type: 'grafana', url: 'http://g', tokenEnv: 'X', pollSec: 10 },
    { id: 'sweep', type: 'webhook', tokenEnv: 'T' },
    { id: 'webhook', type: 'webhook', tokenEnv: 'T' }
  ],
  serviceMap: [{ match: { origin: '^(?:prod|dev)$' }, service: 'API router' }],
  severityCaps: [
    { match: { origin: '^dev$' }, max: 'warning', note: 'A dev router alert.' },
    { match: { origin: '^sweep$', labels: { host: '.+', service: '(?:^|-)(?:dev|sandbox)(?:-|$)' } }, max: 'warning', note: 'A dev or sandbox target.' },
    { match: { origin: '^sweep$', labels: { namespace: '(?:^|-)(?:dev|sandbox)(?:-|$)' } }, max: 'warning', note: 'A dev or sandbox namespace.' },
    { match: { origin: '^api-uptime$', labels: { instance: '(?:^|-)(?:dev|sandbox)(?:-|$)' } }, max: 'warning', note: 'A dev or sandbox probe.' },
    { match: { origin: '^grafana$', labels: { env: '^dev$' } }, max: 'warning', note: 'A dev environment.' }
  ],
  channels: [
    { id: 'ntfy', type: 'ntfy', server: 'https://ntfy.example', topicEnv: 'TOPIC' },
    { id: 'hook', type: 'webhook', urlEnv: 'HOOK_URL' }
  ],
  routes: [
    { id: 'dev-wall-only', match: { origin: ['dev'] }, receivers: [], mode: 'all', groupWaitSec: 0, groupIntervalSec: 300, repeatIntervalSec: 86400 },
    { id: 'page', match: { severity: ['page'] }, receivers: ['ntfy'], mode: 'all', groupWaitSec: 0, groupIntervalSec: 120, repeatIntervalSec: 1800 },
    { id: 'warning', match: { severity: ['warning'] }, receivers: ['hook'], mode: 'all', groupWaitSec: 60, groupIntervalSec: 300, repeatIntervalSec: 86400 }
  ],
  quietHours: null
}
const NOW = '2026-11-02T23:10:00.000Z'
const clock = Date.parse(NOW)
const PHONE = new Set(['ntfy', 'webpush', 'sms', 'email'])

/** The webhook source a sender pushes to: the sweep has its own, the router receivers and the node-2 prober share `webhook` and name themselves in a header. */
const sourceOf = (origin: string): string => (origin === 'sweep' ? 'sweep' : 'webhook')

let fp = 0
function alertOf(origin: string, rule: string, labels: Record<string, string>, severity = 'page'): Alert {
  fp += 1
  return makeAlert(
    {
      origin,
      fingerprint: `${fp.toString(16).padStart(4, '0')}cafe0123456789ab`,
      rule,
      labels: { alertname: rule, severity, ...labels },
      annotations: { summary: `${rule} on ${Object.values(labels).join(' ')}` },
      startsAt: '2026-11-02T23:04:55.000Z',
      via: { source: sourceOf(origin), kind: 'webhook', lastSeen: NOW },
      raw: {}
    },
    cfg.serviceMap,
    NOW
  )
}

const push = (engine: Engine, alerts: Alert[]): void => {
  const bySource = new Map<string, Alert[]>()
  for (const a of alerts) bySource.set(a.via[0].source, [...(bySource.get(a.via[0].source) ?? []), a])
  for (const [source, firing] of bySource) engine.ingest({ source, kind: 'webhook', at: NOW, firing, resolved: [], complete: false } satisfies Observation)
}

const engineWith = (config: WatchConfig = cfg, db = openDb(':memory:')): Engine => new Engine(db, config, () => clock)

/** Each live alert class, as the engine shows it: the incident's severity and tier, and whether its one alert carries the cap's line. */
function shown(alert: Alert): { service: string; severity: string; tier: string; capped: boolean } {
  const engine = engineWith()
  push(engine, [alert])
  const [incident] = engine.wall().incidents
  return { service: incident.service, severity: incident.severity, tier: incident.state.tier, capped: incident.alerts[0].annotations[CAPPED_ANNOTATION] !== undefined }
}

describe('a dev alert is never a page on the wall', () => {
  it('dev page (ApiWedge on web-2-dev) is a warning tile, and says why', () => {
    expect(shown(alertOf('dev', 'ApiWedge', { backend: 'web-2-dev' }))).toEqual({ service: 'API router', severity: 'warning', tier: 'warning', capped: true })
  })

  it('prod page (ApiWedge on web-2) stays a page', () => {
    expect(shown(alertOf('prod', 'ApiWedge', { backend: 'web-2' }))).toEqual({ service: 'API router', severity: 'page', tier: 'page', capped: false })
  })

  it("the sweep's prober finding for 'Gag core dev cloudflared' is a warning; 'Gag core sandbox cloudflared' too; 'Gag core cloudflared' stays a page", () => {
    const prober = (target: string) => alertOf('sweep', 'ProberTargetDown', { layer: 'probes', sweep_sev: 'P1', sweep_key: `probes/node-2/${target}/down`, probe: 'fleet', service: target, host: 'node-2' })
    expect(shown(prober('gag-core-dev-cloudflared'))).toEqual({ service: 'Gag core dev cloudflared', severity: 'warning', tier: 'warning', capped: true })
    expect(shown(prober('gag-core-sandbox-cloudflared'))).toEqual({ service: 'Gag core sandbox cloudflared', severity: 'warning', tier: 'warning', capped: true })
    expect(shown(prober('gag-core-cloudflared'))).toEqual({ service: 'Gag core cloudflared', severity: 'page', tier: 'page', capped: false })
  })

  it("the node-2 prober's dev targets are warnings and its prod targets still page", () => {
    const probe = (target: string) => alertOf('api-uptime', 'ProbeDown', { instance: target, component: 'uptime' })
    expect(shown(probe('router-dev-healthz')).severity).toBe('warning')
    expect(shown(probe('gag-core-sandbox-postgres')).severity).toBe('warning')
    for (const target of ['router-healthz', 'api-rooms', 'gag-core-postgres', 'watch']) expect(shown(probe(target)).severity, target).toBe('page')
  })

  it('a sweep finding in a dev namespace, or naming a dev env, is a warning; the same finding in prod stays a page', () => {
    const pod = (ns: string, extra: Record<string, string> = {}) => alertOf('sweep', 'PodWaiting', { layer: 'k8s', namespace: ns, service: 'edge', reason: 'CrashLoopBackOff', env: ns, ...extra })
    for (const ns of ['dev', 'box-dev', 'web-dev', 'dev']) expect(shown(pod(ns)).severity, ns).toBe('warning')
    for (const ns of ['prod', 'box-prod', 'prod']) expect(shown(pod(ns)).severity, ns).toBe('page')
    expect(shown(alertOf('grafana', 'API vendor credit: a platform key is refusing', { component: 'vendor-credit', env: 'dev' })).severity).toBe('warning')
    expect(shown(alertOf('grafana', 'API vendor credit: a platform key is refusing', { component: 'vendor-credit', env: 'prod' })).severity).toBe('page')
  })

  it('reads "sandbox" only in a prober target and never a .dev domain as dev: a prod workload and a prod host keep their page', () => {
    // kubernetes-sigs agent-sandbox runs in prod; a production wall may serve a .dev domain, and a scrape target there is prod too
    expect(shown(alertOf('sweep', 'PodWaiting', { layer: 'k8s', namespace: 'box-prod', service: 'agent-sandbox-controller', env: 'box-prod' })).severity).toBe('page')
    expect(shown(alertOf('sweep', 'TlsCertExpiring', { layer: 'probes', service: 'watch.example.com', host: 'watch.example.com' })).severity).toBe('page')
    expect(shown(alertOf('sweep', 'ScrapeTargetDown', { layer: 'router', service: 'sglang', host: 'app.example.dev', env: 'prod' })).severity).toBe('page')
    expect(shown(alertOf('api-uptime', 'ProbeDown', { instance: 'chat.example.com', component: 'uptime' })).severity).toBe('page')
  })

  it('never raises: a dev warning or info stays what it was, and carries no cap line', () => {
    expect(shown(alertOf('dev', 'ApiBackendDraining', { backend: 'web-2-dev' }, 'ticket'))).toMatchObject({ severity: 'warning', capped: false })
    expect(shown(alertOf('dev', 'ApiBackendDraining', { backend: 'web-2-dev' }, 'info'))).toMatchObject({ severity: 'info', capped: false })
  })
})

describe('the counts and the pager see the cap', () => {
  it('a wall of dev pages counts no page, and the pager reaches no phone for them', () => {
    const engine = engineWith()
    push(engine, [
      alertOf('dev', 'ApiWedge', { backend: 'web-2-dev' }),
      alertOf('dev', 'ApiPoolNoHealthyBackend', { pool: 'web-2-dev' }),
      alertOf('sweep', 'ProberTargetDown', { service: 'gag-core-dev-cloudflared', host: 'node-2' }),
      alertOf('api-uptime', 'ProbeDown', { instance: 'router-dev-healthz', component: 'uptime' })
    ])
    const summary = summaryOf(engine.wall())
    expect(summary.bySeverity).toEqual({ page: 0, warning: 4, info: 0 })
    expect(summary.worst).toBe('warning')
    const { views } = engine.notifyViews()
    expect(views).toHaveLength(4)
    for (const v of views) {
      expect(v.severity, v.key).toBe('warning')
      const reach = matchedRoutes(cfg.routes, v).flatMap((r) => [...r.receivers, ...(r.escalate ?? []).flatMap((e) => e.receivers)])
      expect(reach.filter((id) => PHONE.has(id)), v.key).toEqual([])
    }
  })

  it('an incident with a prod alert keeps its page, the pager speaks for the prod alert alone, and it routes as prod', () => {
    // 2026-11-02 23:04:55Z: ApiWedge fired on web-2-dev and web-2 together, one incident; the dev alert sorted first and its origin chose the wall-only route
    const engine = engineWith()
    push(engine, [alertOf('dev', 'ApiWedge', { backend: 'web-2-dev' }), alertOf('prod', 'ApiWedge', { backend: 'web-2' })])
    const [incident] = engine.wall().incidents
    expect(incident.key).toBe('API router|ApiWedge')
    expect(incident.severity).toBe('page')
    expect(incident.alerts.map((a) => [a.origin, a.severity])).toEqual([
      ['prod', 'page'],
      ['dev', 'warning']
    ])
    expect(incident.wallOnly).toBe(false)
    const [view] = engine.notifyViews().views
    expect(view.origin).toBe('prod')
    expect(view.instances.map((x) => x.severity)).toEqual(['page'])
    expect(matchedRoutes(cfg.routes, view)[0].id).toBe('page')
  })

  it('records the capped severity in the history, so a dev episode is a warning there too', () => {
    const engine = engineWith()
    const dev = alertOf('dev', 'ApiBackendFlap', { backend: 'worker-2-dev' })
    push(engine, [dev])
    engine.ingest({ source: 'webhook', kind: 'webhook', at: NOW, firing: [], resolved: [dev], complete: false })
    expect(engine.history(24).find((r) => r.incidentKey === 'API router|ApiBackendFlap')?.severity).toBe('warning')
  })
})

describe('an incident holding dev and prod alerts at one severity routes as prod', () => {
  // Live on 2026-11-02: `API router|ApiBackendDraining` held dev tickets (web-2-dev, web-2-vl-dev) and prod tickets (web-2, web-2-vl), all warnings.
  // The dev ones began draining first, so they lead the tile; the route was matched on the leading alert's origin and `dev-wall-only` took the prod ones.
  const EARLIER = '2026-11-02T22:40:00.000Z'
  const draining = (origin: string, backend: string, startsAt?: string): Alert => {
    const a = alertOf(origin, 'ApiBackendDraining', { backend }, 'ticket')
    return startsAt ? { ...a, startsAt } : a
  }
  const routeOf = (engine: Engine): { wallOnly: boolean; origin: string; route: string; fingerprints: string[] } => {
    const [incident] = engine.wall().incidents
    const [view] = engine.notifyViews().views
    return { wallOnly: incident.wallOnly, origin: view.origin, route: matchedRoutes(cfg.routes, view)[0].id, fingerprints: view.instances.map((x) => x.fingerprint) }
  }

  it('with the dev alerts sorting first on the tile, the wall, the pager and the route all go by the prod alert', () => {
    const dev = [draining('dev', 'web-2-dev', EARLIER), draining('dev', 'web-2-vl-dev', EARLIER)]
    const prod = [draining('prod', 'web-2'), draining('prod', 'web-2-vl')]
    const engine = engineWith()
    push(engine, [...dev, ...prod])
    const [incident] = engine.wall().incidents
    expect(incident.key).toBe('API router|ApiBackendDraining')
    expect(incident.severity).toBe('warning')
    // the tile still shows its instances worst first: the dev ones are older, so they lead it
    expect(incident.alerts.map((a) => a.origin)).toEqual(['dev', 'dev', 'prod', 'prod'])
    expect(incident.alerts.every((a) => a.annotations[CAPPED_ANNOTATION] === undefined)).toBe(true)
    expect(routeOf(engine)).toEqual({ wallOnly: false, origin: 'prod', route: 'warning', fingerprints: [...prod, ...dev].map((a) => a.fingerprint) })
  })

  it('a dev-only incident keeps the dev-wall-only route', () => {
    const engine = engineWith()
    push(engine, [draining('dev', 'web-2-dev', EARLIER), draining('dev', 'web-2-vl-dev')])
    expect(routeOf(engine)).toMatchObject({ wallOnly: true, origin: 'dev', route: 'dev-wall-only' })
  })

  it('a prod-only incident is routed as before', () => {
    const engine = engineWith()
    push(engine, [draining('prod', 'web-2', EARLIER), draining('prod', 'web-2-vl')])
    expect(routeOf(engine)).toMatchObject({ wallOnly: false, origin: 'prod', route: 'warning' })
  })

  it('when a dev alert resolves last, the resolved notice still routes as prod; a dev-only episode resolves as dev', () => {
    const resolve = (engine: Engine, alerts: Alert[]): void => engine.ingest({ source: 'webhook', kind: 'webhook', at: NOW, firing: [], resolved: alerts, complete: false })
    const resolvedRoute = (engine: Engine): { origin: string; route: string } => {
      const [view] = engine.notifyViews().resolved
      return { origin: view.origin, route: matchedRoutes(cfg.routes, view)[0].id }
    }
    const mixed = engineWith()
    const dev = draining('dev', 'web-2-dev', EARLIER)
    const prod = draining('prod', 'web-2')
    push(mixed, [dev, prod])
    resolve(mixed, [prod])
    resolve(mixed, [dev])
    expect(resolvedRoute(mixed)).toEqual({ origin: 'prod', route: 'warning' })

    const devOnly = engineWith()
    const a = draining('dev', 'web-2-dev', EARLIER)
    const b = draining('dev', 'web-2-vl-dev')
    push(devOnly, [a, b])
    resolve(devOnly, [a, b])
    expect(resolvedRoute(devOnly)).toEqual({ origin: 'dev', route: 'dev-wall-only' })
  })
})

describe('a cap holds on rows stored before it, and lets go when it is removed', () => {
  const uncapped: WatchConfig = { ...cfg, severityCaps: undefined }

  it('a dev page stored by a release without the cap is a warning on the first read after the restart', () => {
    const db = openDb(':memory:')
    const before = engineWith(uncapped, db)
    push(before, [alertOf('dev', 'ApiPoolNoHealthyBackend', { pool: 'web-2-dev' })])
    expect(before.wall().incidents[0].severity).toBe('page')
    expect(engineWith(cfg, db).wall().incidents[0].severity).toBe('warning')
  })

  it('a cap taken out of the config puts the alert back at the severity its source sent, without the line', () => {
    const db = openDb(':memory:')
    const dev = alertOf('dev', 'ApiPoolNoHealthyBackend', { pool: 'web-2-dev' })
    push(engineWith(cfg, db), [dev])
    const after = engineWith(uncapped, db)
    const [incident] = after.wall().incidents
    expect(incident.severity).toBe('page')
    expect(incident.alerts[0].annotations[CAPPED_ANNOTATION]).toBeUndefined()
    // and the next push of the same alert, merged with the stored capped row, stays a page
    push(after, [dev])
    expect(after.wall().incidents[0].severity).toBe('page')
  })
})

describe('capSeverity', () => {
  const caps: SeverityCap[] = [
    { match: { labels: { backend: '-dev$' } }, max: 'warning', note: 'A dev backend.' },
    { match: { origin: '^lab$' }, max: 'info', note: 'The lab.' }
  ]
  const a = (origin: string, labels: Record<string, string>, severity = 'critical'): Alert =>
    makeAlert({ origin, fingerprint: 'feedfacefeedface', rule: 'R', labels: { severity, ...labels }, startsAt: NOW, via: { source: 'webhook', kind: 'webhook', lastSeen: NOW }, raw: {} }, [], NOW)

  it('caps at the lowest matching max and writes the line, sent and shown', () => {
    const lab = capSeverity(a('lab', { backend: 'x-dev' }), caps)
    expect(lab.severity).toBe('info')
    expect(lab.annotations[CAPPED_ANNOTATION]).toBe('Sent as page, shown as info: The lab.')
    expect(severityCapOf(a('lab', { backend: 'x-dev' }), caps)?.max).toBe('info')
    expect(capSeverity(a('api', { backend: 'x-dev' }), caps).annotations[CAPPED_ANNOTATION]).toBe('Sent as page, shown as warning: A dev backend.')
  })

  it('is the same alert object when nothing applies, and applying it twice changes nothing', () => {
    const prod = a('api', { backend: 'x' })
    expect(capSeverity(prod, caps)).toBe(prod)
    expect(capSeverity(prod, [])).toBe(prod)
    const once = capSeverity(a('api', { backend: 'x-dev' }), caps)
    expect(capSeverity(once, caps)).toBe(once)
  })

  it('follows a cap that changed its max: the source said page, so a cap now at warning shows warning', () => {
    const atInfo = capSeverity(a('api', { backend: 'x-dev' }), [{ ...caps[0], max: 'info' }])
    expect(atInfo.severity).toBe('info')
    const atWarning = capSeverity(atInfo, caps)
    expect(atWarning.severity).toBe('warning')
    expect(atWarning.annotations[CAPPED_ANNOTATION]).toBe('Sent as page, shown as warning: A dev backend.')
  })

  it('treats a missing label as empty, so a cap on a label never catches an alert without it', () => {
    expect(severityCapOf(a('api', {}), caps)).toBeNull()
  })
})

describe('loadConfig: severityCaps', () => {
  const base = JSON.parse(readFileSync(CONFIG, 'utf8')) as Record<string, unknown>
  const write = (severityCaps: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-caps-'))
    const path = join(dir, 'watch.json')
    writeFileSync(path, JSON.stringify({ ...base, severityCaps }))
    return path
  }
  const loads = (severityCaps: unknown): void => {
    const path = write(severityCaps)
    try {
      loadConfig(path)
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  }
  const ok = { match: { origin: '^dev$' }, max: 'warning', note: 'Dev.' }

  it('takes the live list, an absent one and an empty one', () => {
    expect(cfg.severityCaps?.length).toBeGreaterThan(0)
    expect(() => loads(undefined)).not.toThrow()
    expect(() => loads([])).not.toThrow()
    expect(() => loads([ok])).not.toThrow()
  })

  it('refuses a cap that would cap everything, a bad pattern, a cap at page and a note that is not one line', () => {
    expect(() => loads({})).toThrow('severityCaps must be a list')
    expect(() => loads([{ ...ok, match: {} }])).toThrow('an empty match would cap every alert')
    expect(() => loads([{ ...ok, match: { labels: {} } }])).toThrow('an empty match would cap every alert')
    expect(() => loads([{ ...ok, match: { origin: '' } }])).toThrow('severityCaps[0].match.origin must be a non-empty regular expression')
    expect(() => loads([{ ...ok, match: { labels: { backend: '(' } } }])).toThrow('severityCaps[0].match.labels.backend is not a regular expression')
    expect(() => loads([ok, { ...ok, max: 'page' }])).toThrow('severityCaps[1].max must be warning or info')
    expect(() => loads([{ ...ok, note: 'two\nlines' }])).toThrow('severityCaps[0].note must be one line')
    expect(() => loads([{ ...ok, note: undefined }])).toThrow('severityCaps[0].note must be one line')
  })
})
