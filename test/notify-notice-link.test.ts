// The click link on the public ntfy.sh notice. An incident key reads "service|rule|instance", so the usual deep link
// (/#/i/<key>) would put the alert's words on a server we do not run. The notice carries /go/<token> instead: an HMAC of
// the key, which only this server can turn back into the incident.
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { makeAlert } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { buildMessage, noticeToken, noticeUrl, wallUrl } from '../src/server/notify/message.ts'
import type { NotifyView, ResolvedView } from '../src/server/notify/types.ts'
import { SqlitePushStore } from '../src/server/stores.ts'

// Built at run time so no credential-shaped literal sits in the file.
const MAC_KEY = ['notice', 'link', 'test', '0001'].join('-')
const OTHER_MAC_KEY = ['notice', 'link', 'test', '0002'].join('-')
const BASE = 'https://watch.example'
const T0 = Date.parse('2026-10-15T12:00:00Z')
const iso = (ms = T0): string => new Date(ms).toISOString()
const KEY = 'API edge|EdgeDead|web-1'

describe('notice link', () => {
  it('is /go/ plus 32 hex digits, stable per key, different per key and per HMAC key, and says nothing about the key', () => {
    const url = noticeUrl(BASE, MAC_KEY, KEY)
    expect(url).toMatch(/^https:\/\/watch\.example\/go\/[0-9a-f]{32}$/)
    expect(noticeUrl(`${BASE}/`, MAC_KEY, KEY)).toBe(url)
    expect(noticeUrl(BASE, MAC_KEY, 'other|Rule')).not.toBe(url)
    expect(noticeUrl(BASE, OTHER_MAC_KEY, KEY)).not.toBe(url)
    for (const word of ['API', 'edge', 'EdgeDead', 'web-1']) expect(url.toLowerCase()).not.toContain(word.toLowerCase())
    expect(noticeToken(MAC_KEY, KEY)).toBe(url.split('/go/')[1])
  })

  it('rides on firing and resolved messages, and is not the deep link that carries the key', () => {
    const ctx = { baseUrl: BASE, ackSecret: MAC_KEY, nowMs: T0 }
    const view: NotifyView = {
      key: KEY,
      service: 'API edge',
      rule: 'EdgeDead',
      summary: 'API edge dead',
      severity: 'page',
      severityLabel: 'critical',
      origin: 'grafana',
      labels: {},
      instances: [{ fingerprint: 'fp', name: 'web-1', startsAt: iso() }],
      startsAt: iso(),
      firstSeen: iso(),
      attention: 'none',
      unattendedSec: 0,
      flapping: false,
      links: {}
    }
    const firing = buildMessage({ type: 'firing', kind: 'alert', view } as Parameters<typeof buildMessage>[0], ctx)
    expect(firing.noticeUrl).toBe(noticeUrl(BASE, MAC_KEY, KEY))
    expect(firing.url).toBe(wallUrl(BASE, KEY))
    expect(firing.noticeUrl).not.toBe(firing.url)

    const gone: ResolvedView = {
      key: KEY, service: 'API edge', rule: 'EdgeDead', summary: 'API edge dead', severity: 'page', origin: 'grafana', labels: {},
      startsAt: iso(), resolvedAt: iso(T0 + 60_000), durationSec: 60, stableForSec: 600, wasNotified: true
    }
    const resolved = buildMessage({ type: 'resolved', view: gone } as Parameters<typeof buildMessage>[0], ctx)
    expect(resolved.noticeUrl).toBe(noticeUrl(BASE, MAC_KEY, KEY))
  })
})

describe('GET /go/<token>', () => {
  const cfg: WatchConfig = {
    baseUrl: BASE,
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
  function boot() {
    const db = openDb(':memory:')
    const engine = new Engine(db, cfg, () => T0)
    const deps: AppDeps = {
      engine,
      cfg,
      env: {},
      db,
      push: new SqlitePushStore(db),
      ackSecret: MAC_KEY,
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
  function fire(engine: Engine): string {
    const alert = makeAlert(
      {
        origin: 'grafana',
        fingerprint: 'a1b2c3d4e5f60718',
        rule: 'API edge dead',
        labels: { alertname: 'API edge dead', component: 'edge', severity: 'page', instance: 'edge-1:9100' },
        annotations: { summary: 'No http_events for 5 minutes' },
        startsAt: iso(T0 - 60_000),
        via: { source: 'grafana', kind: 'grafana', lastSeen: iso() },
        raw: {}
      },
      cfg.serviceMap,
      iso()
    )
    engine.ingest({ source: 'grafana', kind: 'grafana', at: iso(), firing: [alert], resolved: [], complete: true })
    const incident = engine.wall().incidents[0]
    expect(incident).toBeDefined()
    return incident.key
  }

  it('redirects a token it issued to that incident on the wall', async () => {
    const { app, engine } = boot()
    const key = fire(engine)
    const res = await app.request(`/go/${noticeToken(MAC_KEY, key)}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/#/i/${encodeURIComponent(key)}`)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it("sends a token it does not know, a malformed one or another HMAC key's to the wall, never an error page or an echo", async () => {
    const { app, engine } = boot()
    const key = fire(engine)
    for (const token of [noticeToken(MAC_KEY, 'ghost|Rule'), noticeToken(OTHER_MAC_KEY, key), 'zz', 'not-hex-at-all-not-hex-at-all-0000', '..%2F..%2Fetc']) {
      const res = await app.request(`/go/${token}`)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/')
    }
  })
})
