// `doctor --prove` on a no-server install: a heartbeat-only or host-only project must reach live:true.
// The live-run finding (#45, S2) was 81 turns chasing a `live:true` no heartbeat or host install could
// get, because only http-probe had a prover. These tests pin the four kinds' provers and the two skips.
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INIT_SPEC, runInit } from '../../src/cli/init.ts'
import { runDoctor } from '../../src/cli/doctor.ts'
import type { Check } from '../../src/cli/doctor.ts'
import { managedHash } from '../../src/cli/project.ts'
import { EnvGuard, WATCHER_KEYS, capture, fakeServer, freePort, parse, readJson, rmTemp, tempDir } from './helpers.ts'

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

async function seeded(prefix: string, env: Record<string, string | undefined> = {}): Promise<string> {
  const g = guard()
  const port = await freePort()
  g.set({
    WATCHER_ACK_SECRET: 'ack-secret-for-tests',
    WATCHER_ADMIN_TOKEN: 'admin-token-for-tests',
    WATCHER_MCP_TOKEN: 'mcp-token-for-tests',
    WATCHER_PORT: String(port),
    WATCHER_HOST: '127.0.0.1',
    WATCHER_CONFIG: undefined,
    WATCHER_DATA_DIR: undefined,
    WATCHER_WEB_DIR: undefined,
    ...env
  })
  const dir = tempDir(prefix)
  dirs.push(dir)
  expect(await runInit(parse(['init', '--dir', dir], INIT_SPEC), capture('json').out)).toBe(0)
  g.set({
    WATCHER_ACK_SECRET: 'ack-secret-for-tests',
    WATCHER_ADMIN_TOKEN: 'admin-token-for-tests',
    WATCHER_MCP_TOKEN: 'mcp-token-for-tests',
    WATCHER_PORT: String(port),
    ...env
  })
  return dir
}

function writeConfig(dir: string, mutate: (raw: Record<string, unknown>) => void): void {
  const path = join(dir, '.watcher', 'config.json')
  const raw = readJson(path)
  mutate(raw)
  raw._meta = { writer: 'watcher', version: '0.1.0', sha256: managedHash(raw) }
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`)
}

function find(checks: Check[], code: string): Check | undefined {
  return checks.find((c) => c.code === code)
}

/** A running Watcher whose /api/state reports every configured source as polled and asserted. */
async function serverFor(sources: Array<Record<string, unknown>>, states: Record<string, string> = {}) {
  const state = sources.map((s) => ({ id: s.id, kind: s.type, state: states[String(s.id)] ?? 'ok', lastAttempt: new Date().toISOString(), asserted: 1 }))
  return fakeServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (req.url === '/api/instance') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ brand: { name: 'EZO Watcher', shortName: 'Watcher' }, features: [] }))
      return
    }
    if (req.url === '/api/doctor') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, checks: [], observations: [] }))
      return
    }
    if (req.url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ generatedAt: new Date().toISOString(), sources: state, incidents: [], health: [], channels: [] }))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
}

async function proveOnAServer(prefix: string, sources: Array<Record<string, unknown>>, env: Record<string, string | undefined> = {}, states: Record<string, string> = {}) {
  const dir = await seeded(prefix, env)
  const target = await serverFor(sources, states)
  try {
    const g = guard()
    g.set({ WATCHER_PORT: String(target.port) })
    writeConfig(dir, (raw) => {
      raw.sources = sources
      raw.channels = [{ id: 'wall', type: 'file' }]
    })
    const result = await runDoctor({
      project: { dir, watcherDir: join(dir, '.watcher'), configPath: join(dir, '.watcher', 'config.json'), envPath: join(dir, '.watcher', '.env'), envExamplePath: join(dir, '.watcher', '.env.example') },
      live: true,
      prove: true,
      noRuntimeSurface: false,
      target: 'local'
    })
    return result
  } finally {
    await target.close()
  }
}

describe('doctor --prove: a no-server install reaches live:true', () => {
  it('proves a heartbeat by taking a healthy ok ping and evaluating after the next due run plus its grace', async () => {
    const result = await proveOnAServer('prove-heartbeat', [{ id: 'nightly', type: 'heartbeat', every: '5m', grace: '2m', tokenEnv: 'NIGHTLY_TOKEN' }], { NIGHTLY_TOKEN: 'tok' })
    const proven = find(result.checks, 'source.proven')
    expect(proven?.status).toBe('pass')
    expect(proven?.message).toContain('no ping after the run due at')
    expect(result.checks.filter((c) => c.status === 'fail')).toEqual([])
    expect(result.live).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('proves a host by moving a reading past its disk, memory and load thresholds', async () => {
    const result = await proveOnAServer('prove-host', [{ id: 'host', type: 'host' }])
    const proven = find(result.checks, 'source.proven')
    expect(proven?.status).toBe('pass')
    expect(proven?.message).toContain('disk / at 0% free')
    expect(result.checks.filter((c) => c.status === 'fail')).toEqual([])
    expect(result.live).toBe(true)
  })

  it('proves a tcp-probe by a failed connect reaching ProbeDown', async () => {
    const result = await proveOnAServer('prove-tcp', [{ id: 'db', type: 'tcp-probe', targets: [{ id: 'db', service: 'db', host: '127.0.0.1', port: 5432 }] }])
    const proven = find(result.checks, 'source.proven')
    expect(proven?.status).toBe('pass')
    expect(proven?.message).toContain('failed connect')
    expect(result.checks.filter((c) => c.status === 'fail')).toEqual([])
    expect(result.live).toBe(true)
  })

  it('proves a domain-expiry by an expiration inside pageDays', async () => {
    const result = await proveOnAServer('prove-domain', [{ id: 'domains', type: 'domain-expiry', domains: ['example.com'] }])
    const proven = find(result.checks, 'source.proven')
    expect(proven?.status).toBe('pass')
    expect(proven?.message).toContain('expires at')
    expect(result.checks.filter((c) => c.status === 'fail')).toEqual([])
    expect(result.live).toBe(true)
  })

  it('names a skip, never a fail, for a kind with no evaluator to mutate', async () => {
    const result = await proveOnAServer('prove-grafana', [{ id: 'grafana', type: 'grafana', url: 'https://grafana.example.com', tokenEnv: 'GRAFANA_TOKEN', pollSec: 30 }], { GRAFANA_TOKEN: 'tok' })
    const skip = find(result.checks, 'source.prove-unsupported')
    expect(skip?.status).toBe('skip')
    expect(skip?.message).toContain('grafana')
    expect(result.checks.filter((c) => c.status === 'fail')).toEqual([])
    // A skip is not a proof: with no proven source the install is not live.
    expect(result.live).toBe(false)
  })

  it('does not fail a live run for an optional source the server could not poll', async () => {
    const result = await proveOnAServer(
      'prove-optional-live',
      [
        { id: 'host', type: 'host' },
        { id: 'sentry', type: 'sentry', url: 'https://sentry.io', webUrl: 'https://sentry.io', org: 'acme', tokenEnv: 'SENTRY_TOKEN', pollSec: 120, projects: { web: 'web' }, optional: true }
      ],
      {},
      { sentry: 'error' }
    )
    expect(find(result.checks, 'source.credential-skip')?.status).toBe('skip')
    expect(result.checks.filter((c) => c.code === 'source.error')).toEqual([])
    expect(result.checks.filter((c) => c.status === 'fail')).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.live).toBe(true)
  })
})

describe('doctor: an optional credential-bound source', () => {
  const sentry = (optional: boolean): Array<Record<string, unknown>> => [
    {
      id: 'sentry',
      type: 'sentry',
      url: 'https://sentry.io',
      webUrl: 'https://sentry.io',
      org: 'acme',
      tokenEnv: 'SENTRY_TOKEN',
      pollSec: 120,
      projects: { web: 'web' },
      ...(optional ? { optional: true } : {})
    }
  ]

  it('is a named skip with the exact fix and does not fail ok', async () => {
    const dir = await seeded('optional-skip')
    writeConfig(dir, (raw) => {
      raw.sources = sentry(true)
      raw.channels = [{ id: 'wall', type: 'file' }]
    })
    const result = await runDoctor({
      project: { dir, watcherDir: join(dir, '.watcher'), configPath: join(dir, '.watcher', 'config.json'), envPath: join(dir, '.watcher', '.env'), envExamplePath: join(dir, '.watcher', '.env.example') },
      live: false,
      prove: false,
      noRuntimeSurface: false,
      target: 'local'
    })
    const skip = find(result.checks, 'source.credential-skip')
    expect(find(result.checks, 'config.valid')?.status).toBe('pass')
    expect(skip?.status).toBe('skip')
    expect(skip?.message).toContain('(optional)')
    expect(skip?.next).toContain('SENTRY_TOKEN')
    expect(skip?.next).toContain('--secret-value')
    expect(find(result.checks, 'env.missing')).toBeUndefined()
    expect(result.ok).toBe(true)
  })

  it('keeps a required source a failure when its credential is absent', async () => {
    const dir = await seeded('required-skip')
    writeConfig(dir, (raw) => {
      raw.sources = sentry(false)
      raw.channels = [{ id: 'wall', type: 'file' }]
    })
    const result = await runDoctor({
      project: { dir, watcherDir: join(dir, '.watcher'), configPath: join(dir, '.watcher', 'config.json'), envPath: join(dir, '.watcher', '.env'), envExamplePath: join(dir, '.watcher', '.env.example') },
      live: false,
      prove: false,
      noRuntimeSurface: false,
      target: 'local'
    })
    expect(find(result.checks, 'config.valid')?.status).toBe('pass')
    expect(find(result.checks, 'source.credential-skip')?.message).toContain('(required)')
    expect(find(result.checks, 'env.missing')?.status).toBe('fail')
    expect(result.ok).toBe(false)
  })
})
