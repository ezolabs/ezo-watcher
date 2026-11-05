// The status object the chat panel shows on its Watch pill (src/shared/summary.ts, GET /api/summary, the embed view's ezo-watcher:status message). It pins the
// original five fields (v, firing, unattended, acknowledged, worst, stale: a chat panel that predates the per-severity counts keeps reading them), the
// two additive count objects (bySeverity and unattendedBySeverity: firing incidents per severity, and the ones nobody has acknowledged or silenced),
// that the counts carry no text, and the route that serves it. The pure function is covered first, the route over a real engine after.
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { makeAlert } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { SqlitePushStore } from '../src/server/stores.ts'
import { incidentState } from '../src/shared/incident.ts'
import { summaryOf } from '../src/shared/summary.ts'
import type { WatchSummary } from '../src/shared/summary.ts'
import type { Attention, Incident, Severity, WallState } from '../src/shared/types.ts'

const NOW = Date.parse('2026-10-16T12:00:00Z')

/** The least of an incident the summary reads: its severity and its state. The rest of the shape is not what is under test. */
function incident(severity: Severity, attention: Attention = 'none', n = 0): Incident {
  const state = incidentState({
    severity,
    instances: 1,
    startsAtMs: NOW - 600_000,
    nowMs: NOW,
    ackedAtMs: attention === 'acked' ? NOW - 60_000 : null,
    silencedUntilMs: attention === 'silenced' ? NOW + 3_600_000 : null
  })
  return { key: `Svc${n}|Rule${n}`, severity, state } as Incident
}

/** A wall of these incidents; the header counts them the way the engine does (every incident on the wall is firing). */
function wall(incidents: Incident[], stale = false): Pick<WallState, 'header' | 'incidents'> {
  return {
    header: {
      rulesWatched: 290,
      firing: incidents.length,
      acknowledged: incidents.filter((i) => i.state.attention === 'acked').length,
      oldestEvaluationAt: null,
      lastIncidentAt: null,
      stale
    },
    incidents
  }
}

const many = (severity: Severity, n: number, attention: Attention = 'none', from = 0): Incident[] => Array.from({ length: n }, (_, k) => incident(severity, attention, from + k))

describe('summaryOf: the original fields', () => {
  it('reads an empty wall as nothing firing', () => {
    expect(summaryOf(wall([]))).toEqual({
      v: 1,
      firing: 0,
      unattended: 0,
      acknowledged: 0,
      parked: 0,
      worst: 'none',
      bySeverity: { page: 0, warning: 0, info: 0 },
      unattendedBySeverity: { page: 0, warning: 0, info: 0 },
      stale: false
    })
  })

  it('keeps firing, unattended, acknowledged, worst and stale as they were', () => {
    const s = summaryOf(wall([incident('page', 'none', 0), ...many('warning', 3, 'none', 1), incident('warning', 'acked', 4)], true))
    expect(s.v).toBe(1)
    expect(s.firing).toBe(5)
    expect(s.unattended).toBe(4)
    expect(s.acknowledged).toBe(1)
    expect(s.worst).toBe('page')
    expect(s.stale).toBe(true)
  })

  it('names the worst severity among the firing ones', () => {
    expect(summaryOf(wall(many('info', 2))).worst).toBe('info')
    expect(summaryOf(wall([...many('info', 2), incident('warning', 'none', 9)])).worst).toBe('warning')
    expect(summaryOf(wall([...many('info', 2), incident('page', 'none', 9)])).worst).toBe('page')
  })
})

describe('summaryOf: the counts per severity', () => {
  it('counts the live wall of 2026-10-16: 1 page, 4 warnings, 0 info, one of them acknowledged', () => {
    const s = summaryOf(wall([incident('page', 'none', 0), ...many('warning', 3, 'none', 1), incident('warning', 'acked', 4)]))
    expect(s.firing).toBe(5)
    expect(s.bySeverity).toEqual({ page: 1, warning: 4, info: 0 })
    expect(s.unattendedBySeverity).toEqual({ page: 1, warning: 3, info: 0 })
  })

  it('counts every severity, with all three keys always present', () => {
    const s = summaryOf(wall([...many('page', 2, 'none', 0), ...many('info', 3, 'none', 2)]))
    expect(s.bySeverity).toEqual({ page: 2, warning: 0, info: 3 })
    expect(s.unattendedBySeverity).toEqual({ page: 2, warning: 0, info: 3 })
    expect(Object.keys(s.bySeverity)).toEqual(['page', 'warning', 'info'])
    expect(Object.keys(s.unattendedBySeverity)).toEqual(['page', 'warning', 'info'])
  })

  it('keeps an acknowledged incident in bySeverity and out of unattendedBySeverity', () => {
    const s = summaryOf(wall([incident('page', 'acked', 0), incident('info', 'acked', 1), incident('warning', 'none', 2)]))
    expect(s.bySeverity).toEqual({ page: 1, warning: 1, info: 1 })
    expect(s.unattendedBySeverity).toEqual({ page: 0, warning: 1, info: 0 })
    expect(s.acknowledged).toBe(2)
  })

  it('keeps a silenced incident in bySeverity and out of unattendedBySeverity, like unattended does', () => {
    const s = summaryOf(wall([incident('warning', 'silenced', 0), incident('warning', 'none', 1)]))
    expect(s.bySeverity.warning).toBe(2)
    expect(s.unattendedBySeverity.warning).toBe(1)
    expect(s.unattended).toBe(1)
    expect(s.acknowledged).toBe(0)
  })

  it('adds up: bySeverity sums to firing and unattendedBySeverity sums to unattended', () => {
    const incidents = [...many('page', 2, 'none', 0), incident('page', 'acked', 2), ...many('warning', 5, 'none', 3), incident('warning', 'silenced', 8), ...many('info', 4, 'acked', 9)]
    const s = summaryOf(wall(incidents))
    const sum = (c: WatchSummary['bySeverity']): number => c.page + c.warning + c.info
    expect(sum(s.bySeverity)).toBe(s.firing)
    expect(sum(s.unattendedBySeverity)).toBe(s.unattended)
    for (const sev of ['page', 'warning', 'info'] as const) expect(s.unattendedBySeverity[sev]).toBeLessThanOrEqual(s.bySeverity[sev])
  })

  it('does not count an incident that is not firing', () => {
    const resting = { ...incident('page', 'none', 0), state: { ...incident('page').state, firing: false } } as Incident
    const s = summaryOf({ header: wall([incident('warning', 'none', 1)]).header, incidents: [resting, incident('warning', 'none', 1)] })
    expect(s.bySeverity).toEqual({ page: 0, warning: 1, info: 0 })
    expect(s.worst).toBe('warning')
  })

  it('gives every call its own count objects, so a caller that edits one cannot change the next', () => {
    const a = summaryOf(wall([incident('page')]))
    a.bySeverity.page = 99
    a.unattendedBySeverity.page = 99
    const b = summaryOf(wall([incident('page')]))
    expect(b.bySeverity.page).toBe(1)
    expect(b.unattendedBySeverity.page).toBe(1)
  })

  it('carries counts and nothing else: no text, host or label in the object', () => {
    const body = JSON.stringify(summaryOf(wall([incident('page', 'none', 0), incident('warning', 'acked', 1)])))
    expect(body).not.toContain('Svc')
    expect(body).not.toContain('Rule')
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(['acknowledged', 'bySeverity', 'firing', 'parked', 'stale', 'unattended', 'unattendedBySeverity', 'v', 'worst'])
  })

  it('is additive: dropping the two new objects and the parked count leaves exactly the shape the chat panel read before them', () => {
    const { bySeverity: _a, unattendedBySeverity: _b, parked: _c, ...before } = summaryOf(wall([incident('page'), incident('warning', 'acked', 1)]))
    expect(before).toEqual({ v: 1, firing: 2, unattended: 1, acknowledged: 1, worst: 'page', stale: false })
  })
})

describe('GET /api/summary', () => {
  const T0 = Date.parse('2026-10-16T12:00:00Z')
  let clock = T0
  const iso = (ms = clock): string => new Date(ms).toISOString()
  const cfg: WatchConfig = {
    baseUrl: 'https://watch.test',
    embedOrigins: ['https://chat.example.com'],
    port: 0,
    host: '127.0.0.1',
    dataDir: ':memory:',
    historyHours: 24,
    staleAfterMisses: 3,
    sources: [{ id: 'grafana', type: 'grafana', url: 'http://g', tokenEnv: 'X', pollSec: 10 }],
    serviceMap: [],
    channels: [],
    routes: [],
    quietHours: null
  }
  let engine: Engine

  // One alert per rule, its severity label as a sender writes it: critical is a page, warn a warning, info stays info.
  const alert = (rule: string, severity: string, n: number) =>
    makeAlert(
      {
        origin: 'grafana',
        // the first eight hex characters are the alert's id, so each differs
        fingerprint: `${n}1b2c3d4e5f60718`,
        rule,
        labels: { alertname: rule, severity, host: 'node-4', service: `Svc${n}` },
        annotations: { summary: `${rule} on node-4`, description: 'a long private description' },
        startsAt: iso(clock - 60_000),
        via: { source: 'grafana', kind: 'grafana', lastSeen: iso() },
        raw: {}
      },
      [],
      iso()
    )

  function app() {
    const deps: AppDeps = {
      engine,
      cfg,
      env: {},
      db: engine.db,
      push: new SqlitePushStore(engine.db),
      ackSecret: ['summary', 'test', '0001'].join('-'),
      webDir: '/nonexistent',
      normalizeWebhook: () => {
        throw new Error('unused')
      },
      testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
      nudge: () => undefined,
      vapidPublicKey: null,
      now: () => clock,
      log: () => undefined
    }
    return createApp(deps)
  }
  const get = async (): Promise<WatchSummary> => (await Promise.resolve(app().request('/api/summary', { headers: { Origin: 'https://chat.example.com' } }))).json() as Promise<WatchSummary>

  beforeEach(() => {
    clock = T0
    engine = new Engine(openDb(':memory:'), cfg, () => clock)
  })

  it('answers zeros for all three severities when nothing fires', async () => {
    const s = await get()
    expect(s.firing).toBe(0)
    expect(s.bySeverity).toEqual({ page: 0, warning: 0, info: 0 })
    expect(s.unattendedBySeverity).toEqual({ page: 0, warning: 0, info: 0 })
  })

  it('counts the live engine by severity and drops an acknowledged incident from the unattended counts', async () => {
    engine.ingest({
      source: 'grafana',
      kind: 'grafana',
      at: iso(),
      firing: [alert('Down', 'critical', 0), alert('DiskFull', 'warning', 1), alert('Slow', 'warn', 2), alert('Hot', 'warning', 3), alert('Heads up', 'info', 4)],
      resolved: [],
      complete: true
    })
    const keys = engine.wall().incidents
    const warning = keys.find((i) => i.severity === 'warning')
    expect(warning).toBeDefined()
    expect(engine.ack((warning as Incident).key, 'the user')).toBe(true)

    const s = await get()
    expect(s.v).toBe(1)
    expect(s.firing).toBe(5)
    expect(s.acknowledged).toBe(1)
    expect(s.unattended).toBe(4)
    expect(s.worst).toBe('page')
    expect(s.bySeverity).toEqual({ page: 1, warning: 3, info: 1 })
    expect(s.unattendedBySeverity).toEqual({ page: 1, warning: 2, info: 1 })
  })

  it('leaves the CORS and cache headers as they were', async () => {
    const res = await Promise.resolve(app().request('/api/summary', { headers: { Origin: 'https://chat.example.com' } }))
    expect(res.headers.get('access-control-allow-origin')).toBe('https://chat.example.com')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('carries no incident text, host or description', async () => {
    engine.ingest({ source: 'grafana', kind: 'grafana', at: iso(), firing: [alert('Down', 'critical', 0)], resolved: [], complete: true })
    const res = await Promise.resolve(app().request('/api/summary'))
    const body = await res.text()
    expect(body).not.toContain('Down')
    expect(body).not.toContain('node-4')
    expect(body).not.toContain('private description')
  })
})
