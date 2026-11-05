// Re-check for a sender that pushes (src/server/push-recheck.ts): the `nextReportAt` a push may carry, the `recheckRequests` config, the requests API a
// sender polls (GET and POST /ingest/<source>/recheck-requests), the entry points that make a request (the wall's POST /api/recheck/:alertKey and the
// MCP `recheck` tool), and the `pushed` list the incident sheet reads. The contract is docs/mcp.md, "Re-check".
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { AppDeps } from '../src/server/app.ts'
import { loadConfig } from '../src/server/config.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { makeAlert } from '../src/server/derive.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { NEXT_REPORT_AHEAD_MS, NEXT_REPORT_PAST_MS, REQUESTS_PER_POLL, REQUEST_TTL_MS, RecheckStore, parseNextReportAt, parseOutcome } from '../src/server/push-recheck.ts'
import { PollRunner, createRechecker } from '../src/server/recheck.ts'
import { normalizeWebhook } from '../src/server/sources/webhook.ts'
import type { PolledSource } from '../src/server/sources/types.ts'
import { SqlitePushStore } from '../src/server/stores.ts'
import { RECHECK_REQUEST_TTL_SEC } from '../src/shared/recheck.ts'
import type { AlertRecheck, PushedSender, RecheckRequest } from '../src/shared/recheck.ts'
import type { Alert, Observation } from '../src/shared/types.ts'

const T0 = Date.parse('2026-10-16T17:00:00Z')
const MIN = 60_000
let clock = T0
const iso = (ms = clock): string => new Date(ms).toISOString()
const TOKEN = ['recheck', 'requests', 'token'].join('-')
const MCP_TOKEN = ['recheck', 'mcp', 'token', '0123456789abcdef0123456789abcdef'].join('-')

const cfg: WatchConfig = {
  baseUrl: 'https://watch.test',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [
    { id: 'grafana', type: 'grafana', url: 'http://g', tokenEnv: 'X', pollSec: 10 },
    { id: 'webhook', type: 'webhook', tokenEnv: 'INGEST_TOKEN' },
    { id: 'sweep', type: 'webhook', tokenEnv: 'INGEST_TOKEN', staleAfterSec: 43200, presenceTtlSec: 86400, recheckRequests: { pickupWithinSec: 90 } }
  ],
  serviceMap: [],
  channels: [],
  routes: [],
  quietHours: null
}

const alertOf = (source: 'grafana' | 'webhook' | 'sweep', fingerprint: string, rule = 'IntakeCiRedMain'): Alert =>
  makeAlert(
    {
      origin: source === 'webhook' ? 'prod' : source,
      fingerprint,
      rule,
      labels: { alertname: rule, severity: 'warning', host: 'api', run: '38915925590' },
      annotations: { summary: `${rule} on api` },
      startsAt: iso(clock - 60 * MIN),
      via: { source, kind: source === 'grafana' ? 'grafana' : 'webhook', lastSeen: iso() },
      raw: {},
      links: {}
    },
    [],
    iso()
  )

const fakeGrafana = (): PolledSource => ({
  id: 'grafana',
  kind: 'grafana',
  name: 'grafana',
  pollSec: 10,
  async poll(): Promise<Observation> {
    return { source: 'grafana', kind: 'grafana', at: iso(), firing: [], resolved: [], complete: false }
  }
})

let engine: Engine
let store: RecheckStore
let app: ReturnType<typeof createApp>

function boot(): void {
  clock = T0
  engine = new Engine(openDb(':memory:'), cfg, () => clock)
  store = new RecheckStore(engine.db, cfg, () => clock)
  const runner = new PollRunner(engine, () => undefined, () => clock)
  const deps: AppDeps = {
    engine,
    cfg,
    env: { INGEST_TOKEN: TOKEN, WATCHER_MCP_TOKEN: MCP_TOKEN },
    db: engine.db,
    push: new SqlitePushStore(engine.db),
    ackSecret: ['recheck', 'requests', 'ack'].join('-'),
    webDir: '/nonexistent',
    normalizeWebhook: (payload, c) => normalizeWebhook(payload, { ...c, deps: { fetch: fetch, env: {}, nowIso: () => iso(), serviceMap: [] } }),
    testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
    nudge: () => undefined,
    recheck: createRechecker({ engine, cfg, runner, sources: [fakeGrafana()], nudge: () => undefined, nowMs: () => clock }),
    vapidPublicKey: null,
    now: () => clock,
    log: () => undefined
  }
  app = createApp(deps)
}
beforeEach(boot)

const auth = (token: string | null = TOKEN): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {})
const json = { 'content-type': 'application/json' }
const push = (body: unknown, source = 'sweep', token: string | null = TOKEN): Promise<Response> =>
  Promise.resolve(app.request(`/ingest/${source}`, { method: 'POST', headers: { ...json, ...auth(token) }, body: JSON.stringify(body) }))
const getRequests = async (source = 'sweep', token: string | null = TOKEN): Promise<Response> => Promise.resolve(app.request(`/ingest/${source}/recheck-requests`, { headers: auth(token) }))
const listOf = async (source = 'sweep'): Promise<RecheckRequest[]> => ((await (await getRequests(source)).json()) as { requests: RecheckRequest[] }).requests
const answer = (id: string, body: unknown, source = 'sweep', token: string | null = TOKEN): Promise<Response> =>
  Promise.resolve(app.request(`/ingest/${source}/recheck-requests/${id}`, { method: 'POST', headers: { ...json, ...auth(token) }, body: typeof body === 'string' ? body : JSON.stringify(body) }))
const wallPress = async (key: string, headers: Record<string, string> = {}): Promise<AlertRecheck> => (await (await app.request(`/api/recheck/${encodeURIComponent(key)}`, { method: 'POST', headers })).json()) as AlertRecheck

/** A firing alert of the sweep, ingested the way the engine receives one. */
function sweepAlert(fp = 'f1f2f3f4f5f60718', rule = 'IntakeCiRedMain'): Alert {
  const a = alertOf('sweep', fp, rule)
  engine.ingest({ source: 'sweep', kind: 'webhook', at: iso(), firing: [a], resolved: [], complete: false })
  return a
}
const rows = (): number => (engine.db.prepare('SELECT COUNT(*) AS n FROM recheck_requests').get() as { n: number }).n

// ---- the config ----------------------------------------------------------------------------------------

describe('recheckRequests in the config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-recheck-config-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  let n = 0
  const load = (source: Record<string, unknown>): WatchConfig => {
    const path = join(dir, `c${(n += 1)}.json`)
    writeFileSync(path, JSON.stringify({ baseUrl: 'https://x.test', port: 1, host: '127.0.0.1', dataDir: 'd', sources: [source], serviceMap: [], channels: [], routes: [], quietHours: null, historyHours: 24, staleAfterMisses: 3 }))
    return loadConfig(path)
  }
  const hook = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'sweep', type: 'webhook', tokenEnv: 'T', ...over })

  it('takes a whole number of seconds from 30 to 3600 on a webhook source, and is optional', () => {
    for (const sec of [30, 90, 3600]) {
      const s = load(hook({ recheckRequests: { pickupWithinSec: sec } })).sources[0]
      expect(s.type === 'webhook' ? s.recheckRequests : null).toEqual({ pickupWithinSec: sec })
    }
    const none = load(hook()).sources[0]
    expect(none.type === 'webhook' ? none.recheckRequests : 'x').toBeUndefined()
  })

  it('refuses what is not in range, not a whole number, not a number, or not an object, naming the source', () => {
    for (const bad of [29, 3601, 90.5, '90', null, 0, -90, Number.NaN]) {
      expect(() => load(hook({ recheckRequests: { pickupWithinSec: bad } }))).toThrow(/source sweep: recheckRequests\.pickupWithinSec must be a whole number of seconds from 30 to 3600/)
    }
    expect(() => load(hook({ recheckRequests: {} }))).toThrow(/pickupWithinSec/)
    expect(() => load(hook({ recheckRequests: [] }))).toThrow(/must be an object/)
    expect(() => load(hook({ recheckRequests: 90 }))).toThrow(/must be an object/)
  })

  it('is for a webhook source only', () => {
    expect(() => load({ id: 'env-collector', type: 'collector', tokenEnv: 'T', recheckRequests: { pickupWithinSec: 90 } })).toThrow(/only for a webhook source/)
  })

  it('asks the sweep to pick requests up within 90 s', () => {
    const s = loadConfig(fileURLToPath(new URL('./fixtures/watch.config.json', import.meta.url))).sources.find((x) => x.id === 'sweep')
    expect(s?.type === 'webhook' ? s.recheckRequests : null).toEqual({ pickupWithinSec: 90 })
  })
})

// ---- nextReportAt --------------------------------------------------------------------------------------

describe('nextReportAt on a push', () => {
  const at = (offsetMs: number): string => iso(clock + offsetMs)

  it('is stored per source, the latest push winning, and is in the pushed sender the sheet reads', async () => {
    const a = sweepAlert()
    const first = push({ version: '4', groupKey: 'g', alerts: [], nextReportAt: at(4 * 60 * MIN) })
    expect((await first).status).toBe(200)
    expect(store.nextReportAt('sweep')).toBe(at(4 * 60 * MIN))
    expect(store.nextReportAt('webhook')).toBeNull()
    clock += 30 * MIN
    await push({ version: '4', groupKey: 'g', alerts: [], nextReportAt: at(9 * 60 * MIN) })
    expect(store.nextReportAt('sweep')).toBe(at(9 * 60 * MIN))
    const detail = (await (await app.request(`/api/incidents/${encodeURIComponent(engine.wall().incidents[0].key)}`)).json()) as { alerts: Array<{ key: string; pushed: PushedSender[] }> }
    expect(detail.alerts.find((x) => x.key === a.key)?.pushed[0].nextReportAt).toBe(at(9 * 60 * MIN))
  })

  it('carries any ISO form and is stored as ISO UTC', async () => {
    await push({ version: '4', groupKey: 'g', alerts: [], nextReportAt: '2026-10-16T12:07:00-06:00' })
    expect(store.nextReportAt('sweep')).toBe('2026-10-16T18:07:00.000Z')
  })

  it('is ignored, with the rest of the push still ingested, when it is not a date, not text, earlier than 5 min ago or later than 7 d ahead', async () => {
    const ignored = ['soon', '', '16:07', '1', 12345, null, { at: 'x' }, ['2026-10-16T20:00:00Z'], at(-NEXT_REPORT_PAST_MS - MIN), at(NEXT_REPORT_AHEAD_MS + MIN), '2026-13-45T25:61:00Z']
    for (const bad of ignored) {
      const a = alertOf('sweep', 'a1a2a3a4a5a60718')
      const body = { version: '4', groupKey: 'g', alerts: [{ status: 'firing', labels: { alertname: 'IntakeCiRedMain', severity: 'warning' }, annotations: {}, startsAt: iso(), fingerprint: a.fingerprint }], nextReportAt: bad }
      const r = await push(body)
      expect(r.status, JSON.stringify(bad)).toBe(200)
      expect(((await r.json()) as { firing: number }).firing).toBe(1)
      expect(store.nextReportAt('sweep'), JSON.stringify(bad)).toBeNull()
    }
    expect(engine.wall().incidents).toHaveLength(1)
  })

  it('keeps what was stored when a push brings none, or one that is ignored', async () => {
    await push({ version: '4', groupKey: 'g', alerts: [], nextReportAt: at(4 * 60 * MIN) })
    await push({ version: '4', groupKey: 'g', alerts: [] })
    expect(store.nextReportAt('sweep')).toBe(at(4 * 60 * MIN))
    await push({ version: '4', groupKey: 'g', alerts: [], nextReportAt: 'garbage' })
    expect(store.nextReportAt('sweep')).toBe(at(4 * 60 * MIN))
    await push({ version: '4', groupKey: 'g', alerts: [], nextReportAt: at(NEXT_REPORT_AHEAD_MS + 60 * MIN) })
    expect(store.nextReportAt('sweep')).toBe(at(4 * 60 * MIN))
  })

  it('accepts the edges of the window: 5 min ago and 7 d ahead', () => {
    expect(parseNextReportAt(at(-NEXT_REPORT_PAST_MS), clock)).toBe(at(-NEXT_REPORT_PAST_MS))
    expect(parseNextReportAt(at(NEXT_REPORT_AHEAD_MS), clock)).toBe(at(NEXT_REPORT_AHEAD_MS))
    expect(parseNextReportAt(at(-NEXT_REPORT_PAST_MS - 1000), clock)).toBeNull()
    expect(parseNextReportAt(at(NEXT_REPORT_AHEAD_MS + 1000), clock)).toBeNull()
  })

  it('is not stored from a push that is refused', async () => {
    const bad = await push({ nextReportAt: at(60 * MIN) })
    expect(bad.status).toBe(400)
    expect(store.nextReportAt('sweep')).toBeNull()
    expect((await push({ version: '4', groupKey: 'g', alerts: [], nextReportAt: at(60 * MIN) }, 'sweep', 'wrong')).status).toBe(401)
    expect(store.nextReportAt('sweep')).toBeNull()
  })
})

// ---- the requests API ----------------------------------------------------------------------------------

describe('GET /ingest/<source>/recheck-requests', () => {
  it('is 401 for a bad or missing token, and 404 for an unknown source or one without recheckRequests', async () => {
    sweepAlert()
    expect((await getRequests('sweep', 'wrong')).status).toBe(401)
    expect((await getRequests('sweep', null)).status).toBe(401)
    const none = await getRequests('webhook')
    expect(none.status).toBe(404)
    expect(((await none.json()) as { error: string }).error).toBeTruthy()
    const unknown = await getRequests('nope')
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: string }).error).toBeTruthy()
    // the token is checked before the answer says anything about the config
    expect((await getRequests('webhook', 'wrong')).status).toBe(401)
  })

  it('answers an empty list when nothing was asked', async () => {
    const r = await getRequests()
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.json()).toEqual({ requests: [] })
  })

  it('lists the open requests with the alert they are about, claims one on the first read and keeps returning it until it is closed', async () => {
    const a = sweepAlert()
    const asked = await wallPress(a.key)
    const requestId = asked.pushed[0].request?.id as string
    expect(requestId).toMatch(/^rr_/)
    const [first] = await listOf()
    expect(first).toEqual({
      id: requestId,
      alertKey: a.key,
      fingerprint: a.fingerprint,
      alertname: 'IntakeCiRedMain',
      labels: a.labels,
      requestedAt: iso(T0),
      requestedBy: 'wall',
      via: 'wall',
      claimedAt: iso(T0)
    })
    clock += 20_000
    const [again] = await listOf()
    expect(again.id).toBe(requestId)
    // claimed on the first read only: a crashed poller that reads it again does not move the time
    expect(again.claimedAt).toBe(iso(T0))
    expect(await listOf()).toHaveLength(1)
  })

  it('lists oldest first, at most 20', async () => {
    const keys: string[] = []
    for (let k = 0; k < REQUESTS_PER_POLL + 5; k += 1) {
      clock += 1000
      const a = sweepAlert(`${(k + 16).toString(16).padStart(2, '0')}${'ab'.repeat(7)}`, `Rule${k}`)
      keys.push(a.key)
      await wallPress(a.key)
    }
    const list = await listOf()
    expect(list).toHaveLength(REQUESTS_PER_POLL)
    expect(list.map((r) => r.alertKey)).toEqual(keys.slice(0, REQUESTS_PER_POLL))
    for (let k = 1; k < list.length; k += 1) expect(list[k].requestedAt > list[k - 1].requestedAt).toBe(true)
  })

  it('does not hand one source the requests of another', async () => {
    const a = alertOf('webhook', 'c1c2c3c4c5c60718')
    engine.ingest({ source: 'webhook', kind: 'webhook', at: iso(), firing: [a], resolved: [], complete: false })
    await wallPress(a.key)
    expect(rows()).toBe(0)
    expect(await listOf()).toEqual([])
  })
})

describe('POST /ingest/<source>/recheck-requests/<id>', () => {
  async function asked(fp = 'f1f2f3f4f5f60718'): Promise<{ id: string; key: string }> {
    const a = sweepAlert(fp)
    const r = await wallPress(a.key)
    await listOf()
    return { id: r.pushed[0].request?.id as string, key: a.key }
  }
  const request = (key: string): PushedSender['request'] => (engine.alertPresence(key) ? store.latest('sweep', key) : null)

  it.each(['ran', 'failed', 'unsupported'] as const)('%s closes the request: 204, gone from the next read, doneAt = now', async (outcome) => {
    const { id, key } = await asked()
    clock += 40_000
    const r = await answer(id, { outcome, note: '  it said so  ' })
    expect(r.status).toBe(204)
    expect(await r.text()).toBe('')
    expect(await listOf()).toEqual([])
    expect(request(key)).toMatchObject({ id, outcome, note: 'it said so', doneAt: iso(T0 + 40_000), expired: false })
  })

  it('dispatched keeps it open, with the outcome and the note, and it is still returned; a later ran closes it', async () => {
    const { id, key } = await asked()
    clock += 60_000
    expect((await answer(id, { outcome: 'dispatched', note: 'CI run 38915925999' })).status).toBe(204)
    expect(request(key)).toMatchObject({ id, outcome: 'dispatched', note: 'CI run 38915925999', doneAt: null, expired: false })
    expect((await listOf()).map((r) => r.id)).toEqual([id])
    clock += 5 * MIN
    expect((await answer(id, { outcome: 'ran' })).status).toBe(204)
    expect(await listOf()).toEqual([])
    expect(request(key)).toMatchObject({ outcome: 'ran', note: null, doneAt: iso(T0 + 6 * MIN) })
  })

  it('takes a note trimmed and cut to 300 characters, and none as no note', async () => {
    const { id, key } = await asked()
    await answer(id, { outcome: 'failed', note: ` ${'x'.repeat(400)} ` })
    expect(request(key)?.note).toBe('x'.repeat(300))
    expect(parseOutcome({ outcome: 'ran', note: '   ' })).toEqual({ outcome: 'ran', note: null })
    expect(parseOutcome({ outcome: 'ran', note: null })).toEqual({ outcome: 'ran', note: null })
    expect(parseOutcome({ outcome: 'ran' })).toEqual({ outcome: 'ran', note: null })
  })

  it('is 400 for a body that is not an outcome and leaves the request open', async () => {
    const { id } = await asked()
    for (const bad of ['not json', '', '[]', 'null', '"ran"', { outcome: 'done' }, { note: 'x' }, { outcome: 'ran', note: 5 }, { outcome: 'ran', note: ['x'] }, { outcome: 7 }]) {
      const r = await answer(id, bad)
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect(((await r.json()) as { error: string }).error).toBe('bad body')
    }
    expect(await listOf()).toHaveLength(1)
  })

  it('is 404 for an unknown id, 401 for a bad token and 404 for a source without recheckRequests', async () => {
    const { id } = await asked()
    expect((await answer('rr_nope', { outcome: 'ran' })).status).toBe(404)
    expect((await answer(id, { outcome: 'ran' }, 'sweep', 'wrong')).status).toBe(401)
    expect((await answer(id, { outcome: 'ran' }, 'sweep', null)).status).toBe(401)
    expect((await answer(id, { outcome: 'ran' }, 'webhook')).status).toBe(404)
    expect(await listOf()).toHaveLength(1)
  })

  it('answers a retry after a closed request with 204 and changes nothing', async () => {
    const { id, key } = await asked()
    await answer(id, { outcome: 'failed', note: 'first' })
    clock += MIN
    expect((await answer(id, { outcome: 'ran', note: 'second' })).status).toBe(204)
    expect(request(key)).toMatchObject({ outcome: 'failed', note: 'first', doneAt: iso(T0) })
  })

  it('is not answered by the push route: a path with the id is the requests API, a path of one segment is still a push', async () => {
    const { id } = await asked()
    expect((await answer(id, { outcome: 'ran' })).status).toBe(204)
    expect((await push({ version: '4', groupKey: 'g', alerts: [] })).status).toBe(200)
    expect((await app.request('/ingest/sweep/other', { headers: auth() })).status).toBe(404)
  })
})

describe('the 30 min expiry of an open request', () => {
  it('is returned until 30 min after it was made, then not, and the sheet reads it as expired', async () => {
    const a = sweepAlert()
    const id = ((await wallPress(a.key)).pushed[0].request?.id as string) ?? ''
    expect(REQUEST_TTL_MS).toBe(RECHECK_REQUEST_TTL_SEC * 1000)
    clock = T0 + REQUEST_TTL_MS - 1
    expect(await listOf()).toHaveLength(1)
    expect(store.latest('sweep', a.key)).toMatchObject({ id, expired: false, doneAt: null })
    clock = T0 + REQUEST_TTL_MS
    expect(await listOf()).toEqual([])
    expect(store.latest('sweep', a.key)).toMatchObject({ id, expired: true, doneAt: null, outcome: null })
  })

  it('a press after it expired asks again, and a late answer to the expired one is still taken', async () => {
    const a = sweepAlert()
    const first = (await wallPress(a.key)).pushed[0].request?.id as string
    clock = T0 + 31 * MIN
    sweepAlert()
    const second = (await wallPress(a.key)).pushed[0].request?.id as string
    expect(second).not.toBe(first)
    expect(rows()).toBe(2)
    expect((await listOf()).map((r) => r.id)).toEqual([second])
    expect((await answer(first, { outcome: 'ran' })).status).toBe(204)
    // the latest request for the alert is still the second one
    expect(store.latest('sweep', a.key)?.id).toBe(second)
  })

  it('a dispatched request is open until it expires, like any other', async () => {
    const a = sweepAlert()
    const id = (await wallPress(a.key)).pushed[0].request?.id as string
    await answer(id, { outcome: 'dispatched', note: 'CI run' })
    clock = T0 + REQUEST_TTL_MS
    expect(await listOf()).toEqual([])
    expect(store.latest('sweep', a.key)).toMatchObject({ outcome: 'dispatched', expired: true })
  })

  it('a closed or expired request is the alert\'s latest for 24 h, then none', async () => {
    const a = sweepAlert()
    const id = (await wallPress(a.key)).pushed[0].request?.id as string
    await answer(id, { outcome: 'ran' })
    clock = T0 + 23 * 60 * MIN
    expect(store.latest('sweep', a.key)?.id).toBe(id)
    clock = T0 + 25 * 60 * MIN
    expect(store.latest('sweep', a.key)).toMatchObject({ id: null, pickupWithinSec: 90, outcome: null })
  })
})

// ---- the entry points ----------------------------------------------------------------------------------

describe('Re-check on an alert of a pushing sender', () => {
  it('the wall asks for a firing alert: via wall, by "wall" when nobody is named, by the name the wall sends otherwise', async () => {
    const a = sweepAlert()
    const r = await wallPress(a.key)
    expect(r.after).toBe('firing')
    expect(r.sources).toEqual([])
    expect(r.pushed).toHaveLength(1)
    expect(r.pushed[0]).toMatchObject({
      source: 'sweep',
      sender: 'sweep',
      lastReportedAt: iso(T0),
      atLeastEverySec: 43200,
      clearsAfterSec: 86400,
      nextReportAt: null,
      clearsAt: iso(T0 + 86400_000),
      request: { pickupWithinSec: 90, requestedAt: iso(T0), claimedAt: null, doneAt: null, expired: false, outcome: null, note: null }
    })
    const [req] = await listOf()
    expect(req).toMatchObject({ requestedBy: 'wall', via: 'wall' })

    const b = sweepAlert('b1b2b3b4b5b60718', 'Other')
    await wallPress(b.key, { 'x-watch-user': encodeURIComponent('the user K') })
    const named = (await listOf()).find((x) => x.alertKey === b.key)
    expect(named).toMatchObject({ requestedBy: 'the user K', via: 'wall' })
  })

  it('an alert that already has an open request reuses it, and a second press asks nobody twice', async () => {
    const a = sweepAlert()
    const one = (await wallPress(a.key)).pushed[0].request
    clock += 10_000
    const two = (await wallPress(a.key)).pushed[0].request
    expect(two?.id).toBe(one?.id)
    expect(two?.requestedAt).toBe(one?.requestedAt)
    expect(rows()).toBe(1)
    // a request already picked up and waiting on something is still the one open request
    await listOf()
    await answer(one?.id as string, { outcome: 'dispatched', note: 'CI run' })
    expect((await wallPress(a.key)).pushed[0].request).toMatchObject({ id: one?.id, outcome: 'dispatched', note: 'CI run' })
    expect(rows()).toBe(1)
    // once it is closed, the next press is a new request
    await answer(one?.id as string, { outcome: 'ran' })
    const three = (await wallPress(a.key)).pushed[0].request
    expect(three?.id).not.toBe(one?.id)
    expect(rows()).toBe(2)
  })

  it('a resolved alert gets none, and its answer says no request is open', async () => {
    const a = sweepAlert()
    engine.ingest({ source: 'sweep', kind: 'webhook', at: iso(), firing: [], resolved: [{ ...a, endsAt: iso() }], complete: false })
    const r = await wallPress(a.key)
    expect(r.after).toBe('resolved')
    expect(rows()).toBe(0)
    expect(r.pushed[0].request).toMatchObject({ id: null, pickupWithinSec: 90 })
  })

  it('a source without recheckRequests gets none and says so (request null); a polled source is polled as before and asks no one', async () => {
    const w = alertOf('webhook', 'c1c2c3c4c5c60718')
    engine.ingest({ source: 'webhook', kind: 'webhook', at: iso(), firing: [w], resolved: [], complete: false })
    const r = await wallPress(w.key)
    expect(r.pushed[0]).toMatchObject({ source: 'webhook', sender: 'prod through webhook', request: null, nextReportAt: null, atLeastEverySec: null })
    const g = alertOf('grafana', 'd1d2d3d4d5d60718')
    engine.ingest({ source: 'grafana', kind: 'grafana', at: iso(), firing: [g], resolved: [], complete: true })
    const polled = await wallPress(g.key)
    expect(polled.sources.map((s) => s.id)).toEqual(['grafana'])
    expect(polled.pushed).toEqual([])
    expect(rows()).toBe(0)
  })

  it('an alert both a poll and the sweep report is polled and also asked of the sweep', async () => {
    const a = alertOf('grafana', 'e1e2e3e4e5e60718')
    engine.ingest({ source: 'grafana', kind: 'grafana', at: iso(), firing: [a], resolved: [], complete: true })
    engine.ingest({ source: 'sweep', kind: 'webhook', at: iso(), firing: [{ ...a, via: [{ source: 'sweep', kind: 'webhook', lastSeen: iso() }] }], resolved: [], complete: false })
    const r = await wallPress(a.key)
    expect(r.sources.map((s) => s.id)).toEqual(['grafana'])
    expect(r.pushed.map((p) => p.source)).toEqual(['sweep'])
    expect(r.pushed[0].request?.id).toMatch(/^rr_/)
  })

  it('the wall-wide re-check asks no sender and names the ones that take requests', async () => {
    sweepAlert()
    const r = (await (await app.request('/api/recheck', { method: 'POST' })).json()) as { pushed: string[]; requestable: string[] }
    expect(r.pushed).toEqual(['webhook', 'sweep'])
    expect(r.requestable).toEqual(['sweep'])
    expect(rows()).toBe(0)
  })

  describe('the MCP recheck tool', () => {
    let rpcId = 0
    async function recheck(args: Record<string, unknown>): Promise<{ alerts: AlertRecheck[]; by: string }> {
      const r = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${MCP_TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method: 'tools/call', params: { name: 'recheck', arguments: args } })
      })
      const body = (await r.json()) as { result?: { isError?: boolean; content: Array<{ text: string }> } }
      expect(body.result?.isError, JSON.stringify(body)).not.toBe(true)
      return JSON.parse(body.result?.content[0].text ?? '{}') as { alerts: AlertRecheck[]; by: string }
    }

    it('asks via mcp, by the caller, for one alert and for every firing alert of an incident', async () => {
      const a = sweepAlert('a1a2a3a4a5a60718')
      const b = sweepAlert('b1b2b3b4b5b60718')
      const one = await recheck({ by: 'agent: claude in ezo-watcher', alert: a.key })
      expect(one.alerts[0].pushed[0].request?.id).toMatch(/^rr_/)
      const incident = engine.wall().incidents[0].key
      const all = await recheck({ by: 'agent: claude in ezo-watcher', incident })
      expect(all.alerts.map((x) => x.key).sort()).toEqual([a.key, b.key].sort())
      const list = await listOf()
      expect(list).toHaveLength(2)
      for (const r of list) expect(r).toMatchObject({ via: 'mcp', requestedBy: 'agent: claude in ezo-watcher' })
      // the alert that already had one reuses it
      expect(all.alerts.find((x) => x.key === a.key)?.pushed[0].request?.id).toBe(one.alerts[0].pushed[0].request?.id)
      expect(rows()).toBe(2)
    })

    it('reuses a request the wall opened, so who asked first stays on it', async () => {
      const a = sweepAlert()
      await wallPress(a.key)
      await recheck({ by: 'agent: claude in ezo-watcher', alert: a.key })
      expect(rows()).toBe(1)
      expect((await listOf())[0]).toMatchObject({ via: 'wall', requestedBy: 'wall' })
    })

    it('asks for no resolved alert', async () => {
      const a = sweepAlert()
      engine.ingest({ source: 'sweep', kind: 'webhook', at: iso(), firing: [], resolved: [{ ...a, endsAt: iso() }], complete: false })
      const r = await recheck({ by: 'agent: claude in ezo-watcher', alert: a.key })
      expect(r.alerts[0].after).toBe('resolved')
      expect(rows()).toBe(0)
    })
  })
})

// ---- what the incident sheet reads --------------------------------------------------------------------

describe('GET /api/incidents/<key>: pushed', () => {
  type Detail = { alerts: Array<Alert & { pushed: PushedSender[] }> }
  const detail = async (key: string): Promise<Detail> => (await (await app.request(`/api/incidents/${encodeURIComponent(key)}`)).json()) as Detail

  it('is on every alert, readable without a press: the sender, its schedule and no request yet', async () => {
    const a = sweepAlert()
    await push({ version: '4', groupKey: 'g', alerts: [], nextReportAt: iso(T0 + 4 * 60 * MIN) })
    const d = await detail(engine.wall().incidents[0].key)
    const alert = d.alerts.find((x) => x.key === a.key)
    expect(alert?.pushed).toEqual([
      {
        source: 'sweep',
        sender: 'sweep',
        lastReportedAt: iso(T0),
        atLeastEverySec: 43200,
        clearsAfterSec: 86400,
        nextReportAt: iso(T0 + 4 * 60 * MIN),
        clearsAt: iso(T0 + 86400_000),
        request: { pickupWithinSec: 90, id: null, requestedAt: null, claimedAt: null, doneAt: null, expired: false, outcome: null, note: null }
      }
    ])
    // the alert is otherwise the alert it was
    expect(alert).toMatchObject({ key: a.key, rule: 'IntakeCiRedMain', resolvedAt: null })
  })

  it('follows the request: asked, picked up, waiting, ran', async () => {
    const a = sweepAlert()
    const key = engine.wall().incidents[0].key
    const id = (await wallPress(a.key)).pushed[0].request?.id as string
    const stage = async (): Promise<unknown> => (await detail(key)).alerts[0].pushed[0].request
    expect(await stage()).toMatchObject({ id, claimedAt: null, outcome: null, doneAt: null })
    clock += 20_000
    await listOf()
    expect(await stage()).toMatchObject({ id, claimedAt: iso(T0 + 20_000), outcome: null, doneAt: null })
    await answer(id, { outcome: 'dispatched', note: 'CI run 5' })
    expect(await stage()).toMatchObject({ outcome: 'dispatched', note: 'CI run 5', doneAt: null })
    clock += 90_000
    await answer(id, { outcome: 'ran' })
    expect(await stage()).toMatchObject({ outcome: 'ran', doneAt: iso(T0 + 110_000) })
  })

  it('keeps the last request on an alert that cleared, so the sheet can say what the sender found', async () => {
    const a = sweepAlert()
    const key = engine.wall().incidents[0].key
    const id = (await wallPress(a.key)).pushed[0].request?.id as string
    await answer(id, { outcome: 'ran' })
    engine.ingest({ source: 'sweep', kind: 'webhook', at: iso(), firing: [], resolved: [{ ...a, endsAt: iso() }], complete: false })
    const d = await detail(key)
    expect(d.alerts[0].resolvedAt).not.toBeNull()
    expect(d.alerts[0].pushed[0].request).toMatchObject({ id, outcome: 'ran' })
  })

  it('is [] for an alert a polled source reports, and request null for a pushing source that takes none', async () => {
    const g = alertOf('grafana', 'd1d2d3d4d5d60718')
    engine.ingest({ source: 'grafana', kind: 'grafana', at: iso(), firing: [g], resolved: [], complete: true })
    const w = alertOf('webhook', 'c1c2c3c4c5c60718', 'EdgeDead')
    engine.ingest({ source: 'webhook', kind: 'webhook', at: iso(), firing: [w], resolved: [], complete: false })
    const keyOf = (rule: string): string => engine.wall().incidents.find((i) => i.alerts.some((x) => x.rule === rule))?.key ?? ''
    expect((await detail(keyOf('IntakeCiRedMain'))).alerts.find((x) => x.key === g.key)?.pushed).toEqual([])
    const hook = (await detail(keyOf('EdgeDead'))).alerts[0].pushed
    expect(hook).toHaveLength(1)
    expect(hook[0]).toMatchObject({ source: 'webhook', request: null, nextReportAt: null, clearsAfterSec: 21600 })
  })
})
