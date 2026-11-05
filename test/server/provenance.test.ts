// Gate provenance: what a probe cell asserts, where a source says its endpoint was found, and the four doctor codes built on them.
//
// The hole this file guards first: a bare-200 http-probe target and an expectJson target used to produce byte-identical RuleCells (same keys, same
// state, same detail), so neither the wall nor doctor could tell a probe that proves a dependency from one that proves only that a process answered.
// The fix is one vocabulary (`RuleCell.asserts`, written by `probeAssertions`) that the cell, the source count (`SourceStatus.asserted`) and the
// negative run (`proveProbe`, which mutates a recorded answer instead of asking the target again) all read.
import { beforeAll, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { validateConfig } from '../../src/server/config.ts'
import type { HttpProbeSourceConfig, HttpProbeTargetConfig, WatchConfig } from '../../src/server/config.ts'
import { openDb } from '../../src/server/db.ts'
import { Engine } from '../../src/server/engine.ts'
import { parseChecks } from '../../src/server/sources/checks.ts'
import { BadPayload } from '../../src/server/sources/shared.ts'
import type { ProbeResult } from '../../src/server/sources/http-probe.ts'
import { createHttpProbeSource, evaluateProbe, isSelfProbe, normalizeHttpProbe, probeAssertions, proveProbe } from '../../src/server/sources/http-probe.ts'
import type { SourceDeps } from '../../src/server/sources/types.ts'
import type { ProbeAnswer } from '../../src/shared/types.ts'
import type { SourceStatus } from '../../src/shared/types.ts'
import { Sources } from '../../src/web/views/Sources.tsx'

const T0 = Date.parse('2026-11-04T12:00:00Z')
const iso = (ms = T0): string => new Date(ms).toISOString()

const target = (over: Partial<HttpProbeTargetConfig> = {}): HttpProbeTargetConfig => ({ id: 'api', url: 'http://127.0.0.1:3000/healthz', ...over })
const probeCfg = (over: Partial<HttpProbeSourceConfig> = {}): HttpProbeSourceConfig => ({ id: 'probe', type: 'http-probe', pollSec: 60, targets: [target()], ...over })

const probe = (t: HttpProbeTargetConfig): ProbeResult => ({ ok: true, status: 200, ms: 12, detail: 'HTTP 200 in 12ms', asserts: probeAssertions(t) })

const cellsOf = (cfg: HttpProbeSourceConfig, t: HttpProbeTargetConfig): Record<string, unknown> => {
  const obs = normalizeHttpProbe([{ target: t, probe: probe(t), fails: 0, slows: null, cert: null }], cfg, { nowIso: iso(), serviceMap: [] })
  const cell = obs.checks?.cells.find((c) => c.checkId === 'ProbeDown')
  if (!cell) throw new Error('no ProbeDown cell')
  return JSON.parse(JSON.stringify(cell)) as Record<string, unknown>
}

const watchCfg = (source: HttpProbeSourceConfig, over: Partial<WatchConfig> = {}): WatchConfig => ({
  baseUrl: 'http://127.0.0.1:7717',
  port: 7717,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [source],
  serviceMap: [],
  channels: [],
  routes: [],
  quietHours: null,
  ...over
})

const deps = (answer: { status: number; body: string }): SourceDeps => ({
  fetch: (async () => new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
  env: {},
  nowIso: () => iso(),
  serviceMap: []
})

const engineFor = (source: HttpProbeSourceConfig, over: Partial<WatchConfig> = {}): Engine => new Engine(openDb(':memory:'), watchCfg(source, over), () => T0)

const checkOf = (engine: Engine, code: string): { code: string; status: string; message: string; next?: string } | undefined => engine.doctor().checks.find((c) => c.code === code)

describe('RuleCell.asserts: a bare 200 and an asserting target no longer make the same cell', () => {
  it('writes every predicate in words, the status one first', () => {
    expect(probeAssertions(target())).toEqual(['status 200'])
    expect(probeAssertions(target({ expectStatus: 204 }))).toEqual(['status 204'])
    expect(probeAssertions(target({ expectJson: { ok: true, 'db.kind': 'postgres' } }))).toEqual(['status 200', 'body.ok = true', 'body.db.kind = "postgres"'])
  })

  it('makes the two cells differ by exactly the assertions', () => {
    const bareCfg = probeCfg()
    const assertingCfg = probeCfg({ targets: [target({ expectJson: { ok: true } })] })
    const bare = cellsOf(bareCfg, bareCfg.targets[0])
    const asserting = cellsOf(assertingCfg, assertingCfg.targets[0])
    expect(bare.asserts).toEqual(['status 200'])
    expect(asserting.asserts).toEqual(['status 200', 'body.ok = true'])
    // everything else the two cells say is the same: the assertions are the whole difference the wall and the doctor read
    const withoutAsserts = ({ asserts: _a, ...rest }: Record<string, unknown>): Record<string, unknown> => rest
    expect(withoutAsserts(bare)).toEqual(withoutAsserts(asserting))
  })

  it('lands a target with no service on the source id tile', () => {
    const cfg = probeCfg()
    const cell = cellsOf(cfg, cfg.targets[0])
    expect(cell.service).toBe('probe')
    const listed = probeCfg({ targets: [target({ service: 'api prod' })] })
    expect(cellsOf(listed, listed.targets[0]).service).toBe('api prod')
  })
})

describe('evaluateProbe and proveProbe: the negative run on a recorded answer', () => {
  const good: ProbeAnswer = { status: 200, headers: {}, bodyText: '{"ok":true,"db":{"kind":"postgres"}}' }

  it('judges the answer with no clock and no network', () => {
    const t = target({ expectJson: { ok: true, 'db.kind': 'postgres' } })
    expect(evaluateProbe(t, good)).toMatchObject({ ok: true, asserts: ['status 200', 'body.ok = true', 'body.db.kind = "postgres"'], failed: [] })
    expect(evaluateProbe(t, { ...good, status: 503 })).toMatchObject({ ok: false, failed: ['status 200'], detail: ', expected 200' })
    expect(evaluateProbe(t, { ...good, status: 302 }).detail).toBe(' (a redirect, not followed), expected 200')
    expect(evaluateProbe(t, { ...good, bodyText: '{"ok":false,"db":{"kind":"postgres"}}' })).toMatchObject({ ok: false, failed: ['body.ok = true'] })
    expect(evaluateProbe(t, { ...good, bodyText: '{"ok":true,"db":{"kind":"pglite"}}' }).detail).toBe(', but db.kind is "pglite", expected "postgres"')
    expect(evaluateProbe(t, { ...good, bodyText: 'not json' }).detail).toBe(', but the body is not JSON')
    expect(evaluateProbe(t, { ...good, bodyText: null }).detail).toBe(', but the body is over 1 MiB')
  })

  it('turns each declared predicate red by mutating the recorded answer', () => {
    const t = target({ expectJson: { ok: true } })
    const proof = proveProbe(t, good)
    expect(proof.red).toBe(true)
    const byBody = proof.runs.find((r) => r.mutation === 'body.ok = false')
    expect(byBody).toMatchObject({ ok: false, failed: ['body.ok = true'] })
    expect(proof.runs.find((r) => r.mutation === 'status 503')?.ok).toBe(false)
  })

  it('proves a bare 200 by the status alone, which is why it is a separate (weaker) signal', () => {
    const proof = proveProbe(target(), good)
    expect(proof.red).toBe(true)
    expect(proof.runs.map((r) => r.mutation)).toEqual(['status 503'])
  })

  it('proves nothing without a recorded answer: there is no negative run', () => {
    expect(proveProbe(target({ expectJson: { ok: true } }), null)).toEqual({ red: false, runs: [] })
  })

  it('does not count a body assertion the recorded answer cannot be mutated at (the config changed since the poll)', () => {
    const t = target({ expectJson: { ok: true, 'db.region': 'eu' } })
    const proof = proveProbe(t, good)
    expect(proof.red).toBe(false)
    expect(proof.runs.find((r) => r.mutation === 'body.db.region = "eu?"')).toMatchObject({ ok: true, failed: [] })
  })
})

describe('parseChecks keeps the sender assertions', () => {
  const ctx = { origin: 'api-uptime', source: 'webhook', now: iso() }
  const one = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'ProbeDown', instance: 'api-rooms', service: 'Uptime', state: 'ok', ...over })

  it('carries asserts onto the cell', () => {
    const push = parseChecks({ list: [one({ asserts: ['status 200', 'body.ok = true'] })] }, ctx)
    expect(push.cells[0].asserts).toEqual(['status 200', 'body.ok = true'])
    expect(parseChecks({ list: [one()] }, ctx).cells[0].asserts).toBeUndefined()
  })

  it('refuses a list that is not a list of one-line strings', () => {
    expect(() => parseChecks({ list: [one({ asserts: 'status 200' })] }, ctx)).toThrow(BadPayload)
    expect(() => parseChecks({ list: [one({ asserts: [''] })] }, ctx)).toThrow(BadPayload)
    expect(() => parseChecks({ list: [one({ asserts: [1] })] }, ctx)).toThrow(BadPayload)
  })
})

describe('config: discovered and the default service', () => {
  const raw = (): Record<string, unknown> => ({
    baseUrl: 'http://127.0.0.1:7717',
    dataDir: '.watcher/data',
    historyHours: 24,
    staleAfterMisses: 3,
    sources: [{ id: 'probe', type: 'http-probe', targets: [{ id: 'api', url: 'http://127.0.0.1:3000/healthz' }] }],
    serviceMap: [],
    channels: [],
    routes: [],
    quietHours: null
  })
  const withSource = (patch: Record<string, unknown>): unknown => {
    const c = raw()
    Object.assign((c.sources as Array<Record<string, unknown>>)[0], patch)
    return c
  }

  it('accepts a target with no service (it lands on the source id) and still refuses an empty one', () => {
    expect(validateConfig(raw())).toMatchObject({ ok: true })
    expect(validateConfig(withSource({ targets: [{ id: 'api', url: 'http://127.0.0.1:3000/healthz', service: '' }] }))).toMatchObject({ ok: false })
  })

  it('validates discovered: foundAt is required and one line, read one line, at an ISO time', () => {
    const ok = { foundAt: 'src/server.ts:42', read: 'GET /healthz returns {"status":"ok"}', at: iso() }
    expect(validateConfig(withSource({ discovered: ok }))).toMatchObject({ ok: true })
    expect(validateConfig(withSource({ discovered: {} }))).toMatchObject({ ok: false })
    expect(validateConfig(withSource({ discovered: { foundAt: 'a\nb' } }))).toMatchObject({ ok: false })
    expect(validateConfig(withSource({ discovered: { foundAt: 'a', read: '' } }))).toMatchObject({ ok: false })
    expect(validateConfig(withSource({ discovered: { foundAt: 'a', at: 'yesterday' } }))).toMatchObject({ ok: false })
    expect(validateConfig(withSource({ discovered: 'src/server.ts' }))).toMatchObject({ ok: false })
  })

  it('accepts discovered on tcp-probe, heartbeat and domain-expiry too, and refuses a malformed one there', () => {
    const base = { ...raw(), sources: [] as unknown[] }
    for (const s of [
      { id: 'pg', type: 'tcp-probe', targets: [{ id: 'pg', service: 'postgres', host: '127.0.0.1', port: 5432 }] },
      { id: 'nightly', type: 'heartbeat', every: '1d', tokenEnv: 'NIGHTLY_TOKEN' },
      { id: 'domains', type: 'domain-expiry', domains: ['example.com'] }
    ]) {
      expect(validateConfig({ ...base, sources: [{ ...s, discovered: { foundAt: 'src/server.ts:42' } }] })).toMatchObject({ ok: true })
      expect(validateConfig({ ...base, sources: [{ ...s, discovered: {} }] })).toMatchObject({ ok: false })
    }
  })

  it('caps expectJson so a cell never carries more assertions than a check list takes', () => {
    const paths = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, true]))
    expect(validateConfig(withSource({ targets: [{ id: 'api', url: 'http://127.0.0.1:3000/healthz', expectJson: paths }] }))).toMatchObject({ ok: false })
    const nineteen = Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`p${i}`, true]))
    expect(validateConfig(withSource({ targets: [{ id: 'api', url: 'http://127.0.0.1:3000/healthz', expectJson: nineteen }] }))).toMatchObject({ ok: true })
  })
})

describe('SourceStatus.asserted: only the cells that assert more than a 200', () => {
  it('counts the asserting cells and leaves a bare source at 0', async () => {
    const bareSrc = createHttpProbeSource(probeCfg(), deps({ status: 200, body: 'ok' }))
    const bareEngine = engineFor(probeCfg())
    bareEngine.ingest(await bareSrc.poll())
    expect(bareEngine.sources()[0]).toMatchObject({ rules: 1, asserted: 0 })

    const assertingCfg = probeCfg({ targets: [target({ expectJson: { ok: true } })] })
    const src = createHttpProbeSource(assertingCfg, deps({ status: 200, body: '{"ok":true}' }))
    const engine = engineFor(assertingCfg)
    engine.ingest(await src.poll())
    expect(engine.sources()[0]).toMatchObject({ rules: 1, asserted: 1 })
  })

  it('reaches /api/state with discovered, so doctor --live can read both', async () => {
    const cfg = probeCfg({ targets: [target({ expectJson: { ok: true } })], discovered: { foundAt: 'src/server.ts:42', read: 'GET /healthz' } })
    const engine = engineFor(cfg)
    engine.ingest(await createHttpProbeSource(cfg, deps({ status: 200, body: '{"ok":true}' })).poll())
    const state = engine.wall()
    expect(state.sources[0]).toMatchObject({ asserted: 1, discovered: { foundAt: 'src/server.ts:42', read: 'GET /healthz' } })
  })
})

describe('Engine.doctor: the four provenance codes', () => {
  it('warns on a bare, untraced source that has never shown an assertion going red', () => {
    const cfg = probeCfg()
    // a bare target has no assertion beyond the status, so the prove check does not speak for it at all
    const engine = engineFor(cfg)
    const report = engine.doctor()
    expect(checkOf(engine, 'source.untraced')).toMatchObject({ status: 'warn' })
    expect(checkOf(engine, 'source.bare-200')).toMatchObject({ status: 'warn' })
    expect(report.checks.some((c) => c.code === 'source.assertion-not-red')).toBe(false)
    expect(report.ok).toBe(true)
    expect(report.observations).toEqual([])
  })

  it('fails an asserting target before its first good answer, then passes it once one is recorded', async () => {
    const cfg = probeCfg({ targets: [target({ expectJson: { ok: true } })], discovered: { foundAt: 'src/server.ts:42' } })
    const engine = engineFor(cfg)
    expect(checkOf(engine, 'source.assertion-not-red')).toMatchObject({ status: 'fail' })
    expect(engine.doctor().ok).toBe(false)

    const src = createHttpProbeSource(cfg, deps({ status: 200, body: '{"ok":true}' }))
    engine.ingest(await src.poll())
    expect(checkOf(engine, 'source.assertion-not-red')).toMatchObject({ status: 'pass' })
    expect(checkOf(engine, 'source.bare-200')).toMatchObject({ status: 'pass' })
    expect(checkOf(engine, 'source.untraced')).toMatchObject({ status: 'pass' })
    expect(engine.doctor().ok).toBe(true)
    // the recorded answer travels with the report, so the CLI can mutate it offline instead of asking the target again
    expect(engine.doctor().observations).toMatchObject([{ source: 'probe', target: 'api', status: 200, bodyText: '{"ok":true}' }])
  })

  it('covers the other kinds that carry discovered, so tcp-probe, heartbeat and domain-expiry warn untraced until they record where it came from', () => {
    const sources: WatchConfig['sources'] = [
      { id: 'pg', type: 'tcp-probe', targets: [{ id: 'pg', service: 'postgres', host: '127.0.0.1', port: 5432 }] },
      { id: 'nightly', type: 'heartbeat', every: '1d', tokenEnv: 'NIGHTLY_TOKEN' },
      { id: 'domains', type: 'domain-expiry', domains: ['example.com'] }
    ]
    const engine = (srcs: WatchConfig['sources']): Engine => new Engine(openDb(':memory:'), watchCfg(probeCfg(), { sources: srcs }), () => T0)
    const untraced = engine(sources).doctor().checks.filter((c) => c.code === 'source.untraced')
    expect(untraced.map((c) => c.status)).toEqual(['warn', 'warn', 'warn'])
    expect(untraced.map((c) => c.next)).toEqual([
      'watcher add tcp-probe --id pg --found-at <file:line>',
      'watcher add heartbeat --id nightly --found-at <file:line>',
      'watcher add domain-expiry --id domains --found-at <file:line>'
    ])
    const traced = engine(sources.map((s) => ({ ...s, discovered: { foundAt: 'src/server.ts:42' } })))
    expect(traced.doctor().checks.filter((c) => c.code === 'source.untraced').map((c) => c.status)).toEqual(['pass', 'pass', 'pass'])
  })

  it('warns on a probe that points at the Watcher itself', () => {
    const selfCfg = probeCfg({ targets: [target({ url: 'http://127.0.0.1:7717/healthz', expectJson: { ok: true } })] })
    const engine = engineFor(selfCfg)
    expect(checkOf(engine, 'source.self-probe')).toMatchObject({ status: 'warn' })
    const other = engineFor(probeCfg())
    expect(checkOf(other, 'source.self-probe')).toBeUndefined()
  })
})

describe('isSelfProbe', () => {
  it('matches the port on a loopback name, the bound host, or the public base URL', () => {
    expect(isSelfProbe('http://127.0.0.1:7717/healthz', { port: 7717 })).toBe(true)
    expect(isSelfProbe('http://localhost:7717/healthz', { port: 7717 })).toBe(true)
    expect(isSelfProbe('http://127.0.0.1:3000/healthz', { port: 7717 })).toBe(false)
    expect(isSelfProbe('http://192.0.2.9:7717/healthz', { port: 7717, host: '192.0.2.9' })).toBe(true)
    expect(isSelfProbe('https://watch.example.com/healthz', { port: 7717, baseUrl: 'https://watch.example.com' })).toBe(true)
    expect(isSelfProbe('not a url', { port: 7717 })).toBe(false)
  })
})

describe('the Sources page', () => {
  // The webhook section prints the browser's own origin; a node renderer has no location.
  beforeAll(() => {
    Object.defineProperty(globalThis, 'location', { value: { origin: 'https://watch.example.com' }, configurable: true })
  })
  const src = (over: Partial<SourceStatus>): SourceStatus => ({ id: 'probe', kind: 'http-probe', name: 'probe', state: 'ok', lastOk: iso(), lastAttempt: iso(), error: null, firing: 0, rules: 2, misses: 0, ...over })
  const render = (s: SourceStatus): string =>
    renderToStaticMarkup(createElement(Sources, { state: { generatedAt: iso(), header: {}, sources: [s], incidents: [], health: [], channels: [] } as never, nowMs: T0 }))

  it('marks a source whose cells assert nothing unverified, and a traced one with where its endpoint was found', () => {
    const html = render(src({ asserted: 0, discovered: { foundAt: 'src/server.ts:42' } }))
    expect(html).toContain('unverified')
    expect(html).toContain('traced')
    expect(html).toContain('src/server.ts:42')
  })

  it('shows neither badge on a source that asserts, and shows no badge for a server that sends no asserted count', () => {
    expect(render(src({ asserted: 2 }))).not.toContain('unverified')
    expect(render(src({}))).not.toContain('unverified')
  })

  it('marks unverified only for the kinds that carry assertions, never a rule list or a pushed webhook', () => {
    for (const kind of ['http-probe', 'tcp-probe', 'heartbeat', 'domain-expiry', 'host'] as const) {
      expect(render(src({ kind, asserted: 0 }))).toContain('unverified')
    }
    for (const kind of ['grafana', 'netdata-cloud', 'webhook', 'sentry'] as const) {
      expect(render(src({ kind, asserted: 0 }))).not.toContain('unverified')
    }
  })

  it('says "1 rule", not "1 rules"', () => {
    expect(render(src({ rules: 1 }))).toContain('1 rule,')
    expect(render(src({ rules: 2 }))).toContain('2 rules,')
  })
})
