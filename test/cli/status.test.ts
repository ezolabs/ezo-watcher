import { describe, expect, it, afterEach } from 'vitest'
import { join } from 'node:path'
import { INIT_SPEC, runInit } from '../../src/cli/init.ts'
import { INCIDENTS_SPEC, MCP_CONFIG_SPEC, STATUS_SPEC, TEST_ALERT_SPEC, runIncidents, runMcpConfig, runStatus, runTestAlert } from '../../src/cli/status.ts'
import { EnvGuard, WATCHER_KEYS, capture, fakeServer, freePort, parse, readJson, rmTemp, tempDir } from './helpers.ts'
import { writeFileSync } from 'node:fs'

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

const summary = {
  v: 1,
  firing: 2,
  unattended: 1,
  acknowledged: 1,
  parked: 1,
  worst: 'page',
  bySeverity: { page: 1, warning: 1, info: 0 },
  unattendedBySeverity: { page: 1, warning: 0, info: 0 },
  stale: false
}

const incidents = [
  { key: 'api|HighLatency', service: 'api', rule: 'HighLatency', instance: null, summary: 'slow', severity: 'warning', startsAt: new Date(Date.now() - 60_000).toISOString(), state: { firing: true, attention: 'none' }, alerts: [{}], ackedBy: null, silencedUntil: null },
  { key: 'web|Down', service: 'web', rule: 'Down', instance: null, summary: 'down', severity: 'page', startsAt: new Date(Date.now() - 120_000).toISOString(), state: { firing: true, attention: 'acked' }, alerts: [{}, {}], ackedBy: 'sam', silencedUntil: null },
  { key: 'db|Disk', service: 'db', rule: 'Disk', instance: null, summary: 'disk', severity: 'warning', startsAt: new Date(Date.now() - 300_000).toISOString(), state: { firing: false, attention: 'parked' }, alerts: [{}], ackedBy: null, silencedUntil: null }
]

async function seeded(prefix: string): Promise<string> {
  const g = guard()
  const port = await freePort()
  g.set({ WATCHER_ACK_SECRET: 'ack-test', WATCHER_ADMIN_TOKEN: 'admin-test-token', WATCHER_MCP_TOKEN: 'mcp-test-token', WATCHER_PORT: String(port) })
  const dir = tempDir(prefix)
  dirs.push(dir)
  expect(await runInit(parse(['init', '--dir', dir], INIT_SPEC), capture('json').out)).toBe(0)
  const path = join(dir, '.watcher', 'config.json')
  const raw = readJson(path)
  raw.channels = [{ id: 'hook', type: 'webhook', urlEnv: 'WATCHER_HOOK_URL' }]
  raw.routes = [{ id: 'default', match: {}, receivers: ['hook'], mode: 'ladder', groupWaitSec: 0, groupIntervalSec: 120, repeatIntervalSec: 1800 }]
  raw.sources = [{ id: 'api', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz' }] }]
  writeFileSync(path, JSON.stringify(raw, null, 2))
  return dir
}

function watcherServer(options: { testNotify?: boolean } = {}) {
  return fakeServer((req, res, body) => {
    const path = req.url ?? ''
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (path === '/api/instance') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ brand: { name: 'EZO Watcher', shortName: 'Watcher' }, features: [] }))
      return
    }
    if (path === '/api/summary') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(summary))
      return
    }
    if (path === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ generatedAt: new Date().toISOString(), header: {}, sources: [{ id: 'api', kind: 'http-probe', name: 'api', state: 'ok', lastOk: new Date().toISOString(), lastAttempt: new Date().toISOString(), error: null, firing: 0, rules: 1, misses: 0 }], channels: [{ id: 'hook', type: 'webhook', enabled: true, lastTestAt: null, lastTestOk: null, lastTest: null }], incidents, health: [] }))
      return
    }
    if (path === '/api/test-notify' && options.testNotify !== false) {
      const parsed = JSON.parse(body || '{}') as { channel?: string }
      if (parsed.channel !== 'hook') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end('{"error":"unknown channel"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true,"status":"sent","latencyMs":7}')
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  })
}

describe('watcher status', () => {
  it('reads the running server and renders the counts, sources and channels', async () => {
    const dir = await seeded('status')
    const server = await watcherServer()
    try {
      const cap = capture('json')
      const code = await runStatus(parse(['status', '--dir', dir, '--url', server.url], STATUS_SPEC), cap.out)
      expect(code).toBe(0)
      const out = JSON.parse(cap.stdout()) as { ok: boolean; summary: typeof summary; sources: unknown[]; channels: unknown[] }
      expect(out.ok).toBe(true)
      expect(out.summary.firing).toBe(2)
      expect(out.sources).toHaveLength(1)
      expect(out.channels).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('exits 1 when nothing answers', async () => {
    const dir = await seeded('status-down')
    const cap = capture('json')
    const code = await runStatus(parse(['status', '--dir', dir, '--url', 'http://127.0.0.1:1'], STATUS_SPEC), cap.out)
    expect(code).toBe(1)
    expect(JSON.parse(cap.stdout())).toMatchObject({ ok: false, server: { up: false } })
  })
})

describe('watcher incidents', () => {
  it('lists firing incidents by default, and parked ones with --all', async () => {
    const dir = await seeded('incidents')
    const server = await watcherServer()
    try {
      const cap = capture('json')
      expect(await runIncidents(parse(['incidents', '--dir', dir, '--url', server.url], INCIDENTS_SPEC), cap.out)).toBe(0)
      const firing = JSON.parse(cap.stdout()) as { count: number }
      expect(firing.count).toBe(2)

      cap.reset()
      expect(await runIncidents(parse(['incidents', '--dir', dir, '--url', server.url, '--all'], INCIDENTS_SPEC), cap.out)).toBe(0)
      expect((JSON.parse(cap.stdout()) as { count: number }).count).toBe(3)

      cap.reset()
      expect(await runIncidents(parse(['incidents', '--dir', dir, '--url', server.url, '--severity', 'page'], INCIDENTS_SPEC), cap.out)).toBe(0)
      const pages = JSON.parse(cap.stdout()) as { count: number; incidents: Array<{ severity: string }> }
      expect(pages.count).toBe(1)
      expect(pages.incidents[0].severity).toBe('page')

      cap.reset()
      expect(await runIncidents(parse(['incidents', '--dir', dir, '--url', server.url, '--all', '--limit', '1'], INCIDENTS_SPEC), cap.out)).toBe(0)
      expect((JSON.parse(cap.stdout()) as { count: number }).count).toBe(1)

      // Service and severity filters are case-insensitive: the wall shows "Web" for the id "web".
      cap.reset()
      expect(await runIncidents(parse(['incidents', '--dir', dir, '--url', server.url, '--all', '--service', 'WEB'], INCIDENTS_SPEC), cap.out)).toBe(0)
      expect((JSON.parse(cap.stdout()) as { count: number }).count).toBe(1)
      cap.reset()
      expect(await runIncidents(parse(['incidents', '--dir', dir, '--url', server.url, '--all', '--severity', 'PAGE'], INCIDENTS_SPEC), cap.out)).toBe(0)
      expect((JSON.parse(cap.stdout()) as { count: number }).count).toBe(1)
    } finally {
      await server.close()
    }
  })
})

describe('watcher test-alert', () => {
  it('posts to /api/test-notify', async () => {
    const dir = await seeded('test-alert')
    const server = await watcherServer({ testNotify: true })
    try {
      const cap = capture('json')
      const code = await runTestAlert(parse(['test-alert', '--dir', dir, '--url', server.url, '--channel', 'hook'], TEST_ALERT_SPEC), cap.out)
      expect(code).toBe(0)
      const out = JSON.parse(cap.stdout()) as { ok: boolean; results: Array<{ endpoint: string; ok: boolean }> }
      expect(out.ok).toBe(true)
      expect(out.results[0].endpoint).toBe('/api/test-notify')
      expect(server.requests.some((r) => r.path === '/api/test-notify' && r.method === 'POST')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('reports a 404 as a failure instead of falling back to the wall own endpoint', async () => {
    const dir = await seeded('test-alert-old-server')
    const server = await watcherServer({ testNotify: false })
    try {
      await expect(
        runTestAlert(parse(['test-alert', '--dir', dir, '--url', server.url, '--channel', 'hook'], TEST_ALERT_SPEC), capture('json').out)
      ).rejects.toMatchObject({ code: 'test-alert.failed' })
      expect(server.requests.some((r) => r.path === '/api/notifications/test')).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('refuses an unknown channel', async () => {
    const dir = await seeded('test-alert-unknown')
    await expect(runTestAlert(parse(['test-alert', '--dir', dir, '--channel', 'nope'], TEST_ALERT_SPEC), capture('json').out)).rejects.toMatchObject({ code: 'test-alert.unknown-channel' })
  })
})

describe('watcher mcp-config', () => {
  it('prints the claude command with an env reference, never the token value', async () => {
    const dir = await seeded('mcp-claude')
    const cap = capture('json')
    const code = await runMcpConfig(parse(['mcp-config', '--dir', dir, '--client', 'claude'], MCP_CONFIG_SPEC), cap.out)
    expect(code).toBe(0)
    const out = JSON.parse(cap.stdout()) as { forms: { http: { value: string } }; secretShown: boolean }
    expect(out.forms.http.value).toContain('claude mcp add --transport http ezo-watcher')
    expect(out.forms.http.value).toContain('$WATCHER_MCP_TOKEN')
    expect(out.forms.http.value).not.toContain('mcp-test-token')
    expect(out.secretShown).toBe(false)
  })

  it('prints the token with --show-secret', async () => {
    const dir = await seeded('mcp-secret')
    const cap = capture('json')
    const code = await runMcpConfig(parse(['mcp-config', '--dir', dir, '--client', 'claude', '--show-secret'], MCP_CONFIG_SPEC), cap.out)
    expect(code).toBe(0)
    expect((JSON.parse(cap.stdout()) as { forms: { http: { value: string } } }).forms.http.value).toContain('mcp-test-token')
  })

  it('prints JSON for cursor and TOML for codex with the env reference', async () => {
    const dir = await seeded('mcp-other')
    let cap = capture('json')
    expect(await runMcpConfig(parse(['mcp-config', '--dir', dir, '--client', 'cursor'], MCP_CONFIG_SPEC), cap.out)).toBe(0)
    const cursor = JSON.parse(cap.stdout()) as { forms: { http: { value: string } } }
    expect(JSON.parse(cursor.forms.http.value)).toMatchObject({ mcpServers: { 'ezo-watcher': { headers: { Authorization: 'Bearer ${env:WATCHER_MCP_TOKEN}' } } } })

    cap = capture('json')
    expect(await runMcpConfig(parse(['mcp-config', '--dir', dir, '--client', 'codex'], MCP_CONFIG_SPEC), cap.out)).toBe(0)
    const codex = JSON.parse(cap.stdout()) as { forms: { http: { value: string } } }
    expect(codex.forms.http.value).toContain('[mcp_servers.ezo-watcher]')
    expect(codex.forms.http.value).toContain('bearer_token_env_var = "WATCHER_MCP_TOKEN"')
  })

  it('rejects an unknown client as a usage error', async () => {
    const dir = await seeded('mcp-bad')
    await expect(runMcpConfig(parse(['mcp-config', '--dir', dir, '--client', 'vim'], MCP_CONFIG_SPEC), capture('json').out)).rejects.toMatchObject({ code: 'mcp-config.unknown-client', exitCode: 64 })
  })
})

