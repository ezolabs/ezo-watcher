// GET /api/incident-card/:ref (src/shared/card.ts): the card the chat panel unfurls under a message that links to an incident. It pins the shape (exactly the
// listed fields, nothing from the labels or the annotations), both kinds of ref, the four states, the CORS gate (the same origin list as /api/summary),
// and the 404 for a ref Watch has never heard of. The pure shaper and the drag text are covered at the bottom.
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { makeAlert } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { SqlitePushStore } from '../src/server/stores.ts'
import { CARD_FIELDS, cardOf, dragText, incidentLink } from '../src/shared/card.ts'
import type { IncidentCard } from '../src/shared/card.ts'
import type { Alert, Observation } from '../src/shared/types.ts'

const T0 = Date.parse('2026-10-15T12:00:00Z')
let clock = T0
const iso = (ms = clock): string => new Date(ms).toISOString()

const cfg: WatchConfig = {
  baseUrl: 'https://watch.test',
  embedOrigins: ['https://chat.example.com', 'https://panel.example.com'],
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

// The text a card must never carry: a label value, an annotation, a link and the raw payload all hold one of these.
const SECRET_LABEL = 'label-secret-3f9a'
const SECRET_TEXT = 'annotation-secret-7c21'

const raised = (): Alert =>
  makeAlert(
    {
      origin: 'grafana',
      fingerprint: 'a1b2c3d4e5f60718',
      rule: 'DiskFull',
      labels: { alertname: 'DiskFull', severity: 'warning', host: 'node-4', service: 'Disk', token: SECRET_LABEL },
      annotations: { summary: 'DiskFull on node-4', description: SECRET_TEXT, runbook_url: `https://runbook.example/${SECRET_TEXT}` },
      startsAt: iso(clock - 60_000),
      via: { source: 'grafana', kind: 'grafana', lastSeen: iso() },
      raw: { secret: SECRET_TEXT },
      links: { dashboard: `https://grafana.example/${SECRET_TEXT}` }
    },
    [],
    iso()
  )
const poll = (firing: Alert[]): Observation => ({ source: 'grafana', kind: 'grafana', at: iso(), firing, resolved: [], complete: true })

let engine: Engine
function boot(env: NodeJS.ProcessEnv = {}) {
  const deps: AppDeps = {
    engine,
    cfg,
    env,
    db: engine.db,
    push: new SqlitePushStore(engine.db),
    ackSecret: ['card', 'test', '0001'].join('-'),
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

beforeEach(() => {
  clock = T0
  engine = new Engine(openDb(':memory:'), cfg, () => clock)
})

const fire = (): string => {
  engine.ingest(poll([raised()]))
  return engine.wall().incidents[0].key
}
const ask = (app: ReturnType<typeof boot>, ref: string, origin?: string): Promise<Response> =>
  Promise.resolve(app.request(`/api/incident-card/${encodeURIComponent(ref)}`, origin ? { headers: { Origin: origin } } : {}))
const cardOfRes = async (r: Response): Promise<IncidentCard> => (await r.json()) as IncidentCard

describe('the card of a firing incident', () => {
  it('answers exactly the listed fields, with the wall link', async () => {
    const key = fire()
    const res = await ask(boot(), key)
    expect(res.status).toBe(200)
    const card = await cardOfRes(res)
    expect(Object.keys(card).every((k) => (CARD_FIELDS as readonly string[]).includes(k))).toBe(true)
    expect(card).toEqual({
      v: 1,
      key,
      title: 'DiskFull on node-4',
      severity: 'warning',
      state: 'firing',
      service: 'Disk',
      since: iso(T0 - 60_000),
      url: `https://watch.test/#/i/${encodeURIComponent(key)}`
    })
  })

  it('carries no label value, annotation, link, raw payload or host beyond the title it shows', async () => {
    const key = fire()
    const body = await (await ask(boot(), key)).text()
    expect(body).not.toContain(SECRET_LABEL)
    expect(body).not.toContain(SECRET_TEXT)
    expect(body).not.toContain('runbook')
    expect(body).not.toContain('grafana.example')
    for (const field of ['labels', 'annotations', 'description', 'raw', 'links', 'host', 'value', 'fingerprint']) expect(Object.keys(JSON.parse(body))).not.toContain(field)
  })

  it('answers the same card for an alert id (<origin>:<fp8>), in either case', async () => {
    const key = fire()
    const want = await cardOfRes(await ask(boot(), key))
    expect(await cardOfRes(await ask(boot(), 'grafana:a1b2c3d4'))).toEqual(want)
    expect(await cardOfRes(await ask(boot(), 'grafana:A1B2C3D4'))).toEqual(want)
  })

  it('answers a key that holds a slash, as the wall encodes it in the link', async () => {
    const card = cardOf({ key: 'prod/docs|Docs down', incident: null, alerts: [raised()], resolved: null, baseUrl: 'https://watch.test' })
    expect(card?.url).toBe('https://watch.test/#/i/prod%2Fdocs%7CDocs%20down')
  })
})

describe('the four states', () => {
  it('reads acknowledged with the name that has it', async () => {
    const key = fire()
    engine.ack(key, 'the user')
    const card = await cardOfRes(await ask(boot(), key))
    expect(card.state).toBe('acknowledged')
    expect(card.ackedBy).toBe('the user')
  })

  it('leaves ackedBy out when the acknowledgement names nobody', async () => {
    const key = fire()
    engine.ack(key, 'this browser')
    const card = await cardOfRes(await ask(boot(), key))
    expect(card.state).toBe('acknowledged')
    expect('ackedBy' in card).toBe(false)
  })

  it('reads silenced, with no ackedBy', async () => {
    const key = fire()
    engine.silence(key, 60, 'the user')
    const card = await cardOfRes(await ask(boot(), key))
    expect(card.state).toBe('silenced')
    expect('ackedBy' in card).toBe(false)
  })

  it('reads resolved once the source stops reporting it, and still names it', async () => {
    const key = fire()
    clock += 600_000
    engine.ingest(poll([]))
    expect(engine.wall().incidents).toHaveLength(0)
    const card = await cardOfRes(await ask(boot(), key))
    expect(card.state).toBe('resolved')
    expect(card.title).toBe('DiskFull on node-4')
    expect(card.key).toBe(key)
    expect(card.since).toBe(iso(T0 - 60_000))
    expect(await cardOfRes(await ask(boot(), 'grafana:a1b2c3d4'))).toEqual(card)
  })
})

describe('an unknown ref', () => {
  it('is a 404 with no card, for an incident key and for an alert id alike', async () => {
    fire()
    for (const ref of ['Nobody|Nothing', 'grafana:deadbeef', 'x']) {
      const res = await ask(boot(), ref)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not found' })
    }
  })
})

describe('who may read it', () => {
  const chat = ['https://chat.example.com', 'https://chat.example.com']

  it('answers both configured chat origins, with Vary and no store, and never credentials', async () => {
    const key = fire()
    for (const origin of chat) {
      const res = await ask(boot(), key, origin)
      expect(res.headers.get('access-control-allow-origin')).toBe(origin)
      expect(res.headers.get('vary')).toContain('Origin')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    }
  })

  it('names no origin to any other page, and none to a request without one', async () => {
    const key = fire()
    for (const origin of ['https://evil.example', 'https://chat.example.com.evil.example', 'http://chat.example.com', 'null']) {
      const res = await ask(boot(), key, origin)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
    expect((await ask(boot(), key)).headers.get('access-control-allow-origin')).toBeNull()
  })

  it('adds WATCHER_EMBED_ORIGINS and nothing else', async () => {
    const key = fire()
    const app = boot({ WATCHER_EMBED_ORIGINS: 'http://127.0.0.1:19000, http://localhost:19001' })
    expect((await ask(app, key, 'http://127.0.0.1:19000')).headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:19000')
    expect((await ask(app, key, 'http://localhost:19001')).headers.get('access-control-allow-origin')).toBe('http://localhost:19001')
    expect((await ask(app, key, 'http://127.0.0.1:19002')).headers.get('access-control-allow-origin')).toBeNull()
    expect((await ask(app, key, 'https://chat.example.com')).headers.get('access-control-allow-origin')).toBe('https://chat.example.com')
  })

  it('carries the same headers on a 404, so the page can read the status', async () => {
    const res = await ask(boot(), 'Nobody|Nothing', 'https://chat.example.com')
    expect(res.status).toBe(404)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://chat.example.com')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('matches /api/summary on the origin list, header for header', async () => {
    const app = boot({ WATCHER_EMBED_ORIGINS: 'http://127.0.0.1:19000' })
    const key = fire()
    for (const origin of [...chat, 'http://127.0.0.1:19000', 'https://evil.example', undefined]) {
      const sum = await Promise.resolve(app.request('/api/summary', origin ? { headers: { Origin: origin } } : {}))
      const card = await ask(app, key, origin)
      for (const h of ['access-control-allow-origin', 'vary', 'cache-control']) expect(card.headers.get(h)).toBe(sum.headers.get(h))
    }
  })
})

describe('the pure parts', () => {
  it('cardOf is null for something Watch has no record of', () => {
    expect(cardOf({ key: 'a|b', incident: null, alerts: [], resolved: null, baseUrl: 'https://watch.test' })).toBeNull()
  })

  it('incidentLink trims a trailing slash and encodes the key', () => {
    expect(incidentLink('https://watch.test/', 'Svc|Rule')).toBe('https://watch.test/#/i/Svc%7CRule')
  })

  it('dragText sets the link, and the title with the link after it on one line', () => {
    const d = dragText('Gateway  Envoy failures\n(own 5xx)', 'https://watch.test/#/i/k')
    expect(d.uri).toBe('https://watch.test/#/i/k')
    expect(d.text).toBe('Gateway Envoy failures (own 5xx) https://watch.test/#/i/k')
  })
})
