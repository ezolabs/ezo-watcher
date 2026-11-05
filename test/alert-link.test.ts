// The per-alert link of the alert bridge's Chat posts: GET /a/<origin>:<fp8>. The id is the alert's own key (its origin and the first
// 8 hex digits of its fingerprint, the pair the bridge journals), so the URL carries no alert text. It redirects to the alert's incident
// on the wall and to the wall for anything it does not know.
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { alertKey, makeAlert } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { SqlitePushStore } from '../src/server/stores.ts'
import type { Alert } from '../src/shared/types.ts'

const T0 = Date.parse('2026-10-15T12:00:00Z')
const iso = (ms = T0): string => new Date(ms).toISOString()

const cfg: WatchConfig = {
  baseUrl: 'https://watch.example',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [{ id: 'webhook', type: 'webhook', tokenEnv: 'X' }],
  serviceMap: [{ match: { rule: '^Api' }, service: 'API router' }],
  channels: [],
  routes: [],
  quietHours: null
}

function boot() {
  const db = openDb(':memory:')
  const engine = new Engine(db, cfg, () => T0)
  const deps: AppDeps = {
    engine,
    cfg,
    env: {},
    db,
    push: new SqlitePushStore(db),
    ackSecret: ['alert', 'link', 'test', '0001'].join('-'),
    webDir: '/nonexistent',
    normalizeWebhook: () => {
      throw new Error('unused')
    },
    testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
    nudge: () => undefined,
    vapidPublicKey: null,
    now: () => T0
  }
  return { app: createApp(deps), engine }
}

function fire(engine: Engine, origin: string, fingerprint: string, rule: string, instance: string): Alert {
  const alert = makeAlert(
    {
      origin,
      fingerprint,
      rule,
      labels: { alertname: rule, severity: 'warning', backend: instance },
      annotations: { summary: 'a summary that must never reach the URL' },
      startsAt: iso(T0 - 60_000),
      via: { source: origin, kind: 'webhook', lastSeen: iso() },
      raw: {}
    },
    cfg.serviceMap,
    iso()
  )
  engine.ingest({ source: origin, kind: 'webhook', at: iso(), firing: [alert], resolved: [], complete: true })
  return alert
}

describe('GET /a/<origin>:<fp8>', () => {
  it('redirects the alert key to the alert incident on the wall, with no alert text in the URL', async () => {
    const { app, engine } = boot()
    const key = fire(engine, 'prod', 'd362b8e8aa55cc01', 'ApiTokenizationDivergence', 'di9').key
    expect(key).toBe(alertKey('prod', 'd362b8e8aa55cc01'))
    expect(key).toBe('prod:d362b8e8')
    const incident = engine.wall().incidents[0].key
    const res = await app.request(`/a/${key}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/#/i/${encodeURIComponent(incident)}`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('location')).not.toMatch(/summary|divergence-text/i)
  })

  it('reads the colon percent-encoded and the fingerprint in capitals, because a chat client may rewrite either', async () => {
    const { app, engine } = boot()
    const key = fire(engine, 'prod', 'd362b8e8aa55cc01', 'ApiTokenizationDivergence', 'di9').key
    const incident = engine.wall().incidents[0].key
    for (const id of ['prod%3Ad362b8e8', 'prod:D362B8E8']) {
      const res = await app.request(`/a/${id}`)
      expect(res.headers.get('location'), id).toBe(`/#/i/${encodeURIComponent(incident)}`)
    }
    expect(key).toBe('prod:d362b8e8')
  })

  it('tells two alerts of different origins and fingerprints apart, and still resolves an alert that has cleared', async () => {
    const { app, engine } = boot()
    const alpha1 = fire(engine, 'prod', 'aaaaaaaa11111111', 'ApiAlpha', 'di1')
    fire(engine, 'grafana', 'bbbbbbbb22222222', 'ApiBeta', 'di2')
    const alpha = await app.request('/a/prod:aaaaaaaa')
    const beta = await app.request('/a/grafana:bbbbbbbb')
    expect(alpha.headers.get('location')).toContain('ApiAlpha')
    expect(beta.headers.get('location')).toContain('ApiBeta')
    engine.ingest({ source: 'prod', kind: 'webhook', at: iso(T0 + 1000), firing: [], resolved: [{ ...alpha1, endsAt: iso(T0 + 1000) }], complete: false })
    expect((await app.request('/a/prod:aaaaaaaa')).headers.get('location')).toContain('ApiAlpha')
  })

  it('sends an unknown id, a wrong origin, a short fingerprint and a malformed id to the wall, never an error page or an echo', async () => {
    const { app, engine } = boot()
    fire(engine, 'prod', 'd362b8e8aa55cc01', 'ApiTokenizationDivergence', 'di9')
    for (const id of ['prod:00000000', 'grafana:d362b8e8', 'prod:d362b8e', 'prod', 'd362b8e8', ':d362b8e8', 'prod:d362b8e8zz', '..%2F..%2Fetc', 'a%00b:d362b8e8']) {
      const res = await app.request(`/a/${id}`)
      expect(res.status, id).toBe(302)
      expect(res.headers.get('location'), id).toBe('/')
    }
  })
})
