// The fix loop, server side: the brief `get_fix_context` answers, the awaited `verify_fix`, and the two routes that carry them
// to the CLI. An in-memory engine and a fake polled source stand in for the wall and the network; every assertion is about what
// an agent reads and what the engine records, never about a payload that is not there.
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.ts'
import type { AppDeps } from '../../src/server/app.ts'
import type { WatchConfig } from '../../src/server/config.ts'
import { makeAlert } from '../../src/server/derive.ts'
import { openDb } from '../../src/server/db.ts'
import { Engine } from '../../src/server/engine.ts'
import { PollRunner, createRechecker } from '../../src/server/recheck.ts'
import type { Rechecker } from '../../src/server/recheck.ts'
import type { PolledSource } from '../../src/server/sources/types.ts'
import { SqlitePushStore } from '../../src/server/stores.ts'
import { TOOLS } from '../../src/server/mcp/tools.ts'
import type { McpDeps } from '../../src/server/mcp/tools.ts'
import { failingAssertionWords, fixContextOf, jqPath, shellQuote, verifyFix } from '../../src/server/mcp/fix-context.ts'
import type { Alert, Observation, ProbeObservation, RuleCell } from '../../src/shared/types.ts'

const T0 = Date.parse('2026-11-04T12:00:00Z')
let clock = T0
const iso = (ms = clock): string => new Date(ms).toISOString()

const cfg: WatchConfig = {
  baseUrl: 'https://watch.test',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [
    {
      id: 'probe',
      type: 'http-probe',
      pollSec: 60,
      targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz', expectStatus: 200, expectJson: { ok: true }, timeoutMs: 10_000 }],
      discovered: { foundAt: 'src/server.ts:42', read: 'GET /healthz answers {"ok":true}', at: iso() }
    },
    { id: 'hook', type: 'webhook', tokenEnv: 'HOOK_TOKEN', verify: { scheme: 'hmac-sha256', secretEnv: 'HOOK_SECRET', header: 'x-hub-signature-256' } },
    {
      id: 'sentry',
      type: 'sentry',
      url: 'https://sentry.example.com',
      webUrl: 'https://examples.sentry.io',
      org: 'example',
      tokenEnv: 'SENTRY_TOKEN',
      pollSec: 300,
      projects: { 'acme-server': 'api' }
    }
  ],
  serviceMap: [],
  channels: [],
  routes: [],
  quietHours: null
}

const PROBE_DETAIL = 'HTTP 503 in 12ms, expected 200'

const probeAlert = (fingerprint = 'a1b2c3d4e5f60718', detail = PROBE_DETAIL): Alert =>
  makeAlert(
    {
      origin: 'probe',
      fingerprint,
      rule: 'ProbeDown',
      labels: { alertname: 'ProbeDown', severity: 'page', service: 'api', instance: 'api', host: 'api-1' },
      annotations: { summary: `api is down: ${detail}` },
      startsAt: iso(clock - 600_000),
      value: detail,
      via: { source: 'probe', kind: 'http-probe', lastSeen: iso() },
      raw: { target: 'api', url: 'https://api.example.com/healthz', probe: { ok: false, status: 503, ms: 12, detail, asserts: ['status 200', 'body.ok = true'] } },
      links: { generator: 'https://api.example.com/healthz' }
    },
    [],
    iso(clock - 600_000)
  )

const otherAlert = (): Alert =>
  makeAlert(
    {
      origin: 'hook',
      fingerprint: '0102030405060708',
      rule: 'QueueDepth',
      labels: { alertname: 'QueueDepth', severity: 'warning', service: 'api', host: 'queue-1' },
      annotations: { summary: 'queue is deep' },
      startsAt: iso(clock - 120_000),
      via: { source: 'hook', kind: 'webhook', lastSeen: iso() },
      raw: {},
      links: {}
    },
    [],
    iso(clock - 120_000)
  )

const sentryAlert = (): Alert =>
  makeAlert(
    {
      origin: 'sentry',
      fingerprint: '1112131415161718',
      rule: 'SentryNewIssue',
      labels: { alertname: 'SentryNewIssue', severity: 'warning', service: 'api', project: 'acme-server' },
      annotations: { summary: 'TypeError in handleRequest' },
      startsAt: iso(clock - 60_000),
      via: { source: 'sentry', kind: 'sentry', lastSeen: iso() },
      generatorURL: 'https://examples.sentry.io/issues/123',
      raw: {
        id: '123',
        shortId: 'API-1',
        title: 'TypeError: cannot read properties of undefined',
        culprit: 'app/handlers.ts in handleRequest',
        status: 'unresolved',
        count: 42,
        userCount: 7,
        permalink: 'https://examples.sentry.io/issues/123'
      },
      links: { generator: 'https://examples.sentry.io/issues/123' }
    },
    [],
    iso(clock - 60_000)
  )

const cell: RuleCell = {
  id: 'ProbeDown',
  source: 'probe',
  name: 'ProbeDown',
  service: 'Api',
  state: 'firing',
  detail: `${PROBE_DETAIL} (3 failed polls in a row)`,
  asserts: ['status 200', 'body.ok = true']
}

const goodProbe: ProbeObservation = {
  source: 'probe',
  target: 'api',
  at: iso(clock - 700_000),
  status: 200,
  headers: { 'content-type': 'application/json', server: 'nginx' },
  bodyText: '{"ok":true,"db":{"ok":true}}'
}

const watching = (firing: Alert[], extra: Partial<Observation> = {}): Observation => ({
  source: firing[0]?.via[0]?.source ?? 'probe',
  kind: firing[0]?.via[0]?.kind ?? 'http-probe',
  at: iso(),
  firing,
  resolved: [],
  complete: true,
  ...extra
})

let engine: Engine
beforeEach(() => {
  clock = T0
  engine = new Engine(openDb(':memory:'), cfg, () => clock)
})

function fireProbe(opts: { withHook?: boolean } = {}): string {
  const alert = probeAlert()
  // With `withHook` the same alert is also pushed through the webhook source, so the brief names both sources (and both
  // credential env names). Without it, the probe is the only presence, so a complete poll that omits the alert resolves it.
  if (opts.withHook) alert.via.push({ source: 'hook', kind: 'webhook', lastSeen: iso() })
  engine.ingest(watching([alert], { rules: [cell], probes: [goodProbe] }))
  if (opts.withHook) engine.ingest({ source: 'hook', kind: 'webhook', at: iso(), firing: [alert], resolved: [], complete: false })
  return engine.wall().incidents.find((i) => i.rule === 'ProbeDown')!.key
}

function deps(recheck?: Rechecker): McpDeps {
  return { engine, db: engine.db, cfg, nowMs: () => clock, recheck, nudge: () => undefined, log: () => undefined }
}

function tool(name: string) {
  const spec = TOOLS.find((t) => t.name === name)
  if (!spec) throw new Error(`no tool ${name}`)
  return spec
}

function fakeSource(answer: () => Alert[], rules: () => RuleCell[] = () => [cell]): PolledSource {
  return {
    id: 'probe',
    kind: 'http-probe',
    name: 'probe',
    pollSec: 60,
    async poll(): Promise<Observation> {
      return { source: 'probe', kind: 'http-probe', at: iso(), firing: answer(), resolved: [], complete: true, rules: rules() }
    }
  }
}

const greenCell = (): RuleCell => ({ ...cell, state: 'ok', detail: 'HTTP 200 in 9ms' })

function rechecker(source: PolledSource): Rechecker {
  const runner = new PollRunner(engine, () => undefined, () => clock)
  return createRechecker({ engine, cfg, runner, sources: [source], nudge: () => undefined, nowMs: () => clock })
}

describe('get_fix_context', () => {
  it('answers the incident, the source and target config (env names, never values), the assertions and which failed, the observations, the reproduce command, related incidents and next', () => {
    const saved = process.env.HOOK_TOKEN
    process.env.HOOK_TOKEN = 'hook-secret-value-never-in-a-brief'
    try {
      const key = fireProbe({ withHook: true })
      engine.ingest({ source: 'hook', kind: 'webhook', at: iso(), firing: [otherAlert()], resolved: [], complete: false })
      const r = fixContextOf(key, { engine, cfg, nowMs: () => clock })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const b = r.brief
      expect(b).toMatchObject({ key, title: 'ProbeDown', service: 'Api', rule: 'ProbeDown', severity: 'page', state: { firing: true, attention: 'none' } })
      expect(b.firstSeen).toBe(iso())
      expect(b.lastSeen).toBe(iso())
      expect(b.sources.map((s) => s.id)).toEqual(expect.arrayContaining(['probe', 'hook']))
      const probe = b.sources.find((s) => s.id === 'probe')!
      expect(probe.kind).toBe('http-probe')
      expect(probe.target).toMatchObject({ id: 'api', url: 'https://api.example.com/healthz', expectStatus: 200 })
      expect(probe.discovered).toMatchObject({ foundAt: 'src/server.ts:42', read: 'GET /healthz answers {"ok":true}' })
      const hook = b.sources.find((s) => s.id === 'hook')!
      expect(hook.config).toMatchObject({ tokenEnv: 'HOOK_TOKEN', verify: { secretEnv: 'HOOK_SECRET' } })
      expect(JSON.stringify(b)).toContain('HOOK_TOKEN')
      expect(JSON.stringify(b)).toContain('HOOK_SECRET')
      expect(JSON.stringify(b)).not.toContain('hook-secret-value-never-in-a-brief')

      expect(b.asserts[0]).toMatchObject({ cell: 'ProbeDown', state: 'firing', asserts: ['status 200', 'body.ok = true'] })
      expect(b.asserts[0].failed).toContain('status 200')
      expect(b.asserts[0].failureDetail).toContain('expected 200')

      expect(b.observations.lastGood).toMatchObject({ status: 200, body: '{"ok":true,"db":{"ok":true}}' })
      expect(b.observations.lastBad.status).toBe(503)
      expect(b.observations.lastBad.detail).toContain('HTTP 503')

      expect(b.reproduce.command).toContain('curl -sS')
      expect(b.reproduce.command).toContain("jq '.ok'")
      expect(b.reproduce.expect).toBe('true')
      expect(b.reproduce.alternatives.some((a) => a.label === 'status' && a.expect === '200')).toBe(true)
      expect(b.reproduce.watcher).toContain('watcher recheck')
      expect(b.reproduce.watcher).toContain('--wait')

      expect(b.related.map((x) => x.key)).toEqual([expect.stringContaining('QueueDepth')])
      expect(b.evidence.some((e) => e.url === 'https://api.example.com/healthz')).toBe(true)
      expect(b.next.map((n) => n.action)).toEqual(['fix', 'restart-or-deploy', 'verify'])
      expect(b.next[2].detail).toContain('verify_fix')
      expect(b.next[2].detail).toContain('verified by agent')
    } finally {
      if (saved === undefined) delete process.env.HOOK_TOKEN
      else process.env.HOOK_TOKEN = saved
    }
  })

  it('drops a literal value typed where a config only names its env var', () => {
    const inline = ['placeholder', 'value', '123'].join('-')
    const leakySource: Record<string, unknown> = { id: 'leaky', type: 'webhook', tokenEnv: 'LEAKY_TOKEN' }
    leakySource['tok' + 'en'] = inline
    const leaky = { ...cfg, sources: [...cfg.sources, leakySource] } as WatchConfig
    const alert = makeAlert(
      {
        origin: 'leaky',
        fingerprint: '2223242526272829',
        rule: 'QueueDepth',
        labels: { alertname: 'QueueDepth', severity: 'warning', service: 'api' },
        annotations: { summary: 'queue is deep' },
        startsAt: iso(clock - 60_000),
        via: { source: 'leaky', kind: 'webhook', lastSeen: iso() },
        raw: {},
        links: {}
      },
      [],
      iso(clock - 60_000)
    )
    engine.ingest({ source: 'leaky', kind: 'webhook', at: iso(), firing: [alert], resolved: [], complete: false })
    const key = engine.wall().incidents.find((i) => i.rule === 'QueueDepth' && i.alerts[0]?.origin === 'leaky')!.key
    const r = fixContextOf(key, { engine, cfg: leaky, nowMs: () => clock })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const text = JSON.stringify(r.brief)
    expect(text).toContain('LEAKY_TOKEN')
    expect(text).not.toContain(inline)
  })

  it('answers a Sentry issue with the permalink, the culprit, and a curl that re-reads the issue without printing the token', () => {
    engine.ingest(watching([sentryAlert()]))
    const key = engine.wall().incidents.find((i) => i.rule === 'SentryNewIssue')!.key
    const r = fixContextOf(key, { engine, cfg, nowMs: () => clock })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.brief.sourceEvidence).toMatchObject({ kind: 'sentry', permalink: 'https://examples.sentry.io/issues/123', culprit: 'app/handlers.ts in handleRequest', issueId: '123' })
    expect(r.brief.reproduce.command).toContain('$SENTRY_TOKEN')
    expect(r.brief.reproduce.command).toContain('is:unresolved')
    expect(r.brief.reproduce.command).toContain('"123"')
    expect(JSON.stringify(r.brief)).not.toContain('secret')
  })

  it('refuses a key the Watcher never held and points at the listing tools', () => {
    const r = fixContextOf('No|Such', { engine, cfg, nowMs: () => clock })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('watch_state')
  })
})

describe('the MCP tools', () => {
  it('get_fix_context is a read tool with no by, and answers the brief', async () => {
    const key = fireProbe()
    expect(tool('get_fix_context').hints.readOnlyHint).toBe(true)
    expect(Object.keys(tool('get_fix_context').shape)).toEqual(['key'])
    const r = await tool('get_fix_context').run(deps(), { key })
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.data as { key: string }).key).toBe(key)
    const bad = await tool('get_fix_context').run(deps(), { key: 'No|Such' })
    expect(bad.ok).toBe(false)
  })

  it('verify_fix is a write tool: it needs by, re-checks, and on a green answer confirms with "verified by agent"', async () => {
    const key = fireProbe()
    expect(tool('verify_fix').hints).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true })
    expect(Object.keys(tool('verify_fix').shape)).toEqual(['key', 'by', 'timeoutSec'])
    expect((await tool('verify_fix').run(deps(rechecker(fakeSource(() => []))), { key })).ok).toBe(false)
    const r = await tool('verify_fix').run(deps(rechecker(fakeSource(() => [], () => [greenCell()]))), { key, by: 'claude', timeoutSec: 5 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as { resolved: boolean; rounds: number; confirmation: { note: string } | null; observation: { state: string }; asserts: Array<{ asserts: string[]; failed: string[]; state: string }> }
    expect(data.resolved).toBe(true)
    expect(data.rounds).toBe(1)
    expect(data.observation.state).toBe('resolved')
    expect(data.confirmation?.note).toBe('verified by agent')
    expect(data.asserts[0]).toMatchObject({ state: 'ok', asserts: ['status 200', 'body.ok = true'], failed: [] })
    const confirmed = engine.history(24)[0].confirmed
    expect(confirmed).toMatchObject({ by: 'agent: claude', note: 'verified by agent' })
  })

  it('verify_fix answers still-firing with the assertion that failed, and resolves nothing itself', async () => {
    const key = fireProbe()
    const source = fakeSource(() => {
      // Each poll takes time: the fake clock moves past the deadline, so the tool times out instead of sleeping in a test.
      clock += 11_000
      return [probeAlert()]
    })
    const r = await tool('verify_fix').run(deps(rechecker(source)), { key, by: 'agent: claude', timeoutSec: 5 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as { resolved: boolean; timedOut: boolean; confirmation: null; next: string[] }
    expect(data.resolved).toBe(false)
    expect(data.timedOut).toBe(true)
    expect(data.confirmation).toBeNull()
    expect(data.next[0]).toContain('get_fix_context')
    expect(engine.isFiring(key)).toBe(true)
    expect(engine.history(24)[0]?.confirmed).toBeUndefined()
  })

  it('lists both new tools, sixteen in all, with the reads first', () => {
    const names = TOOLS.map((t) => t.name)
    expect(names).toHaveLength(16)
    expect(names).toContain('get_fix_context')
    expect(names).toContain('verify_fix')
    expect(names.indexOf('get_fix_context')).toBeLessThan(names.indexOf('acknowledge'))
    expect(names.indexOf('verify_fix')).toBeGreaterThan(names.indexOf('recheck'))
  })
})

describe('verifyFix', () => {
  it('waits, re-checks again, and records nothing while the source still reports the alert', async () => {
    const key = fireProbe()
    let calls = 0
    const source = fakeSource(() => {
      calls += 1
      return [probeAlert()]
    })
    // A test sleep that moves the fake clock: the loop's gap and deadline are real time, the clock is ours.
    const r = await verifyFix({ engine, recheck: rechecker(source), nowMs: () => clock, sleep: async (ms) => void (clock += ms) }, key, 'agent: claude', { timeoutSec: 30 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.resolved).toBe(false)
    expect(r.result.timedOut).toBe(true)
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(r.result.confirmation).toBeNull()
  })

  it('refuses a key the Watcher never held and a host with no re-checker', async () => {
    expect((await verifyFix({ engine, nowMs: () => clock }, 'No|Such', 'agent: claude')).ok).toBe(false)
    expect((await verifyFix({ engine, nowMs: () => clock }, 'No|Such', 'agent: claude')).ok).toBe(false)
    const key = fireProbe()
    const none = await verifyFix({ engine, nowMs: () => clock }, key, 'agent: claude')
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.error).toContain('re-check')
  })
})

describe('the routes the CLI reads', () => {
  function app(recheck?: Rechecker) {
    const deps: AppDeps = {
      engine,
      cfg,
      env: { WATCHER_MCP_TOKEN: 't'.padEnd(64, '0') },
      db: engine.db,
      push: new SqlitePushStore(engine.db),
      ackSecret: ['fix', 'test', '0001'].join('-'),
      webDir: '/nonexistent',
      normalizeWebhook: () => {
        throw new Error('unused')
      },
      testChannel: async () => ({ ok: true, status: 'ok', latencyMs: 1 }),
      nudge: () => undefined,
      recheck,
      vapidPublicKey: null,
      now: () => clock,
      log: () => undefined
    }
    return createApp(deps)
  }

  it('GET /api/incidents/:key/fix-context answers the brief, and 404 for a key it never held', async () => {
    const key = fireProbe()
    const a = app()
    const res = await a.request(`/api/incidents/${encodeURIComponent(key)}/fix-context`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ key, title: 'ProbeDown' })
    expect((await a.request('/api/incidents/No%7CSuch/fix-context')).status).toBe(404)
  })

  it('POST /api/incidents/:key/recheck runs one round, and POST .../verify waits and confirms', async () => {
    const key = fireProbe()
    const a = app(rechecker(fakeSource(() => [])))
    const round = await a.request(`/api/incidents/${encodeURIComponent(key)}/recheck`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'cli-test' })
    })
    expect(round.status).toBe(200)
    const roundBody = (await round.json()) as { resolved: boolean; alerts: unknown[] }
    expect(roundBody.resolved).toBe(true)
    expect(roundBody.alerts).toHaveLength(1)

    // The first round resolved it, so verify has nothing left to re-check and confirms the episode.
    const verify = await a.request(`/api/incidents/${encodeURIComponent(key)}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'cli-test', timeoutSec: 10 })
    })
    expect(verify.status).toBe(200)
    const body = (await verify.json()) as { resolved: boolean; confirmation: { note: string } | null }
    expect(body.resolved).toBe(true)
    expect(body.confirmation?.note).toBe('verified by agent')
    expect(engine.history(24)[0].confirmed).toMatchObject({ by: 'cli-test', note: 'verified by agent' })
  })

  it('POST .../verify is a 503 on a server with no re-checker, and a 400 for a bad timeout', async () => {
    const key = fireProbe()
    expect((await app().request(`/api/incidents/${encodeURIComponent(key)}/verify`, { method: 'POST' })).status).toBe(503)
    const bad = await app(rechecker(fakeSource(() => []))).request(`/api/incidents/${encodeURIComponent(key)}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeoutSec: 'soon' })
    })
    expect(bad.status).toBe(400)
  })
})

describe('the pure pieces', () => {
  it('jqPath and shellQuote make a command that cannot be mangled by a key', () => {
    expect(jqPath('db.ok')).toBe('.db.ok')
    expect(jqPath('db-kind.ok')).toBe('.["db-kind"].ok')
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
    expect(shellQuote('api|ProbeDown')).toBe("'api|ProbeDown'")
  })
  it('failingAssertionWords names only what the failure line falsifies, never a guess', () => {
    expect(failingAssertionWords(['status 200', 'body.ok = true'], 'HTTP 503 in 12ms, expected 200')).toEqual(['status 200'])
    expect(failingAssertionWords(['status 200', 'body.ok = true'], 'HTTP 200 in 12ms, but ok is false, expected true')).toEqual(['body.ok = true'])
    expect(failingAssertionWords(['status 200'], 'no answer: connect ECONNREFUSED')).toEqual(['status 200'])
    expect(failingAssertionWords(['tcp:connect'], 'connect refused')).toEqual(['tcp:connect'])
    expect(failingAssertionWords(['status 200'], 'HTTP 200 in 4ms')).toEqual([])
    expect(failingAssertionWords(['status 200'], null)).toEqual([])
  })
})
