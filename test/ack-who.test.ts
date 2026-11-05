// Who acknowledged: the name rules, the ack API's `by`, what the engine stores and gives back (the header count, the history row, the resolved
// view).
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { makeAlert } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { buildMessage } from '../src/server/notify/message.ts'
import type { Message } from '../src/server/notify/types.ts'
import { SqlitePushStore } from '../src/server/stores.ts'
import { FALLBACK_NAME, NAME_MAX, NOTIFICATION_NAME, actorName, cleanName, shownName } from '../src/shared/who.ts'

const T0 = Date.parse('2026-10-15T12:00:00Z')
let clock = T0
const iso = (ms = clock): string => new Date(ms).toISOString()
const MAC_KEY = ['ack', 'who', 'test', '0001'].join('-')

const cfg: WatchConfig = {
  baseUrl: 'https://watch.test',
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
let app: ReturnType<typeof createApp>
beforeEach(() => {
  clock = T0
  const db = openDb(':memory:')
  engine = new Engine(db, cfg, () => clock)
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
    now: () => clock
  }
  app = createApp(deps)
})

function alertOf(fingerprint: string, rule: string) {
  return makeAlert(
    { origin: 'grafana', fingerprint, rule, labels: { alertname: rule, severity: 'warning', host: 'node-4' }, annotations: { summary: `${rule} on node-4` }, startsAt: iso(clock - 60_000), via: { source: 'grafana', kind: 'grafana', lastSeen: iso() }, raw: {}, links: {} },
    [],
    iso()
  )
}
// One complete poll carrying every given alert: a complete poll resolves whatever the poll before it fired and this one omits, so alerts that fire together must arrive together.
function fireTogether(alerts: Array<[fingerprint: string, rule: string]>): string[] {
  engine.ingest({ source: 'grafana', kind: 'grafana', at: iso(), firing: alerts.map(([fp, rule]) => alertOf(fp, rule)), resolved: [], complete: true })
  return alerts.map(([, rule]) => engine.wall().incidents.find((i) => i.rule === rule)?.key as string)
}
function fire(fingerprint = 'a1b2c3d4e5f60718', rule = 'DiskFull'): string {
  return fireTogether([[fingerprint, rule]])[0]
}
const resolveAll = (): void => engine.ingest({ source: 'grafana', kind: 'grafana', at: iso(), firing: [], resolved: [], complete: true })
const post = (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) })

describe('the name rules', () => {
  it('cleans a name: control characters out, space folded, cut at the limit on a whole character', () => {
    expect(cleanName('  the user \n\t Chen  ')).toBe('the user Chen')
    expect(cleanName('a\u0000b\u007fc')).toBe('a b c')
    expect(cleanName(42)).toBe('')
    expect(cleanName(null)).toBe('')
    expect([...cleanName('x'.repeat(200))]).toHaveLength(NAME_MAX)
    expect(NAME_MAX).toBe(64)
    const emoji = '\u{1F600}'.repeat(100)
    expect([...cleanName(emoji)]).toHaveLength(NAME_MAX)
  })

  it('reads a header: percent-encoded, a missing or empty one is this browser, and so is the old default wall', () => {
    expect(actorName(encodeURIComponent('Zoë Park'))).toBe('Zoë Park')
    expect(actorName(undefined)).toBe(FALLBACK_NAME)
    expect(actorName('')).toBe(FALLBACK_NAME)
    expect(actorName('wall')).toBe(FALLBACK_NAME)
    expect(actorName('100%')).toBe('100%')
    expect(FALLBACK_NAME).toBe('this browser')
  })

  it('shows a stored actor: the old wall and nobody read as no actor', () => {
    expect(shownName('wall')).toBeNull()
    expect(shownName('the user')).toBe('the user')
    expect(shownName(null)).toBeNull()
    expect(shownName('  ')).toBeNull()
  })
})

describe('the ack API takes the name as `by`', () => {
  it('stores the body by on the ack, the incident and the event', async () => {
    const key = fire()
    const res = await post(`/api/incidents/${encodeURIComponent(key)}/ack`, { body: { by: 'the user' } })
    expect(res.status).toBe(200)
    const inc = engine.wall().incidents[0]
    expect(inc.ackedBy).toBe('the user')
    expect(inc.state.attention).toBe('acked')
    expect(engine.incidentDetail(key).events.find((e) => e.kind === 'ack')?.detail.by).toBe('the user')
  })

  it('keeps the existing path and still takes the x-watch-user header, percent-encoded', async () => {
    const key = fire()
    await post(`/api/incidents/${encodeURIComponent(key)}/ack`, { headers: { 'x-watch-user': encodeURIComponent('Zoë') } })
    expect(engine.wall().incidents[0].ackedBy).toBe('Zoë')
  })

  it('the body wins over the header, and an over-long by is cut to 64 characters', async () => {
    const key = fire()
    await post(`/api/incidents/${encodeURIComponent(key)}/ack`, { body: { by: 'y'.repeat(100) }, headers: { 'x-watch-user': 'the user' } })
    expect(engine.wall().incidents[0].ackedBy).toBe('y'.repeat(64))
    await post(`/api/incidents/${encodeURIComponent(key)}/ack`, { body: { by: 'Dana' }, headers: { 'x-watch-user': 'the user' } })
    expect(engine.wall().incidents[0].ackedBy).toBe('Dana')
  })

  it('a caller that names nobody is this browser, never wall', async () => {
    const key = fire()
    await post(`/api/incidents/${encodeURIComponent(key)}/ack`)
    expect(engine.wall().incidents[0].ackedBy).toBe(FALLBACK_NAME)
    await post(`/api/incidents/${encodeURIComponent(key)}/ack`, { body: { by: 'wall' } })
    expect(engine.wall().incidents[0].ackedBy).toBe(FALLBACK_NAME)
    await post(`/api/incidents/${encodeURIComponent(key)}/ack`, { body: ['not', 'an', 'object'] })
    expect(engine.wall().incidents[0].ackedBy).toBe(FALLBACK_NAME)
  })

  it('names who silenced and who took the acknowledgement off', async () => {
    const key = fire()
    await post(`/api/incidents/${encodeURIComponent(key)}/silence`, { body: { minutes: 60, by: 'Dana' } })
    expect(engine.incidentDetail(key).events.find((e) => e.kind === 'silence')?.detail.by).toBe('Dana')
    await post(`/api/incidents/${encodeURIComponent(key)}/unack`, { body: { by: 'the user' } })
    expect(engine.incidentDetail(key).events.find((e) => e.kind === 'unack')?.detail.by).toBe('the user')
  })

  it('an acknowledge from a notification action says so', async () => {
    const key = fire()
    const { ackSignature } = await import('../src/server/notify/message.ts')
    const res = await app.request(`/api/ack?k=${encodeURIComponent(key)}&s=${ackSignature(MAC_KEY, key)}`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(engine.wall().incidents[0].ackedBy).toBe(NOTIFICATION_NAME)
  })

  it('answers 404 for an incident that is not firing', async () => {
    expect((await post('/api/incidents/nothing%7Chere/ack', { body: { by: 'the user' } })).status).toBe(404)
  })
})

describe('what the engine gives back', () => {
  it('counts the acknowledged incidents in the header, and not a silenced one', async () => {
    const [a, , c] = fireTogether([
      ['a1b2c3d4e5f60718', 'DiskFull'],
      ['b1b2c3d4e5f60718', 'LoadHigh'],
      ['c1b2c3d4e5f60718', 'MemHigh']
    ])
    expect(engine.wall().header).toMatchObject({ firing: 3, acknowledged: 0 })
    engine.ack(a, 'the user')
    expect(engine.wall().header).toMatchObject({ firing: 3, acknowledged: 1 })
    engine.silence(c, 60, 'Dana')
    engine.ack(c, 'Dana')
    expect(engine.wall().header).toMatchObject({ firing: 3, acknowledged: 1 })
  })

  it('a history row of an episode that ended acknowledged names who and when', () => {
    const key = fire()
    clock += 5 * 60_000
    engine.ack(key, 'the user')
    const ackedAt = iso()
    clock += 10 * 60_000
    resolveAll()
    const row = engine.history(24)[0]
    expect(row).toMatchObject({ incidentKey: key, ackedBy: 'the user', ackedAt })
  })

  it('an acknowledgement taken off, or none at all, leaves the row bare, and a later episode does not inherit the earlier ack', () => {
    const key = fire()
    engine.ack(key, 'the user')
    clock += 60_000
    engine.unack(key, 'the user')
    clock += 60_000
    resolveAll()
    expect(engine.history(24)[0].ackedBy).toBeUndefined()
    clock += 3600_000
    fire()
    clock += 60_000
    resolveAll()
    expect(engine.history(24).every((r) => r.ackedBy === undefined)).toBe(true)
    // an ack in the first episode of an incident that fires again is not the second one's
    clock += 3600_000
    const again = fire()
    engine.ack(again, 'Dana')
    clock += 60_000
    resolveAll()
    clock += 3600_000
    fire()
    clock += 60_000
    resolveAll()
    const rows = engine.history(24 * 30)
    expect(rows.filter((r) => r.ackedBy === 'Dana')).toHaveLength(1)
  })

  it('the resolved view carries who had it acknowledged', () => {
    const key = fire()
    engine.ack(key, 'the user')
    clock += 60_000
    resolveAll()
    const { resolved } = engine.notifyViews()
    expect(resolved[0]).toMatchObject({ key, ackedBy: 'the user' })
  })
})

describe('the record line', () => {
  const resolvedMsg = (over: Partial<Message> = {}): Message => ({
    kind: 'resolved',
    title: 'Resolved: DiskFull on node-4',
    body: 'x',
    severity: 'warning',
    tag: 'k|DiskFull',
    url: 'https://watch.test/#/i/k',
    service: 'Host disks',
    rule: 'DiskFull',
    durationSec: 5 * 3600,
    ...over
  })

  it('the resolved message says who had it acknowledged, and when, in the words of its channel', () => {
    const view = { key: 'k|DiskFull', service: 'Host disks', rule: 'DiskFull', summary: 'DiskFull on node-4', severity: 'warning' as const, origin: 'grafana', labels: {}, startsAt: iso(), resolvedAt: iso(T0 + 3600_000), durationSec: 3600, stableForSec: 600, wasNotified: true, ackedBy: 'the user', ackedAt: iso(T0 + 1800_000) }
    const msg = buildMessage({ type: 'resolved', view } as Parameters<typeof buildMessage>[0], { baseUrl: 'https://watch.test', ackSecret: MAC_KEY, nowMs: T0 + 3600_000 })
    expect(msg.body).toContain('Acknowledged by the user at 12:30 UTC.')
    expect(msg).toMatchObject({ ackedBy: 'the user', ackedAt: iso(T0 + 1800_000) })
    const bare = buildMessage({ type: 'resolved', view: { ...view, ackedBy: undefined, ackedAt: undefined } } as Parameters<typeof buildMessage>[0], { baseUrl: 'https://watch.test', ackSecret: MAC_KEY, nowMs: T0 })
    expect(bare.body).not.toContain('Acknowledged')
    expect(bare.ackedBy).toBeUndefined()
  })

})

