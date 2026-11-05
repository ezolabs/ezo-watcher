// The http-probe source against real loopback servers: an HTTP one whose answers each test sets, and a TLS one with a self-signed certificate that
// expires in five days (made with openssl for this run), for the certificate path. The clock the source reads is the test's own, so the damping
// streaks and the hour-long certificate cache move only when a test says. Every token and host below is a test value.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, plainHttpAllowed, probeUrlAllowed } from '../src/server/config.ts'
import type { HttpProbeSourceConfig, HttpProbeTargetConfig, WatchConfig } from '../src/server/config.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'
import { PollRunner } from '../src/server/recheck.ts'
import { POLLED } from '../src/server/source-registry.ts'
import { CERT_CACHE_MS, PROBE_RULES, createHttpProbeSource, probeTarget, readPeerCert, valueAt } from '../src/server/sources/http-probe.ts'
import type { CertReader } from '../src/server/sources/http-probe.ts'
import type { SourceDeps } from '../src/server/sources/types.ts'
import type { Observation, RuleCell } from '../src/shared/types.ts'

const DAY = 86_400_000
const SECRET_FIELD = 'canary-body-secret-7f1c'

// ---- the loopback HTTP server: each path answers what the current test says ----------------------------------------------------------------

type Answer = { status: number; body?: string; delayMs?: number; headers?: Record<string, string> } | 'hang'
const answers = new Map<string, Answer>()
const hits = new Map<string, number>()
let http: Server
let base = ''

beforeAll(async () => {
  http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/'
    hits.set(path, (hits.get(path) ?? 0) + 1)
    const a = answers.get(path) ?? { status: 404, body: 'no' }
    if (a === 'hang') return
    const send = (): void => {
      res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers ?? {}) })
      res.end(a.body ?? '')
    }
    if (a.delayMs) setTimeout(send, a.delayMs)
    else send()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})

afterAll(async () => {
  http.closeAllConnections()
  await new Promise<void>((resolve) => http.close(() => resolve()))
})

beforeEach(() => {
  answers.clear()
  hits.clear()
})

const HEALTH = JSON.stringify({ ok: true, name: 'second.example', db: { kind: 'postgres', status: 'up' }, token: SECRET_FIELD })
const target = (over: Partial<HttpProbeTargetConfig> = {}): HttpProbeTargetConfig => ({ id: 'prod-health', service: 'api prod', url: `${base}/health`, ...over })

// ---- one GET -------------------------------------------------------------------------------------------------------------------------

describe('one probe', () => {
  it('passes a 200 whose JSON paths hold the expected values, and times it', async () => {
    answers.set('/health', { status: 200, body: HEALTH })
    const r = await probeTarget(fetch, target({ expectJson: { ok: true, 'db.kind': 'postgres', 'db.status': 'up' } }))
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(r.detail).toMatch(/^HTTP 200 in \d+ms$/)
  })

  it('names the one path that differs or is missing, never the rest of the body', async () => {
    answers.set('/health', { status: 200, body: JSON.stringify({ ok: true, db: { kind: 'pglite', status: 'up' }, token: SECRET_FIELD }) })
    const r = await probeTarget(fetch, target({ expectJson: { ok: true, 'db.kind': 'postgres' } }))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/^HTTP 200 in \d+ms, but db\.kind is "pglite", expected "postgres"$/)
    expect(r.detail).not.toContain(SECRET_FIELD)
    const missing = await probeTarget(fetch, target({ expectJson: { 'db.region': 'eu' } }))
    expect(missing.detail).toMatch(/but db\.region is missing, expected "eu"$/)
    const nested = await probeTarget(fetch, target({ expectJson: { db: 'x' } }))
    expect(nested.detail).toMatch(/but db is an object, expected "x"$/)
  })

  it('fails a body that is not JSON when paths are expected, and passes it when none are', async () => {
    answers.set('/health', { status: 200, body: `<html>${SECRET_FIELD}</html>` })
    const r = await probeTarget(fetch, target({ expectJson: { ok: true } }))
    expect(r.detail).toMatch(/^HTTP 200 in \d+ms, but the body is not JSON$/)
    expect((await probeTarget(fetch, target())).ok).toBe(true)
  })

  it('fails a status other than the expected one', async () => {
    answers.set('/health', { status: 503, body: HEALTH })
    const r = await probeTarget(fetch, target())
    expect(r).toMatchObject({ ok: false, status: 503 })
    expect(r.detail).toMatch(/^HTTP 503 in \d+ms, expected 200$/)
  })

  it('never follows a redirect: a 3xx fails unless the target expects it, and the place it points to is never asked', async () => {
    answers.set('/health', { status: 302, headers: { location: `${base}/elsewhere` } })
    answers.set('/elsewhere', { status: 200, body: HEALTH })
    const r = await probeTarget(fetch, target())
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/^HTTP 302 in \d+ms \(a redirect, not followed\), expected 200$/)
    expect(hits.get('/elsewhere')).toBeUndefined()
    expect((await probeTarget(fetch, target({ expectStatus: 302 }))).ok).toBe(true)
  })

  it('says a refused connection and a timeout in words, with the code and never the URL', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const refused = await probeTarget(fetch, target({ url: `http://127.0.0.1:${port}/health` }))
    expect(refused).toMatchObject({ ok: false, status: null, detail: 'no answer: ECONNREFUSED' })
    answers.set('/slow', 'hang')
    const hung = await probeTarget(fetch, target({ url: `${base}/slow`, timeoutMs: 200 }))
    expect(hung).toMatchObject({ ok: false, status: null, detail: 'no answer: timed out after 0.2 s' })
  })

  it('reads a dotted path through objects and list indexes only', () => {
    const json = { a: { b: [{ c: 1 }] }, 'x.y': 2 }
    expect(valueAt(json, 'a.b.0.c')).toBe(1)
    expect(valueAt(json, 'a.b.1.c')).toBeUndefined()
    expect(valueAt(json, 'a.toString')).toBeUndefined()
    expect(valueAt(null, 'a')).toBeUndefined()
  })
})

// ---- the source, the damping and the engine ------------------------------------------------------------------------------------------

const T0 = Date.parse('2026-11-04T12:00:00Z')

function harness(cfg: HttpProbeSourceConfig, readCert?: CertReader) {
  const clock = { ms: T0 }
  const deps: SourceDeps = { fetch, env: {}, nowIso: () => new Date(clock.ms).toISOString(), serviceMap: [] }
  const watch: WatchConfig = {
    baseUrl: 'https://watch.test',
    port: 0,
    host: '127.0.0.1',
    dataDir: ':memory:',
    historyHours: 24,
    staleAfterMisses: 3,
    sources: [cfg],
    serviceMap: [],
    splitIncidents: [{ match: { origin: `^${cfg.id}$` }, by: 'instance' }],
    channels: [],
    routes: [],
    quietHours: null
  }
  const engine = new Engine(openDb(':memory:'), watch, () => clock.ms)
  const source = createHttpProbeSource(cfg, deps, readCert ?? (async () => T0 + 365 * DAY))
  const runner = new PollRunner(engine, () => undefined, () => clock.ms)
  let last: Observation | null = null
  const poll = async (): Promise<Observation> => {
    const obs = await source.poll()
    last = obs
    engine.ingest(obs)
    engine.recordSource(source.id, true, null)
    clock.ms += 60_000
    return obs
  }
  const cell = (rule: string, id: string): RuleCell | undefined => last?.checks?.cells.find((c) => c.checkId === rule && c.name === id)
  const firing = (rule: string) => engine.wall().incidents.filter((i) => i.rule === rule)
  return { clock, engine, source, runner, poll, cell, firing }
}

describe('ProbeDown damping', () => {
  // built per test: the server's port is known only once it listens
  const config = (): HttpProbeSourceConfig => ({ id: 'second-probe', type: 'http-probe', failAfter: 3, targets: [target({ expectJson: { ok: true } })] })

  it('reads pending for the first failures, pages on the failAfter-th, and resolves on the first success', async () => {
    const h = harness(config())
    answers.set('/health', { status: 503, body: HEALTH })
    await h.poll()
    expect(h.cell(PROBE_RULES.down, 'prod-health')).toMatchObject({ state: 'pending', service: 'api prod' })
    expect(h.cell(PROBE_RULES.down, 'prod-health')?.detail).toMatch(/^HTTP 503 in \d+ms, expected 200 \(failure 1 of 3 before it pages\)$/)
    await h.poll()
    expect(h.firing(PROBE_RULES.down)).toHaveLength(0)
    const third = await h.poll()
    expect(third.firing.map((a) => [a.rule, a.severity, a.labels.instance])).toEqual([['ProbeDown', 'page', 'prod-health']])
    expect(h.cell(PROBE_RULES.down, 'prod-health')?.state).toBe('firing')
    const [incident] = h.firing(PROBE_RULES.down)
    expect(incident).toMatchObject({ severity: 'page', service: 'api prod', instance: 'prod-health' })
    expect(incident.alerts[0].annotations.summary).toMatch(/^prod-health is down: HTTP 503 in \d+ms, expected 200$/)
    // a fourth failure keeps it firing, and a restart's empty streak never resolves it (a failing poll resolves nothing)
    await h.poll()
    expect(h.firing(PROBE_RULES.down)).toHaveLength(1)
    answers.set('/health', { status: 200, body: HEALTH })
    const ok = await h.poll()
    expect(ok.resolved.map((a) => a.rule)).toContain('ProbeDown')
    expect(h.firing(PROBE_RULES.down)).toHaveLength(0)
    expect(h.cell(PROBE_RULES.down, 'prod-health')).toMatchObject({ state: 'ok' })
    expect(h.cell(PROBE_RULES.down, 'prod-health')?.detail).toMatch(/^HTTP 200 in \d+ms$/)
  })

  it('starts the streak again after a success, so failures apart never page', async () => {
    const h = harness(config())
    for (const status of [503, 503, 200, 503, 503, 200, 503]) {
      answers.set('/health', { status, body: HEALTH })
      await h.poll()
    }
    expect(h.firing(PROBE_RULES.down)).toHaveLength(0)
    expect(h.cell(PROBE_RULES.down, 'prod-health')?.state).toBe('pending')
  })

  it('never fails the poll itself: an unreachable target is its own alert, and the prober reads ok', async () => {
    const h = harness({ ...config(), failAfter: 1, targets: [target({ url: 'http://127.0.0.1:1/health' })] })
    await h.runner.scheduled(h.source)
    expect(h.engine.sources()[0]).toMatchObject({ id: 'second-probe', kind: 'http-probe', state: 'ok', misses: 0 })
    expect(h.firing(PROBE_RULES.down)).toHaveLength(1)
  })
})

describe('ProbeSlow', () => {
  it('warns after failAfter slow answers in a row, leaves it alone while the probe fails, and one fast answer resolves it', async () => {
    const h = harness({ id: 'second-probe', type: 'http-probe', failAfter: 2, targets: [target({ slowMs: 60 })] })
    answers.set('/health', { status: 200, body: HEALTH, delayMs: 150 })
    await h.poll()
    expect(h.cell(PROBE_RULES.slow, 'prod-health')?.state).toBe('pending')
    await h.poll()
    const [slow] = h.firing(PROBE_RULES.slow)
    expect(slow).toMatchObject({ severity: 'warning', instance: 'prod-health' })
    expect(h.cell(PROBE_RULES.slow, 'prod-health')?.detail).toMatch(/^HTTP 200 in \d+ms, over 60ms on 2 polls in a row$/)
    answers.set('/health', { status: 500, body: '' })
    await h.poll()
    expect(h.cell(PROBE_RULES.slow, 'prod-health')).toMatchObject({ state: 'nodata', detail: 'not timed: the probe failed' })
    expect(h.firing(PROBE_RULES.slow)).toHaveLength(1)
    answers.set('/health', { status: 200, body: HEALTH })
    await h.poll()
    expect(h.firing(PROBE_RULES.slow)).toHaveLength(0)
    expect(h.cell(PROBE_RULES.slow, 'prod-health')?.detail).toMatch(/^HTTP 200 in \d+ms, under 60ms$/)
  })

  it('has no ProbeSlow cell for a target without slowMs, and no CertExpiring cell for an http one', async () => {
    const h = harness({ id: 'second-probe', type: 'http-probe', targets: [target()] })
    answers.set('/health', { status: 200, body: HEALTH })
    const obs = await h.poll()
    expect(obs.checks?.cells.map((c) => c.checkId)).toEqual(['ProbeDown'])
    expect(obs.checks?.complete).toBe(true)
  })
})

// ---- the certificate ---------------------------------------------------------------------------------------------------------------

describe('CertExpiring', () => {
  let tls: Server
  let tlsPort = 0
  let validTo = 0

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-probe-tls-'))
    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '5', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
    tls = createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve))
    tlsPort = (tls.address() as AddressInfo).port
    validTo = await readPeerCert('127.0.0.1', tlsPort, 5000)
  })

  afterAll(async () => {
    tls.closeAllConnections()
    await new Promise<void>((resolve) => tls.close(() => resolve()))
  })

  it('reads the peer certificate even though nothing trusts it', () => {
    const left = validTo - Date.now()
    expect(left).toBeGreaterThan(4 * DAY)
    expect(left).toBeLessThanOrEqual(5 * DAY + 60_000)
  })

  it('says what a failed read could not do, in a code', async () => {
    await expect(readPeerCert('127.0.0.1', 1, 2000)).rejects.toThrow(/^ECONNREFUSED$/)
  })

  it('warns under certWarnDays, pages under certPageDays, resolves the other tier, and reads the certificate at most once an hour', async () => {
    let reads = 0
    const counted: CertReader = (host, port, ms) => {
      reads += 1
      return readPeerCert(host, port, ms)
    }
    const url = `https://127.0.0.1:${tlsPort}/health`
    const h = harness({ id: 'second-probe', type: 'http-probe', targets: [target({ id: 'self-signed', url })] }, counted)
    h.clock.ms = validTo - 5 * DAY + 3600_000
    const first = await h.poll()
    // the GET verifies, so a self-signed certificate is a failed probe, while its expiry is still read
    expect(h.cell(PROBE_RULES.down, 'self-signed')?.detail).toMatch(/^no answer: [A-Z0-9_]+ \(failure 1 of 3 before it pages\)$/)
    expect(first.firing.map((a) => [a.rule, a.severity])).toEqual([['CertExpiring', 'warning']])
    expect(first.resolved.filter((a) => a.rule === 'CertExpiring').map((a) => a.severity)).toEqual(['page'])
    expect(h.cell(PROBE_RULES.cert, 'self-signed')).toMatchObject({ state: 'firing', detail: expect.stringMatching(/^certificate expires in 4 days \(\d{4}-\d{2}-\d{2}\)$/) })
    expect(reads).toBe(1)
    // inside the hour: no new handshake
    h.clock.ms += 30 * 60_000
    await h.poll()
    expect(reads).toBe(1)
    // two days left, an hour later: read again, and now it pages
    h.clock.ms = validTo - 2 * DAY
    const later = await h.poll()
    expect(reads).toBe(2)
    expect(later.firing.filter((a) => a.rule === 'CertExpiring').map((a) => a.severity)).toEqual(['page'])
    expect(later.resolved.filter((a) => a.rule === 'CertExpiring').map((a) => a.severity)).toEqual(['warning'])
    expect(h.firing(PROBE_RULES.cert).map((i) => i.severity)).toEqual(['page'])
    expect(CERT_CACHE_MS).toBe(3600_000)
  })

  it('resolves both tiers with plenty of time left, and leaves them as they were when the certificate cannot be read', async () => {
    let fail = false
    const reader: CertReader = async () => {
      if (fail) throw new Error('ECONNRESET')
      return T0 + 2 * DAY
    }
    const h = harness({ id: 'second-probe', type: 'http-probe', targets: [target({ id: 'site', url: 'https://127.0.0.1:1/health', certWarnDays: 30, certPageDays: 7 })] }, reader)
    const fetchless = await h.poll()
    expect(fetchless.firing.filter((a) => a.rule === 'CertExpiring').map((a) => a.severity)).toEqual(['page'])
    fail = true
    h.clock.ms += CERT_CACHE_MS
    const blind = await h.poll()
    expect(blind.firing.filter((a) => a.rule === 'CertExpiring')).toEqual([])
    expect(blind.resolved.filter((a) => a.rule === 'CertExpiring')).toEqual([])
    expect(h.cell(PROBE_RULES.cert, 'site')).toMatchObject({ state: 'nodata', detail: 'certificate not read: ECONNRESET' })
    expect(h.firing(PROBE_RULES.cert)).toHaveLength(1)
  })
})

// ---- the config ---------------------------------------------------------------------------------------------------------------------

describe('the http rule and the config', () => {
  it('lets plain http reach loopback, RFC 1918 and 100.64.0.0/10 addresses only', () => {
    for (const host of ['127.0.0.1', '127.9.9.9', 'localhost', '[::1]', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.64.1.2', '100.127.255.255']) expect(plainHttpAllowed(host), host).toBe(true)
    for (const host of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.169.0.1', 'second.example', 'internal.lan', '999.1.1.1']) expect(plainHttpAllowed(host), host).toBe(false)
    expect(probeUrlAllowed('https://example.net/health')).toBe(true)
    expect(probeUrlAllowed('http://example.net/health')).toBe(false)
    expect(probeUrlAllowed('http://127.0.0.1:5281/health')).toBe(true)
    expect(probeUrlAllowed('https://user:pass@example.net/health')).toBe(false)
    expect(probeUrlAllowed('ftp://127.0.0.1/')).toBe(false)
  })

  const write = (source: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-probe-cfg-'))
    const file = join(dir, 'watch.json')
    writeFileSync(file, JSON.stringify({ baseUrl: 'https://watch.test', port: 0, host: '127.0.0.1', dataDir: ':memory:', historyHours: 24, staleAfterMisses: 3, sources: [source], serviceMap: [], channels: [], routes: [], quietHours: null }))
    return file
  }
  const probe = (over: Record<string, unknown> = {}, t: Record<string, unknown> = {}) => ({ id: 'p', type: 'http-probe', targets: [{ id: 'a', service: 'S', url: 'https://example.net/health', ...t }], ...over })

  it('takes the shape with its defaults, and the registry starts it at 60 s', () => {
    const cfg = loadConfig(write(probe()))
    const built = POLLED['http-probe']?.(cfg.sources[0], { fetch, env: {}, nowIso: () => new Date(T0).toISOString(), serviceMap: [] }, { loadNodes: [] })
    expect(built?.source).toMatchObject({ id: 'p', kind: 'http-probe', pollSec: 60 })
  })

  it('refuses what it cannot probe safely, naming the field', () => {
    const bad: Array<[unknown, RegExp]> = [
      [probe({ targets: [] }), /needs targets/],
      [probe({}, { url: 'http://example.net/health' }), /targets\[0\]\.url must be https, or http to a loopback/],
      [probe({}, { id: 'has space' }), /targets\[0\]\.id must be letters/],
      [probe({}, { service: '' }), /targets\[0\]\.service must name/],
      [probe({}, { expectStatus: 99 }), /expectStatus must be an HTTP status/],
      [probe({}, { expectJson: { ok: { nested: true } } }), /expectJson\.ok must be a string, a number or true or false/],
      [probe({}, { expectJson: { 'a..b': 1 } }), /expectJson has a path with an empty segment/],
      [probe({}, { timeoutMs: 50 }), /timeoutMs must be a whole number of ms from 100 to 60000/],
      [probe({}, { slowMs: 10_000 }), /slowMs must be a number of ms above 0 and under timeoutMs/],
      [probe({}, { certWarnDays: 2, certPageDays: 3 }), /certPageDays must be 0 or more and at most certWarnDays/],
      [probe({ failAfter: 0 }), /failAfter must be a whole number of polls from 1 to 20/],
      [probe({ pollSec: 0 }), /pollSec must be a number of seconds above 0/],
      [{ ...probe(), targets: [{ id: 'a', service: 'S', url: 'https://a.test/' }, { id: 'a', service: 'S', url: 'https://b.test/' }] }, /targets\[1\]\.id a is used twice/]
    ]
    for (const [source, message] of bad) expect(() => loadConfig(write(source)), JSON.stringify(source)).toThrow(message)
  })
})
