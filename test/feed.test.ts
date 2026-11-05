// The feed source against a loopback server that answers GET /api/ops/watch the way another instance does: the body POST /ingest/<source> takes, behind a
// Bearer token. It runs through the same PollRunner and Engine main uses, so "resolved when it is no longer listed", "a failed poll changes nothing"
// and "Not answering after three misses" are the engine's own answers. Every token and value below is a test value.
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/server/config.ts'
import type { FeedSourceConfig, WatchConfig } from '../src/server/config.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { PollRunner } from '../src/server/recheck.ts'
import { POLLED } from '../src/server/source-registry.ts'
import { createFeedSource, normalizeFeed } from '../src/server/sources/feed.ts'
import { normalizeWebhook } from '../src/server/sources/webhook.ts'
import type { SourceDeps } from '../src/server/sources/types.ts'

const TOKEN = 'feed-test-token-'.padEnd(48, 'x')
const CANARY = 'canary-feed-value-41d2'
const T0 = Date.parse('2026-11-04T12:00:00Z')

// ---- the loopback feed --------------------------------------------------------------------------------------------------------------

type Answer = { status: number; body: string; headers?: Record<string, string> } | 'hang'
let answer: Answer = { status: 200, body: '{}' }
const seen: Array<{ path: string; authorization: string | undefined }> = []
let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization })
    if (req.url !== '/api/ops/watch') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"version":"4","alerts":[]}')
      return
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"unauthorized"}')
      return
    }
    if (answer === 'hang') return
    res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) })
    res.end(answer.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  seen.length = 0
})

/** One alert as another instance's feed lists it: Alertmanager v4's fields. */
const alert = (name: string, over: Record<string, unknown> = {}) => ({
  status: 'firing',
  labels: { alertname: name, severity: 'page', service: 'api prod', instance: name.toLowerCase() },
  annotations: { summary: `${name} on api prod` },
  startsAt: '2026-11-04T11:50:00Z',
  fingerprint: createHash('sha256').update(name).digest('hex').slice(0, 16),
  ...over
})
const body = (alerts: unknown[], checks?: unknown) => JSON.stringify({ version: '4', groupKey: 'second', receiver: 'watch', status: 'firing', alerts, ...(checks ? { checks } : {}) })
const checkList = (ids: string[]) => ({ staleAfterSec: 300, list: ids.map((id) => ({ id, service: 'api prod', state: 'ok', detail: `${id} ran` })) })

function harness(over: Partial<FeedSourceConfig> = {}, env: NodeJS.ProcessEnv = { MAKEFUN_FEED_TOKEN_PROD: TOKEN }) {
  const clock = { ms: T0 }
  const cfg: FeedSourceConfig = { id: 'second-feed-prod', type: 'feed', url: `${base}/api/ops/watch`, tokenEnv: 'MAKEFUN_FEED_TOKEN_PROD', origin: 'second-prod-feed', ...over }
  const logs: string[] = []
  const deps: SourceDeps = { fetch, env, nowIso: () => new Date(clock.ms).toISOString(), serviceMap: [], log: (l) => void logs.push(l) }
  const watch: WatchConfig = {
    baseUrl: 'https://watch.test',
    port: 0,
    host: '127.0.0.1',
    dataDir: ':memory:',
    historyHours: 24,
    staleAfterMisses: 3,
    sources: [cfg],
    serviceMap: [],
    channels: [],
    routes: [],
    quietHours: null
  }
  const engine = new Engine(openDb(':memory:'), watch, () => clock.ms)
  const source = createFeedSource(cfg, deps)
  const runner = new PollRunner(engine, (l) => void logs.push(l), () => clock.ms)
  const poll = async () => {
    const out = await runner.scheduled(source)
    clock.ms += 60_000
    return out
  }
  const firing = () => engine.wall().incidents.flatMap((i) => i.alerts.map((a) => a.rule)).sort()
  const status = () => engine.sources().find((s) => s.id === cfg.id)
  return { cfg, deps, engine, source, poll, firing, status, logs, clock }
}

describe('a good answer is the whole state', () => {
  it('puts its alerts on the wall under the feed origin, seen through the feed, with the GET carrying the bearer', async () => {
    const h = harness()
    answer = { status: 200, body: body([alert('MakefunJobsStuck'), alert('MakefunDbSlow', { labels: { alertname: 'MakefunDbSlow', severity: 'warning', service: 'api prod' } })]) }
    expect(await h.poll()).toMatchObject({ ok: true, error: null })
    expect(h.firing()).toEqual(['MakefunDbSlow', 'MakefunJobsStuck'])
    const a = h.engine.wall().incidents.flatMap((i) => i.alerts)[0]
    expect(a.origin).toBe('second-prod-feed')
    expect(a.via.map((v) => [v.source, v.kind])).toEqual([['second-feed-prod', 'feed']])
    expect(seen).toEqual([{ path: '/api/ops/watch', authorization: `Bearer ${TOKEN}` }])
    expect(h.status()).toMatchObject({ kind: 'feed', state: 'ok', misses: 0 })
  })

  it('resolves a firing alert the next good answer no longer lists, and one it lists as resolved', async () => {
    const h = harness()
    answer = { status: 200, body: body([alert('MakefunJobsStuck'), alert('MakefunDbSlow'), alert('MakefunQueueDeep')]) }
    await h.poll()
    answer = { status: 200, body: body([alert('MakefunJobsStuck'), alert('MakefunQueueDeep', { status: 'resolved', endsAt: '2026-11-04T12:00:30Z' })]) }
    await h.poll()
    expect(h.firing()).toEqual(['MakefunJobsStuck'])
    // an empty list is "nothing firing"
    answer = { status: 200, body: body([]) }
    await h.poll()
    expect(h.firing()).toEqual([])
    const resolvedEvents = h.engine.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'resolved'").get() as { n: number }
    expect(resolvedEvents.n).toBeGreaterThanOrEqual(3)
  })

  it('reads a check list as complete by default: a check the next answer leaves out is dropped', async () => {
    const h = harness()
    answer = { status: 200, body: body([], checkList(['JobsQueue', 'DbPing'])) }
    await h.poll()
    const cells = () => (h.engine.db.prepare("SELECT id FROM rules WHERE source = 'second-prod-feed'").all() as Array<{ id: string }>).map((r) => r.id).sort()
    expect(cells()).toEqual(['check:second-prod-feed:api prod/DbPing', 'check:second-prod-feed:api prod/JobsQueue'])
    answer = { status: 200, body: JSON.stringify({ checks: checkList(['JobsQueue']) }) }
    await h.poll()
    expect(cells()).toEqual(['check:second-prod-feed:api prod/JobsQueue'])
  })

  it('is read by the webhook ingest parser itself: the same body gives the same alerts as a push', () => {
    const deps: SourceDeps = { fetch, env: {}, nowIso: () => new Date(T0).toISOString(), serviceMap: [] }
    const raw = JSON.parse(body([alert('MakefunJobsStuck'), alert('MakefunDbSlow')], checkList(['JobsQueue']))) as unknown
    const fed = normalizeFeed(raw, { id: 'second-feed-prod', origin: 'second-prod-feed' }, deps)
    const pushed = normalizeWebhook(raw, { source: 'second-feed-prod', headerSource: 'second-prod-feed', deps })
    expect(fed.complete).toBe(true)
    expect(pushed.complete).toBe(false)
    expect(fed.kind).toBe('feed')
    expect(fed.firing.map((a) => [a.key, a.rule, a.severity, a.service])).toEqual(pushed.firing.map((a) => [a.key, a.rule, a.severity, a.service]))
    expect(fed.checks).toEqual(pushed.checks)
    // no origin: the source id is the sender
    expect(normalizeFeed(raw, { id: 'second-feed-prod' }, deps).firing[0].origin).toBe('second-feed-prod')
  })
})

describe('a failed poll changes nothing', () => {
  it('keeps every alert through a 503, bad JSON and a refused body, names the reason without a value, and reads Not answering after three misses', async () => {
    const h = harness()
    answer = { status: 200, body: body([alert('MakefunJobsStuck')]) }
    await h.poll()
    answer = { status: 503, body: `{"error":"${CANARY}"}` }
    expect(await h.poll()).toMatchObject({ ok: false, error: 'feed returned HTTP 503' })
    answer = { status: 200, body: `{"alerts": [${CANARY}` }
    expect(await h.poll()).toMatchObject({ ok: false, error: 'feed returned a body that is not JSON' })
    expect(h.status()).toMatchObject({ state: 'error', misses: 2 })
    answer = { status: 200, body: body([alert('MakefunJobsStuck', { status: CANARY })]) }
    expect(await h.poll()).toMatchObject({ ok: false, error: 'feed body refused: alerts[0].status must be firing or resolved' })
    expect(h.firing()).toEqual(['MakefunJobsStuck'])
    expect(h.status()).toMatchObject({ state: 'stale', misses: 3 })
    expect(h.engine.staleAlerts((id) => ({ key: `self:${id}` }) as never)).toHaveLength(1)
    const said = JSON.stringify([h.logs, h.status()])
    expect(said).not.toContain(CANARY)
    expect(said).not.toContain(TOKEN)
    // the next good answer clears the misses
    answer = { status: 200, body: body([]) }
    await h.poll()
    expect(h.status()).toMatchObject({ state: 'ok', misses: 0 })
    expect(h.firing()).toEqual([])
  })

  it('refuses a body that names no alerts list and no checks, or an alerts that is not a list, so nothing is resolved by it', async () => {
    const h = harness()
    answer = { status: 200, body: body([alert('MakefunJobsStuck')]) }
    await h.poll()
    for (const [raw, why] of [
      ['{"status":"ok"}', 'feed body refused: payload has no alerts list and no checks'],
      ['{"alerts":"none","checks":{"list":[{"id":"x","service":"s","state":"ok"}]}}', 'feed body refused: alerts must be a list'],
      ['[]', 'feed body refused: payload must be a JSON object'],
      ['{"alerts":[{"status":"firing","labels":{"alertname":"X"}}]}', 'feed body refused: payload is neither an Alertmanager v4 nor a Grafana webhook']
    ] as const) {
      answer = { status: 200, body: raw }
      expect(await h.poll()).toMatchObject({ ok: false, error: why })
    }
    expect(h.firing()).toEqual(['MakefunJobsStuck'])
  })

  it('never follows a redirect, so the token goes nowhere else', async () => {
    const h = harness()
    answer = { status: 302, body: '', headers: { location: `${base}/elsewhere` } }
    expect(await h.poll()).toMatchObject({ ok: false, error: 'feed returned HTTP 302' })
    expect(seen.map((s) => s.path)).toEqual(['/api/ops/watch'])
  })

  it('says a wrong token, a missing one, a refused connection and a timeout in words, never a value', async () => {
    expect(await harness({}, { MAKEFUN_FEED_TOKEN_PROD: 'wrong-token' }).poll()).toMatchObject({ ok: false, error: 'feed returned HTTP 401' })
    expect(await harness({}, {}).poll()).toMatchObject({ ok: false, error: 'missing environment variable MAKEFUN_FEED_TOKEN_PROD' })
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    expect(await harness({ url: `http://127.0.0.1:${port}/api/ops/watch` }).poll()).toMatchObject({ ok: false, error: 'feed request failed: ECONNREFUSED' })
    answer = 'hang'
    expect(await harness({ timeoutMs: 200 }).poll()).toMatchObject({ ok: false, error: 'feed request failed: timed out after 0.2 s' })
    answer = { status: 200, body: '{}' }
  })
})

describe('the feed config', () => {
  const write = (source: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-feed-cfg-'))
    const file = join(dir, 'watch.json')
    writeFileSync(file, JSON.stringify({ baseUrl: 'https://watch.test', port: 0, host: '127.0.0.1', dataDir: ':memory:', historyHours: 24, staleAfterMisses: 3, sources: [source], serviceMap: [], channels: [], routes: [], quietHours: null }))
    return file
  }
  const feed = (over: Record<string, unknown> = {}) => ({ id: 'second-feed-dev', type: 'feed', url: 'https://dev.example.net/api/ops/watch', tokenEnv: 'MAKEFUN_FEED_TOKEN_DEV', ...over })

  it('takes https anywhere and http to a loopback or tailnet address, and the registry starts it at 60 s', () => {
    for (const url of ['https://dev.example.net/api/ops/watch', 'http://127.0.0.1:5281/api/ops/watch', 'http://100.64.0.1/api/ops/watch']) expect(() => loadConfig(write(feed({ url }))), url).not.toThrow()
    const cfg = loadConfig(write(feed()))
    const built = POLLED.feed?.(cfg.sources[0], { fetch, env: {}, nowIso: () => new Date(T0).toISOString(), serviceMap: [] }, { loadNodes: [] })
    expect(built?.source).toMatchObject({ id: 'second-feed-dev', kind: 'feed', pollSec: 60 })
  })

  it('refuses a url the token must not travel to in the clear, and a bad origin, token or timing', () => {
    const bad: Array<[unknown, RegExp]> = [
      [feed({ url: 'http://dev.example.net/api/ops/watch' }), /needs a url that is https, or http to a loopback/],
      [feed({ url: 'http://8.8.8.8/api/ops/watch' }), /needs a url that is https/],
      [feed({ tokenEnv: '' }), /needs a tokenEnv/],
      [feed({ origin: 'has space' }), /origin must be letters/],
      [feed({ pollSec: -1 }), /pollSec must be a number of seconds above 0/],
      [feed({ timeoutMs: 120_000 }), /timeoutMs must be a whole number of ms from 100 to 60000/]
    ]
    for (const [source, message] of bad) expect(() => loadConfig(write(source)), JSON.stringify(source)).toThrow(message)
  })
})
