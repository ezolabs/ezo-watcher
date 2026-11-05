// `watcher incident <key> [--fix-context]` and `watcher recheck <key> [--wait]` against a stub server: the routes they call, the
// bodies they send, what an agent reads back, and the exit codes. Every test writes under a fresh mkdtemp directory.
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { INIT_SPEC, runInit } from '../../src/cli/init.ts'
import { INCIDENTS_SPEC, runIncidents } from '../../src/cli/status.ts'
import { INCIDENT_SPEC, RECHECK_SPEC, runIncident, runRecheck } from '../../src/cli/incident.ts'
import { EnvGuard, WATCHER_KEYS, capture, fakeServer, parse, readJson, rmTemp, tempDir } from './helpers.ts'

const guards: Array<() => void> = []
const dirs: string[] = []

function guard(): EnvGuard {
  const g = new EnvGuard(WATCHER_KEYS)
  guards.push(() => g.restore())
  return g
}

afterEach(() => {
  for (const restore of guards.splice(0)) restore()
  for (const dir of dirs.splice(0)) rmTemp(dir)
})

const KEY = 'Api|ProbeDown'

const brief = {
  key: KEY,
  title: 'ProbeDown',
  summary: 'api is down: HTTP 503 in 12ms, expected 200',
  service: 'Api',
  rule: 'ProbeDown',
  severity: 'page',
  state: { firing: true, attention: 'none', ackedBy: null, silencedUntil: null, parkedState: null, parkedUntil: null },
  firstSeen: '2026-11-04T11:50:00.000Z',
  lastSeen: '2026-11-04T12:00:00.000Z',
  startsAt: '2026-11-04T11:50:00.000Z',
  ageSec: 600,
  url: 'https://watch.test/#/i/Api%7CProbeDown',
  alerts: [{ key: 'probe:a1b2c3d4', rule: 'ProbeDown', host: 'api-1', severity: 'page', state: 'firing', startsAt: '2026-11-04T11:50:00.000Z', lastSeen: '2026-11-04T12:00:00.000Z', resolvedAt: null }],
  sources: [
    {
      id: 'probe',
      kind: 'http-probe',
      state: 'ok',
      lastOk: '2026-11-04T11:59:00.000Z',
      lastAttempt: '2026-11-04T12:00:00.000Z',
      error: null,
      config: { id: 'probe', type: 'http-probe', pollSec: 60, targets: [{ id: 'api', url: 'https://api.example.com/healthz', expectStatus: 200, expectJson: { ok: true } }] },
      target: { id: 'api', url: 'https://api.example.com/healthz', expectStatus: 200, expectJson: { ok: true } },
      discovered: { foundAt: 'src/server.ts:42', read: 'GET /healthz answers {"ok":true}', at: '2026-11-01T00:00:00.000Z' }
    }
  ],
  asserts: [{ alert: 'probe:a1b2c3d4', rule: 'ProbeDown', source: 'probe', cell: 'ProbeDown', state: 'failing', asserts: ['status 200', 'body.ok = true'], failed: ['status 200'], failureDetail: 'HTTP 503 in 12ms, expected 200' }],
  observations: { lastGood: { at: '2026-11-04T11:59:00.000Z', status: 200, detail: 'HTTP 200', body: '{"ok":true}' }, lastBad: { at: '2026-11-04T12:00:00.000Z', status: 503, detail: 'HTTP 503 in 12ms, expected 200' } },
  reproduce: {
    command: "curl -sS -m 10 'https://api.example.com/healthz' | jq '.ok'",
    expect: 'true',
    alternatives: [{ label: 'status', command: "curl -sS -o /dev/null -w '%{http_code}\\n' -m 10 'https://api.example.com/healthz'", expect: '200' }],
    watcher: "watcher recheck 'Api|ProbeDown' --wait --json",
    note: 'The probe GETs the URL with redirects not followed.'
  },
  related: [],
  evidence: [{ id: 'https://api.example.com/healthz', kind: 'source', label: 'Open the source', short: 'Source', url: 'https://api.example.com/healthz', host: 'api.example.com' }],
  sourceEvidence: null,
  next: [
    { action: 'fix', detail: 'Change the cause of Api / ProbeDown.' },
    { action: 'restart-or-deploy', detail: 'Make the fix live.' },
    { action: 'verify', detail: 'Run the MCP tool verify_fix or `watcher recheck \'Api|ProbeDown\' --wait`.' }
  ]
}

const verifyResult = {
  key: KEY,
  resolved: true,
  timedOut: false,
  at: '2026-11-04T12:01:00.000Z',
  rounds: 1,
  observation: {
    at: '2026-11-04T12:01:00.000Z',
    key: KEY,
    state: 'resolved',
    alerts: [{ key: 'probe:a1b2c3d4', rule: 'ProbeDown', state: 'resolved', startsAt: '2026-11-04T11:50:00.000Z', resolvedAt: '2026-11-04T12:01:00.000Z', lastSeen: '2026-11-04T12:01:00.000Z' }],
    rechecks: []
  },
  asserts: brief.asserts,
  confirmation: { at: '2026-11-04T12:01:00.000Z', resolvedAt: '2026-11-04T12:01:00.000Z', note: 'verified by agent' },
  confirmationError: null,
  next: ['The incident is closed and the confirmation is in History.']
}

const detail = {
  incident: {
    key: KEY,
    summary: brief.summary,
    service: 'Api',
    rule: 'ProbeDown',
    severity: 'page',
    startsAt: brief.startsAt,
    ackedBy: null,
    silencedUntil: null,
    state: { attention: 'none' }
  },
  alerts: [{ key: 'probe:a1b2c3d4', rule: 'ProbeDown', host: 'api-1', state: 'firing', startsAt: brief.startsAt, resolvedAt: null, lastSeen: brief.lastSeen }],
  events: [{ id: 1, at: brief.startsAt, kind: 'fired', alertKey: null, incidentKey: KEY, detail: {} }],
  resolved: null,
  comments: [{ id: 1, incidentKey: KEY, by: 'agent: claude', text: 'looking', createdAt: brief.lastSeen }]
}

const recheckRound = {
  key: KEY,
  at: '2026-11-04T12:01:00.000Z',
  alerts: [
    {
      key: 'probe:a1b2c3d4',
      at: '2026-11-04T12:01:00.000Z',
      before: 'firing',
      after: 'resolved',
      startsAt: brief.startsAt,
      resolvedAt: '2026-11-04T12:01:00.000Z',
      sources: [{ id: 'probe', kind: 'http-probe', ok: true, error: null, checkedAt: '2026-11-04T12:01:00.000Z', ran: true, shared: false, throttled: false }],
      pushed: [],
      clearsOnSweep: false,
      rule: 'ProbeDown'
    }
  ],
  resolved: true,
  stillFiring: 0
}

interface StubState {
  verifyCalls: Array<Record<string, unknown>>
  recheckCalls: Array<Record<string, unknown>>
  unavailable?: boolean
  notFound?: boolean
  red?: boolean
}

function watcherServer(state: StubState) {
  return fakeServer((req, res, body) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0])
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (state.unavailable && (path.endsWith('/verify') || path.endsWith('/recheck'))) return json(503, { error: 're-check is not available' })
    if (state.notFound) return json(404, { error: 'not found' })
    if (path === `/api/incidents/${KEY}/fix-context`) return json(200, brief)
    if (path === `/api/incidents/${KEY}`) return json(200, detail)
    if (path === `/api/incidents/${KEY}/recheck` && req.method === 'POST') {
      state.recheckCalls.push(JSON.parse(body || '{}') as Record<string, unknown>)
      return json(200, recheckRound)
    }
    if (path === `/api/incidents/${KEY}/verify` && req.method === 'POST') {
      state.verifyCalls.push(JSON.parse(body || '{}') as Record<string, unknown>)
      return json(200, state.red ? { ...verifyResult, resolved: false, observation: { ...verifyResult.observation, state: 'firing' }, confirmation: null } : verifyResult)
    }
    if (path === '/api/state') {
      return json(200, {
        generatedAt: brief.lastSeen,
        header: {},
        sources: [],
        channels: [],
        health: [],
        incidents: [
          { key: KEY, service: 'Api', rule: 'ProbeDown', instance: null, summary: brief.summary, severity: 'page', startsAt: brief.startsAt, state: { firing: true, attention: 'none' }, alerts: [{}] },
          { key: 'Api|Deferred', service: 'Api', rule: 'Deferred', instance: null, summary: 'later', severity: 'warning', startsAt: brief.startsAt, state: { firing: false, attention: 'parked' }, alerts: [{}] }
        ]
      })
    }
    return json(404, { error: 'not found' })
  })
}

async function seeded(prefix: string): Promise<string> {
  const g = guard()
  g.set({ WATCHER_ACK_SECRET: 'ack-test', WATCHER_ADMIN_TOKEN: undefined, WATCHER_MCP_TOKEN: undefined, WATCHER_PORT: undefined, WATCHER_HOST: undefined })
  const dir = tempDir(prefix)
  dirs.push(dir)
  expect(await runInit(parse(['init', '--dir', dir], INIT_SPEC), capture('json').out)).toBe(0)
  const path = join(dir, '.watcher', 'config.json')
  const raw = readJson(path)
  raw.sources = [{ id: 'probe', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz', expectStatus: 200, expectJson: { ok: true } }] }]
  raw.channels = []
  raw.routes = []
  writeFileSync(path, JSON.stringify(raw, null, 2))
  return dir
}

describe('watcher incident', () => {
  it('asks for the fix-context brief and answers what an agent needs', async () => {
    const dir = await seeded('incident-fix')
    const state: StubState = { verifyCalls: [], recheckCalls: [] }
    const server = await watcherServer(state)
    try {
      const cap = capture('json')
      const code = await runIncident(parse(['incident', KEY, '--dir', dir, '--url', server.url, '--fix-context'], INCIDENT_SPEC), cap.out)
      expect(code).toBe(0)
      const out = JSON.parse(cap.stdout()) as typeof brief
      expect(out).toMatchObject({ key: KEY, title: 'ProbeDown', severity: 'page', state: { firing: true } })
      expect(out.asserts[0].failed).toEqual(['status 200'])
      expect(out.reproduce.command).toContain('curl -sS')
      expect(out.next.map((n) => n.action)).toEqual(['fix', 'restart-or-deploy', 'verify'])
      expect(server.requests.some((r) => decodeURIComponent(r.path) === `/api/incidents/${KEY}/fix-context`)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('renders the brief as Markdown with a reproduce block and the next steps', async () => {
    const dir = await seeded('incident-md')
    const state: StubState = { verifyCalls: [], recheckCalls: [] }
    const server = await watcherServer(state)
    try {
      const cap = capture('md')
      expect(await runIncident(parse(['incident', KEY, '--dir', dir, '--url', server.url, '--fix-context'], INCIDENT_SPEC), cap.out)).toBe(0)
      const text = cap.stdout()
      expect(text).toContain('# ProbeDown')
      expect(text).toContain('## Reproduce')
      expect(text).toContain("curl -sS -m 10 'https://api.example.com/healthz' | jq '.ok'")
      expect(text).toContain('## Next')
      expect(text).toContain('verify_fix')
      expect(text).toContain('src/server.ts:42')
    } finally {
      await server.close()
    }
  })

  it('shows the incident itself when no --fix-context is given', async () => {
    const dir = await seeded('incident-detail')
    const state: StubState = { verifyCalls: [], recheckCalls: [] }
    const server = await watcherServer(state)
    try {
      const cap = capture('json')
      expect(await runIncident(parse(['incident', KEY, '--dir', dir, '--url', server.url], INCIDENT_SPEC), cap.out)).toBe(0)
      expect(JSON.parse(cap.stdout())).toMatchObject({ incident: { rule: 'ProbeDown' } })
    } finally {
      await server.close()
    }
  })

  it('exits 1 with a key the Watcher does not have', async () => {
    const dir = await seeded('incident-missing')
    const state: StubState = { verifyCalls: [], recheckCalls: [], notFound: true }
    const server = await watcherServer(state)
    try {
      await expect(runIncident(parse(['incident', KEY, '--dir', dir, '--url', server.url, '--fix-context'], INCIDENT_SPEC), capture('json').out)).rejects.toMatchObject({ code: 'incident.not-found' })
    } finally {
      await server.close()
    }
  })

  it('refuses a call with no key as a usage error', async () => {
    await expect(runIncident(parse(['incident', '--fix-context'], INCIDENT_SPEC), capture('json').out)).rejects.toMatchObject({ exitCode: 64 })
  })
})

describe('watcher recheck', () => {
  it('--wait posts the verification with the timeout and the actor, and exits 0 when resolved', async () => {
    const dir = await seeded('recheck-wait')
    const state: StubState = { verifyCalls: [], recheckCalls: [] }
    const server = await watcherServer(state)
    try {
      const cap = capture('json')
      const code = await runRecheck(parse(['recheck', KEY, '--dir', dir, '--url', server.url, '--wait', '--timeout', '30'], RECHECK_SPEC), cap.out)
      expect(code).toBe(0)
      expect(JSON.parse(cap.stdout())).toMatchObject({ key: KEY, resolved: true, confirmation: { note: 'verified by agent' } })
      expect(state.verifyCalls).toEqual([{ by: 'watcher CLI', timeoutSec: 30 }])
    } finally {
      await server.close()
    }
  })

  it('exits 1 when the source still reports it', async () => {
    const dir = await seeded('recheck-red')
    const state: StubState = { verifyCalls: [], recheckCalls: [], red: true }
    const server = await watcherServer(state)
    try {
      const cap = capture('json')
      const code = await runRecheck(parse(['recheck', KEY, '--dir', dir, '--url', server.url, '--wait'], RECHECK_SPEC), cap.out)
      expect(code).toBe(1)
      expect(JSON.parse(cap.stdout())).toMatchObject({ resolved: false })
    } finally {
      await server.close()
    }
  })

  it('without --wait runs one round and answers each alert', async () => {
    const dir = await seeded('recheck-round')
    const state: StubState = { verifyCalls: [], recheckCalls: [] }
    const server = await watcherServer(state)
    try {
      const cap = capture('json')
      expect(await runRecheck(parse(['recheck', KEY, '--dir', dir, '--url', server.url], RECHECK_SPEC), cap.out)).toBe(0)
      expect(JSON.parse(cap.stdout())).toMatchObject({ key: KEY, resolved: true })
      expect(state.recheckCalls).toHaveLength(1)
      expect(state.recheckCalls[0]).toMatchObject({ by: 'watcher CLI' })
    } finally {
      await server.close()
    }
  })

  it('names a server with no re-checker instead of an empty success', async () => {
    const dir = await seeded('recheck-off')
    const state: StubState = { verifyCalls: [], recheckCalls: [], unavailable: true }
    const server = await watcherServer(state)
    try {
      await expect(runRecheck(parse(['recheck', KEY, '--dir', dir, '--url', server.url, '--wait'], RECHECK_SPEC), capture('json').out)).rejects.toMatchObject({ code: 'recheck.unavailable' })
    } finally {
      await server.close()
    }
  })
})

describe('watcher incidents --open', () => {
  it('is the explicit spelling of the default: live incidents only, parked left out', async () => {
    const dir = await seeded('incidents-open')
    const state: StubState = { verifyCalls: [], recheckCalls: [] }
    const server = await watcherServer(state)
    try {
      const cap = capture('json')
      expect(await runIncidents(parse(['incidents', '--dir', dir, '--url', server.url, '--open'], INCIDENTS_SPEC), cap.out)).toBe(0)
      const out = JSON.parse(cap.stdout()) as { count: number; incidents: Array<{ key: string }> }
      expect(out.count).toBe(1)
      expect(out.incidents[0].key).toBe(KEY)

      cap.reset()
      expect(await runIncidents(parse(['incidents', '--dir', dir, '--url', server.url, '--all'], INCIDENTS_SPEC), cap.out)).toBe(0)
      expect((JSON.parse(cap.stdout()) as { count: number }).count).toBe(2)
    } finally {
      await server.close()
    }
  })
})
