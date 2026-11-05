// The tcp-probe source against real loopback sockets: a plain TCP server that accepts and holds, a TLS one with a self-signed certificate that
// expires in five days (made with openssl for this run), and a port that is closed. The connector seam and the clock the source reads are the
// test's own where a real socket cannot give the needed timing, so the damping streaks move only when a test says.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configServiceNames, loadConfig } from '../../src/server/config.ts'
import type { TcpProbeSourceConfig, TcpProbeTargetConfig, WatchConfig } from '../../src/server/config.ts'
import { openDb } from '../../src/server/db.ts'
import { Engine } from '../../src/server/engine.ts'
import { POLLED } from '../../src/server/source-registry.ts'
import { PROBE_RULES } from '../../src/server/sources/http-probe.ts'
import { TCP_ASSERTS, TCP_PROBE_DEFAULTS, connectTcp, createTcpProbeSource, normalizeTcpProbe, probeTcp } from '../../src/server/sources/tcp-probe.ts'
import type { TcpConnector, TcpProbeResult, TcpTargetReading } from '../../src/server/sources/tcp-probe.ts'
import type { SourceDeps } from '../../src/server/sources/types.ts'
import type { Observation, RuleCell } from '../../src/shared/types.ts'

const DAY = 86_400_000
const T0 = Date.parse('2026-11-04T12:00:00Z')

// ---- two loopback servers: plain TCP and TLS ---------------------------------------------------------------------------------------------

const sockets = new Set<Socket>()
const hold = (socket: Socket): void => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => undefined)
}

let plain: Server
let plainPort = 0
let tls: Server
let tlsPort = 0
let tlsValidTo = 0

beforeAll(async () => {
  plain = createNetServer(hold)
  await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve))
  plainPort = (plain.address() as AddressInfo).port

  const dir = mkdtempSync(join(tmpdir(), 'watch-tcp-tls-'))
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '5', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
  tls = createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) }, hold)
  await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve))
  tlsPort = (tls.address() as AddressInfo).port
  const first = await connectTcp('127.0.0.1', tlsPort, { tls: true, timeoutMs: 5000 })
  tlsValidTo = first.certValidToMs ?? 0
})

afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => plain.close(() => resolve()))
  await new Promise<void>((resolve) => tls.close(() => resolve()))
})

// ---- one connect --------------------------------------------------------------------------------------------------------------------------

describe('one probe', () => {
  it('connects to a listening port, closes again and reports no certificate for a plain target', async () => {
    const r = await probeTcp({ id: 'pg', service: 'api', host: '127.0.0.1', port: plainPort })
    expect(r.ok).toBe(true)
    expect(r.cert).toBeNull()
    expect(r.detail).toMatch(/^TCP connect in \d+ms$/)
  })

  it('names a refused connect, and a timeout, in words', async () => {
    const closed = createNetServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const refused = await probeTcp({ id: 'pg', service: 'api', host: '127.0.0.1', port })
    expect(refused).toMatchObject({ ok: false, detail: 'no connection: ECONNREFUSED' })
    const timedOut: TcpConnector = async () => {
      const err = new Error('timed out')
      err.name = 'TimeoutError'
      throw err
    }
    const hung = await probeTcp({ id: 'pg', service: 'api', host: '192.0.2.10', port: 5432, timeoutMs: 200, tls: true }, timedOut)
    expect(hung).toMatchObject({ ok: false, detail: 'no connection: timed out after 0.2 s' })
    expect(hung.cert).toEqual({ ok: false, detail: 'timed out after 0.2 s' })
  })

  it('reads the peer certificate on the same handshake, verification off', async () => {
    const r = await probeTcp({ id: 'pg', service: 'api', host: '127.0.0.1', port: tlsPort, tls: true })
    expect(r.ok).toBe(true)
    expect(r.detail).toMatch(/^TLS connect in \d+ms$/)
    expect(r.cert?.ok).toBe(true)
    if (r.cert?.ok) {
      const left = r.cert.validToMs - Date.now()
      expect(left).toBeGreaterThan(4 * DAY)
      expect(left).toBeLessThanOrEqual(5 * DAY + 60_000)
    }
    expect(tlsValidTo).toBeGreaterThan(Date.now() + 4 * DAY)
  })

  it('says a handshake that never completed could not read a certificate, without calling the target up', async () => {
    const reset: TcpConnector = async () => {
      const err = new Error('reset') as NodeJS.ErrnoException
      err.code = 'ECONNRESET'
      throw err
    }
    const r = await probeTcp({ id: 'pg', service: 'api', host: '127.0.0.1', port: tlsPort, tls: true }, reset)
    expect(r).toMatchObject({ ok: false, detail: 'no connection: ECONNRESET' })
    expect(r.cert).toEqual({ ok: false, detail: 'ECONNRESET' })
  })
})

// ---- the damped reading, without a network ------------------------------------------------------------------------------------------------

const baseTarget: TcpProbeTargetConfig = { id: 'pg', service: 'api', host: '127.0.0.1', port: 5432 }
const ctx = (nowMs = T0) => ({ nowIso: new Date(nowMs).toISOString(), serviceMap: [] })
const up = (over: Partial<TcpProbeResult> = {}): TcpProbeResult => ({ ok: true, ms: 12, detail: 'TCP connect in 12ms', cert: null, ...over })
const down = (over: Partial<TcpProbeResult> = {}): TcpProbeResult => ({ ok: false, ms: 2, detail: 'no connection: ECONNREFUSED', cert: null, ...over })
const reading = (probe: TcpProbeResult, over: Partial<TcpTargetReading> = {}, target: Partial<TcpProbeTargetConfig> = {}): TcpTargetReading => ({
  target: { ...baseTarget, ...target },
  probe,
  fails: probe.ok ? 0 : 1,
  slows: null,
  ...over
})
const cfg = (over: Partial<TcpProbeSourceConfig> = {}, target: Partial<TcpProbeTargetConfig> = {}): TcpProbeSourceConfig => ({
  id: 'ports',
  type: 'tcp-probe',
  targets: [{ ...baseTarget, ...target }],
  ...over
})
const cellOf = (o: Observation, rule: string, name = 'pg'): RuleCell | undefined => o.checks?.cells.find((c) => c.checkId === rule && c.name === name)

describe('ProbeDown damping', () => {
  it('reads pending for the first failures, pages on the failAfter-th, and resolves on the first success', () => {
    const c = cfg({}, { failAfter: 3 })
    const first = normalizeTcpProbe([reading(down(), { fails: 1 })], c, ctx())
    expect(first.firing).toEqual([])
    expect(cellOf(first, PROBE_RULES.down)).toMatchObject({ state: 'pending', service: 'api', asserts: [TCP_ASSERTS.connect] })
    expect(cellOf(first, PROBE_RULES.down)?.detail).toBe('no connection: ECONNREFUSED (failure 1 of 3 before it pages)')
    const third = normalizeTcpProbe([reading(down(), { fails: 3 }, { failAfter: 3 })], c, ctx())
    expect(third.firing.map((a) => [a.rule, a.severity, a.labels.instance, a.via[0].kind])).toEqual([['ProbeDown', 'page', 'pg', 'tcp-probe']])
    expect(cellOf(third, PROBE_RULES.down)?.state).toBe('firing')
    const ok = normalizeTcpProbe([reading(up())], c, ctx())
    expect(ok.resolved.map((a) => a.rule)).toEqual(['ProbeDown'])
    expect(cellOf(ok, PROBE_RULES.down)).toMatchObject({ state: 'ok', detail: 'TCP connect in 12ms' })
  })

  it('starts the streak again after a success, so failures apart never page', async () => {
    let attempts = 0
    const refusal = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    const connect: TcpConnector = async () => {
      attempts += 1
      if (attempts === 1 || attempts === 2 || attempts === 5 || attempts === 6) throw refusal
      return {}
    }
    const h = harness(cfg({}, { failAfter: 3 }), connect)
    for (let i = 0; i < 6; i += 1) await h.poll()
    expect(h.firing(PROBE_RULES.down)).toHaveLength(0)
    expect(h.cell(PROBE_RULES.down)?.state).toBe('pending')
  })
})

describe('ProbeSlow', () => {
  it('warns after failAfter slow connects in a row, leaves it alone on a failed connect, and one fast connect resolves it', () => {
    const c = cfg({}, { slowMs: 25, failAfter: 2 })
    const slow = (ms: number) => up({ ms, detail: `TCP connect in ${ms}ms` })
    const slowTarget = { slowMs: 25, failAfter: 2 }
    const pending = normalizeTcpProbe([reading(slow(40), { slows: 1 }, slowTarget)], c, ctx())
    expect(cellOf(pending, PROBE_RULES.slow)).toMatchObject({ state: 'pending', asserts: [TCP_ASSERTS.latency(25)] })
    const warned = normalizeTcpProbe([reading(slow(40), { slows: 2 }, slowTarget)], c, ctx())
    expect(warned.firing.map((a) => [a.rule, a.severity])).toEqual([['ProbeSlow', 'warning']])
    expect(cellOf(warned, PROBE_RULES.slow)?.detail).toBe('TCP connect in 40ms, over 25ms on 2 connects in a row')
    const failed = normalizeTcpProbe([reading(down(), { fails: 1, slows: null }, slowTarget)], c, ctx())
    expect(cellOf(failed, PROBE_RULES.slow)).toMatchObject({ state: 'nodata', detail: 'not timed: the connect failed' })
    expect(failed.firing.filter((a) => a.rule === 'ProbeSlow')).toEqual([])
    const fast = normalizeTcpProbe([reading(slow(5), { slows: 0 }, slowTarget)], c, ctx())
    expect(fast.resolved.filter((a) => a.rule === 'ProbeSlow').map((a) => a.severity)).toEqual(['warning'])
    expect(cellOf(fast, PROBE_RULES.slow)?.state).toBe('ok')
  })

  it('has no ProbeSlow cell for a target without slowMs, and no CertExpiring cell for a plain one', () => {
    const o = normalizeTcpProbe([reading(up())], cfg(), ctx())
    expect(o.checks?.cells.map((c) => c.checkId)).toEqual(['ProbeDown'])
    expect(o.checks?.complete).toBe(true)
  })
})

describe('CertExpiring', () => {
  const c = cfg({}, { tls: true })
  const tlsReading = (cert: TcpProbeResult['cert']) => reading(up({ cert }), {}, { tls: true })

  it('warns under certWarnDays, pages under certPageDays, and resolves the other tier', () => {
    const warn = normalizeTcpProbe([tlsReading({ ok: true, validToMs: T0 + 10 * DAY })], c, ctx())
    expect(warn.firing.map((a) => [a.rule, a.severity])).toEqual([['CertExpiring', 'warning']])
    expect(warn.resolved.filter((a) => a.rule === 'CertExpiring').map((a) => a.severity)).toEqual(['page'])
    expect(cellOf(warn, PROBE_RULES.cert)).toMatchObject({ state: 'firing', asserts: [TCP_ASSERTS.cert(3)] })
    expect(cellOf(warn, PROBE_RULES.cert)?.detail).toMatch(/^certificate expires in 10 days \(\d{4}-\d{2}-\d{2}\)$/)
    const page = normalizeTcpProbe([tlsReading({ ok: true, validToMs: T0 + 2 * DAY })], c, ctx())
    expect(page.firing.filter((a) => a.rule === 'CertExpiring').map((a) => a.severity)).toEqual(['page'])
    expect(page.resolved.filter((a) => a.rule === 'CertExpiring').map((a) => a.severity)).toEqual(['warning'])
    expect(cellOf(page, PROBE_RULES.cert)?.state).toBe('firing')
  })

  it('resolves both tiers with plenty of time left, and leaves them as they were when the certificate cannot be read', () => {
    const fine = normalizeTcpProbe([tlsReading({ ok: true, validToMs: T0 + 30 * DAY })], c, ctx())
    expect(fine.firing.filter((a) => a.rule === 'CertExpiring')).toEqual([])
    expect(fine.resolved.filter((a) => a.rule === 'CertExpiring').map((a) => a.severity)).toEqual(['page', 'warning'])
    expect(cellOf(fine, PROBE_RULES.cert)?.state).toBe('ok')
    const blind = normalizeTcpProbe([tlsReading({ ok: false, detail: 'ECONNRESET' })], c, ctx())
    expect(blind.firing.filter((a) => a.rule === 'CertExpiring')).toEqual([])
    expect(blind.resolved.filter((a) => a.rule === 'CertExpiring')).toEqual([])
    expect(cellOf(blind, PROBE_RULES.cert)).toMatchObject({ state: 'nodata', detail: 'certificate not read: ECONNRESET' })
  })

  it('takes its own warn and page days, and reflects the page day in the assertion', () => {
    const own = normalizeTcpProbe([tlsReading({ ok: true, validToMs: T0 + 5 * DAY })], cfg({}, { tls: true, certWarnDays: 30, certPageDays: 7 }), ctx())
    expect(own.firing.filter((a) => a.rule === 'CertExpiring').map((a) => a.severity)).toEqual(['warning'])
    // tlsReading carries only tls: true, so the reading's own target must name the days it is judged by.
    const called = normalizeTcpProbe([reading(up({ cert: { ok: true, validToMs: T0 + 5 * DAY } }), {}, { tls: true, certWarnDays: 30, certPageDays: 7 })], cfg({}, { tls: true }), ctx())
    expect(cellOf(called, PROBE_RULES.cert)?.asserts).toEqual(['tls:expires>7d'])
  })
})

// ---- the source and the engine ------------------------------------------------------------------------------------------------------------

function harness(c: TcpProbeSourceConfig, connect: TcpConnector) {
  const clock = { ms: T0 }
  const deps: SourceDeps = { fetch, env: {}, nowIso: () => new Date(clock.ms).toISOString(), serviceMap: [] }
  const watch: WatchConfig = {
    baseUrl: 'https://watch.test',
    port: 0,
    host: '127.0.0.1',
    dataDir: ':memory:',
    historyHours: 24,
    staleAfterMisses: 3,
    sources: [c],
    serviceMap: [],
    splitIncidents: [{ match: { origin: `^${c.id}$` }, by: 'instance' }],
    channels: [],
    routes: [],
    quietHours: null
  }
  const engine = new Engine(openDb(':memory:'), watch, () => clock.ms)
  const source = createTcpProbeSource(c, deps, connect)
  let last: Observation | null = null
  const poll = async (): Promise<Observation> => {
    const obs = await source.poll()
    last = obs
    engine.ingest(obs)
    engine.recordSource(source.id, true, null)
    clock.ms += 60_000
    return obs
  }
  const cell = (rule: string, id = 'pg'): RuleCell | undefined => last?.checks?.cells.find((x) => x.checkId === rule && x.name === id)
  const firing = (rule: string) => engine.wall().incidents.filter((i) => i.rule === rule)
  return { clock, engine, source, poll, cell, firing }
}

describe('the tcp-probe source', () => {
  it('polls itself, damps a refused connect to a page and resolves it, and never fails the poll', async () => {
    let attempts = 0
    const refusal = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    const connect: TcpConnector = async () => {
      attempts += 1
      if (attempts <= 3) throw refusal
      return {}
    }
    const h = harness(cfg({}, { failAfter: 3 }), connect)
    expect(h.source).toMatchObject({ id: 'ports', kind: 'tcp-probe', name: 'TCP probes', pollSec: 60 })
    await expect(h.poll()).resolves.toBeDefined()
    expect(h.cell(PROBE_RULES.down)?.state).toBe('pending')
    await h.poll()
    await h.poll()
    expect(h.firing(PROBE_RULES.down)).toHaveLength(1)
    expect(h.firing(PROBE_RULES.down)[0]).toMatchObject({ severity: 'page', service: 'Api', instance: 'pg' })
    const ok = await h.poll()
    expect(ok.resolved.map((a) => a.rule)).toContain('ProbeDown')
    expect(h.firing(PROBE_RULES.down)).toHaveLength(0)
    expect(h.engine.sources()[0]).toMatchObject({ id: 'ports', kind: 'tcp-probe', state: 'ok', misses: 0 })
  })
})

// ---- the config ---------------------------------------------------------------------------------------------------------------------------

describe('the tcp rule and the config', () => {
  const write = (source: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-tcp-cfg-'))
    const file = join(dir, 'watch.json')
    writeFileSync(file, JSON.stringify({ baseUrl: 'https://watch.test', port: 0, host: '127.0.0.1', dataDir: ':memory:', historyHours: 24, staleAfterMisses: 3, sources: [source], serviceMap: [], channels: [], routes: [], quietHours: null }))
    return file
  }
  const probe = (over: Record<string, unknown> = {}, t: Record<string, unknown> = {}) => ({ id: 'ports', type: 'tcp-probe', targets: [{ id: 'pg', service: 'api', host: '127.0.0.1', port: 5432, ...t }], ...over })

  it('takes the shape with its defaults, and the registry starts it at 60 s', () => {
    const loaded = loadConfig(write(probe()))
    const built = POLLED['tcp-probe']?.(loaded.sources[0], { fetch, env: {}, nowIso: () => new Date(T0).toISOString(), serviceMap: [] }, { loadNodes: [] })
    expect(built?.source).toMatchObject({ id: 'ports', kind: 'tcp-probe', pollSec: 60 })
    expect(TCP_PROBE_DEFAULTS).toEqual({ pollSec: 60, failAfter: 3, timeoutMs: 10_000, certWarnDays: 14, certPageDays: 3 })
    const ipv6 = loadConfig(write(probe({}, { host: '[::1]' })))
    expect(ipv6.sources).toHaveLength(1)
    expect([...configServiceNames(loadConfig(write(probe())))].sort()).toContain('api')
  })

  it('refuses what it cannot connect to safely, naming the field', () => {
    const bad: Array<[unknown, RegExp]> = [
      [probe({ targets: [] }), /needs targets/],
      [probe({}, { host: 'http://127.0.0.1' }), /host must be a hostname or IP address/],
      [probe({}, { host: 'example.com:5432' }), /host must be a hostname or IP address/],
      [probe({}, { host: 'exa mple.test' }), /host must be a hostname or IP address/],
      [probe({}, { port: 0 }), /port must be a whole number from 1 to 65535/],
      [probe({}, { port: 70_000 }), /port must be a whole number from 1 to 65535/],
      [probe({}, { tls: 'yes' }), /tls must be true or false/],
      [probe({}, { timeoutMs: 50 }), /timeoutMs must be a whole number of ms from 100 to 60000/],
      [probe({}, { slowMs: 10_000 }), /slowMs must be a number of ms above 0 and under timeoutMs/],
      [probe({}, { failAfter: 0 }), /failAfter must be a whole number of polls from 1 to 20/],
      [probe({}, { certWarnDays: 14 }), /certWarnDays and certPageDays are only for a tls target/],
      [probe({}, { tls: true, certWarnDays: 2, certPageDays: 3 }), /certPageDays must be 0 or more and at most certWarnDays/],
      [probe({}, { id: 'has space' }), /targets\[0\]\.id must be letters/],
      [probe({}, { service: '' }), /service must name the wall tile/],
      [probe({ pollSec: 0 }), /pollSec must be a number of seconds above 0/],
      [{ ...probe(), targets: [{ id: 'a', service: 'S', host: '127.0.0.1', port: 1 }, { id: 'a', service: 'S', host: '127.0.0.1', port: 2 }] }, /targets\[1\]\.id a is used twice/]
    ]
    for (const [source, message] of bad) expect(() => loadConfig(write(source)), JSON.stringify(source)).toThrow(message)
  })
})
