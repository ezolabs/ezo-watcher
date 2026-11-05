import { describe, expect, it, afterEach } from 'vitest'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { INIT_SPEC, runInit } from '../../src/cli/init.ts'
import { runDoctor } from '../../src/cli/doctor.ts'
import { ADD_SPEC, runAdd } from '../../src/cli/add.ts'
import type { Check } from '../../src/cli/doctor.ts'
import type { scanProject } from '../../src/cli/signals/detect.ts'
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

async function seeded(prefix: string, env: Record<string, string | undefined> = {}): Promise<{ dir: string; port: number }> {
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
  const code = await runInit(parse(['init', '--dir', dir], INIT_SPEC), capture('json').out)
  expect(code).toBe(0)
  // Keep the test's own env from being overwritten by the generated one.
  g.set({ WATCHER_ACK_SECRET: 'ack-secret-for-tests', WATCHER_ADMIN_TOKEN: 'admin-token-for-tests', WATCHER_MCP_TOKEN: 'mcp-token-for-tests', WATCHER_PORT: String(port) })
  return { dir, port }
}

function writeConfig(dir: string, mutate: (raw: Record<string, unknown>) => void): void {
  const path = join(dir, '.watcher', 'config.json')
  const raw = readJson(path)
  mutate(raw)
  raw._meta = { writer: 'watcher', version: '0.1.0', sha256: managedHash(raw) }
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`)
}

function codes(checks: Check[]): string[] {
  return checks.map((c) => c.code)
}

function find(checks: Check[], code: string): Check | undefined {
  return checks.find((c) => c.code === code)
}

/** A running Watcher as the CLI reads it: /api/doctor with one recorded good answer, /api/state with the source asserted. */
async function liveServer(bodyText: string, asserted = 1) {
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
      res.end(JSON.stringify({ ok: true, checks: [], observations: [{ source: 'api', target: 'api', status: 200, headers: {}, bodyText }] }))
      return
    }
    if (req.url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ generatedAt: new Date().toISOString(), sources: [{ id: 'api', kind: 'http-probe', state: 'ok', lastAttempt: new Date().toISOString(), asserted }], incidents: [], health: [], channels: [] }))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
}

async function doctor(dir: string, opts: Partial<{ live: boolean; prove: boolean; noRuntimeSurface: boolean; fetchImpl: typeof fetch; scanImpl: typeof scanProject }> = {}) {
  return runDoctor({ project: { dir, watcherDir: join(dir, '.watcher'), configPath: join(dir, '.watcher', 'config.json'), envPath: join(dir, '.watcher', '.env'), envExamplePath: join(dir, '.watcher', '.env.example') }, live: opts.live ?? false, prove: opts.prove ?? false, noRuntimeSurface: opts.noRuntimeSurface ?? false, target: 'local', ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), ...(opts.scanImpl ? { scanImpl: opts.scanImpl } : {}) })
}

describe('watcher doctor (static)', () => {
  it('passes a fresh project with a configured channel and no sources', async () => {
    const { dir } = await seeded('doctor-green')
    writeConfig(dir, (raw) => {
      raw.channels = []
    })
    const result = await doctor(dir)
    expect(result.ok).toBe(true)
    expect(find(result.checks, 'config.valid')?.status).toBe('pass')
    expect(find(result.checks, 'env.present')?.status).toBe('pass')
    expect(find(result.checks, 'channel.missing')?.status).toBe('warn')
  })

  it('fails config.missing when .watcher is absent', async () => {
    const g = guard()
    g.set({ WATCHER_ACK_SECRET: 'x', WATCHER_ADMIN_TOKEN: 'y' })
    const dir = tempDir('doctor-empty')
    dirs.push(dir)
    const result = await doctor(dir)
    expect(result.ok).toBe(false)
    expect(find(result.checks, 'watcher.dir')?.status).toBe('fail')
  })

  it('fails env.missing for a referenced secret and skips a required credential-bound source', async () => {
    const { dir } = await seeded('doctor-env')
    writeConfig(dir, (raw) => {
      raw.sources = [{ id: 'hooks', type: 'webhook', tokenEnv: 'HOOKS_TOKEN_MISSING' }]
    })
    const result = await doctor(dir)
    expect(find(result.checks, 'env.missing')?.message).toContain('HOOKS_TOKEN_MISSING')
    const skip = find(result.checks, 'source.credential-skip')
    expect(skip?.status).toBe('skip')
    expect(skip?.message).toContain('required')
    expect(result.ok).toBe(false)
  })

  it('names the mint on a heartbeat or webhook secret only, never on every missing credential', async () => {
    const { dir } = await seeded('doctor-env-mint')
    writeConfig(dir, (raw) => {
      raw.sources = [
        { id: 'graf', type: 'grafana', url: 'http://127.0.0.1:3000', tokenEnv: 'GRAFANA_TOKEN_MISSING', pollSec: 60 },
        { id: 'hooks', type: 'webhook', tokenEnv: 'HOOKS_TOKEN_MISSING' }
      ]
    })
    const result = await doctor(dir)
    const rows = result.checks.filter((c) => c.code === 'env.missing')
    const graf = rows.find((c) => c.message.includes('GRAFANA_TOKEN_MISSING'))
    const hooks = rows.find((c) => c.message.includes('HOOKS_TOKEN_MISSING'))
    expect(hooks?.next).toContain('minted by `watcher add`')
    expect(graf?.next).not.toContain('minted by')
    expect(graf?.next).toContain('watcher init')
  })

  it('reports data.unwritable with the resolved path when the data dir is a file', async () => {
    const { dir } = await seeded('doctor-data')
    rmSync(join(dir, '.watcher', 'data'), { recursive: true, force: true })
    writeFileSync(join(dir, '.watcher', 'data'), 'not a directory')
    const result = await doctor(dir)
    const check = find(result.checks, 'data.unwritable')
    expect(check?.status).toBe('fail')
    expect(check?.message).toContain(join(dir, '.watcher', 'data'))
    expect(check?.next).toBeDefined()
  })

  it('fails port.in-use when another process holds the port', async () => {
    const { dir } = await seeded('doctor-port')
    const other = await fakeServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
    try {
      const g = guard()
      g.set({ WATCHER_PORT: String(other.port) })
      const result = await doctor(dir)
      expect(find(result.checks, 'port.in-use')?.status).toBe('fail')
    } finally {
      await other.close()
    }
  })

  it('fails source.self-probe when a source URL is the Watcher itself', async () => {
    const { dir, port } = await seeded('doctor-self')
    writeConfig(dir, (raw) => {
      raw.sources = [{ id: 'self', type: 'http-probe', targets: [{ id: 'self', service: 'self', url: `http://127.0.0.1:${port}/healthz` } ] }]
    })
    const result = await doctor(dir)
    expect(find(result.checks, 'source.self-probe')?.status).toBe('fail')
  })

  it('warns source.untraced and source.provenance-weak when the foundAt does not check out', async () => {
    const { dir } = await seeded('doctor-trace')
    writeConfig(dir, (raw) => {
      raw.sources = [{ id: 'api', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz' }] }]
    })
    let result = await doctor(dir)
    expect(find(result.checks, 'source.untraced')?.status).toBe('warn')
    writeConfig(dir, (raw) => {
      raw.sources = [{ id: 'api', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz' }], discovered: { foundAt: 'does-not-exist.ts:1' } }]
    })
    result = await doctor(dir)
    expect(find(result.checks, 'source.provenance-weak')?.status).toBe('warn')
  })

  it('warns config.hand-edited when the sources changed after add wrote _meta', async () => {
    const { dir } = await seeded('doctor-meta')
    await runAdd(parse(['add', '--dir', dir, 'http-probe', '--id', 'api', '--url', 'https://api.example.com/healthz'], ADD_SPEC), capture('json').out)
    const path = join(dir, '.watcher', 'config.json')
    const raw = readJson(path)
    ;(raw.sources as Array<Record<string, unknown>>).push({ id: 'hand', type: 'webhook', tokenEnv: 'HAND_TOKEN' })
    writeFileSync(path, JSON.stringify(raw, null, 2))
    const result = await doctor(dir)
    expect(find(result.checks, 'config.hand-edited')?.status).toBe('warn')
  })

  it('fails bundle.config-leak when the built web bundle carries a source host:port', async () => {
    const { dir } = await seeded('doctor-bundle')
    const web = join(dir, 'web-dist')
    mkdirSync(web, { recursive: true })
    writeFileSync(join(web, 'app.js'), 'const BASE = "http://127.0.0.1:9876";')
    const g = guard()
    g.set({ WATCHER_WEB_DIR: web })
    writeConfig(dir, (raw) => {
      raw.sources = [{ id: 'api', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'http://127.0.0.1:9876/healthz' }] }]
    })
    const result = await doctor(dir)
    const check = find(result.checks, 'bundle.config-leak')
    expect(check?.status).toBe('fail')
    expect(check?.message).toContain('127.0.0.1:9876')
  })
})

describe('watcher doctor --prove', () => {
  it('proves a dependency-gated assertion by mutating the answer the server recorded, never by asking the target again', async () => {
    const { dir } = await seeded('doctor-prove')
    const target = await liveServer(JSON.stringify({ ok: true, db: { status: 'up' } }))
    try {
      const g = guard()
      g.set({ WATCHER_PORT: String(target.port) })
      writeConfig(dir, (raw) => {
        raw.sources = [{ id: 'api', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz', expectJson: { 'db.status': 'up' } }], discovered: { foundAt: 'src/server.ts:1' } }]
      })
      const result = await doctor(dir, { live: true, prove: true })
      expect(find(result.checks, 'source.proven')?.status).toBe('pass')
      expect(result.checks.filter((c) => c.status === 'fail')).toEqual([])
      expect(result.ok).toBe(true)
    } finally {
      await target.close()
    }
  })

  it('fails assertion-vacuous when the asserted path is not in the last good answer', async () => {
    const { dir } = await seeded('doctor-vacuous')
    const target = await liveServer(JSON.stringify({ ok: true }))
    try {
      const g = guard()
      g.set({ WATCHER_PORT: String(target.port) })
      writeConfig(dir, (raw) => {
        raw.sources = [{ id: 'api', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz', expectJson: { 'db.status': 'up' } }], discovered: { foundAt: 'src/server.ts:1' } }]
      })
      const result = await doctor(dir, { live: true, prove: true })
      const check = find(result.checks, 'source.assertion-vacuous')
      expect(check?.status).toBe('fail')
      expect(check?.next).toBeDefined()
    } finally {
      await target.close()
    }
  })

  it('fails assertion-vacuous for a bare 200 target with no expect-json', async () => {
    const { dir } = await seeded('doctor-bare')
    const target = await liveServer('{"ok":true}')
    try {
      const g = guard()
      g.set({ WATCHER_PORT: String(target.port) })
      writeConfig(dir, (raw) => {
        raw.sources = [{ id: 'api', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz' }], discovered: { foundAt: 'src/server.ts:1' } }]
      })
      const result = await doctor(dir, { live: true, prove: true })
      expect(find(result.checks, 'source.assertion-vacuous')?.status).toBe('fail')
    } finally {
      await target.close()
    }
  })

  it('names a skip for a source kind with no prover', async () => {
    const { dir } = await seeded('doctor-unsupported')
    writeConfig(dir, (raw) => {
      raw.sources = [{ id: 'hooks', type: 'webhook', tokenEnv: 'HOOKS_TOKEN' }]
    })
    const g = guard()
    g.set({ HOOKS_TOKEN: 'set' })
    const result = await doctor(dir, { prove: true })
    const skip = find(result.checks, 'source.prove-unsupported')
    expect(skip?.status).toBe('skip')
    expect(skip?.message).toContain('webhook')
  })
})

describe('watcher doctor --live', () => {
  it('reads /api/doctor and /api/state without polling a source, and merges the server rows', async () => {
    const { dir, port } = await seeded('doctor-live')
    const observed: Array<Record<string, string>> = []
    const server = await fakeServer((req, res) => {
      observed.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? '') })
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
        res.end(JSON.stringify({ ok: true, checks: [{ code: 'source.bare-200', status: 'warn', message: 'server says a target is bare' }], observations: [] }))
        return
      }
      if (req.url === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ generatedAt: new Date().toISOString(), sources: [{ id: 'api', kind: 'http-probe', state: 'ok', lastAttempt: new Date().toISOString(), asserted: 1 }], incidents: [], health: [], channels: [] }))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
    try {
      const g = guard()
      g.set({ WATCHER_PORT: String(server.port) })
      writeConfig(dir, (raw) => {
        raw.sources = [{ id: 'api', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz', expectJson: { ok: true } }], discovered: { foundAt: 'src/server.ts:1' } }]
      })
      const result = await doctor(dir, { live: true })
      expect(result.live).toBe(true)
      expect(find(result.checks, 'server.healthz')?.status).toBe('pass')
      expect(find(result.checks, 'source.bare-200')?.status).toBe('warn')
      expect(find(result.checks, 'source.live')?.status).toBe('pass')
      expect(result.ok).toBe(true)
      // probePort asks /healthz and /api/instance unauthenticated (it is identifying the port);
      // the doctor's own reads carry the admin bearer.
      expect(observed.filter((r) => r.path === '/api/doctor' || r.path === '/api/state').every((r) => r.auth === 'Bearer admin-token-for-tests')).toBe(true)
      expect(observed.map((r) => r.path)).not.toContain('/api/incidents')
      void port
    } finally {
      await server.close()
    }
  })

  it('fails server.auth on a 401 from /api/state', async () => {
    const { dir } = await seeded('doctor-401')
    const server = await fakeServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        return
      }
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"unauthorized"}')
    })
    try {
      const g = guard()
      g.set({ WATCHER_PORT: String(server.port) })
      const result = await doctor(dir, { live: true })
      expect(find(result.checks, 'server.auth')?.status).toBe('fail')
      expect(result.ok).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('fails server.down when nothing answers', async () => {
    const { dir } = await seeded('doctor-down')
    const result = await doctor(dir, { live: true })
    expect(find(result.checks, 'server.down')?.status).toBe('fail')
    expect(result.ok).toBe(false)
  })

  it('merges the server own bare-200 row and does not count that source as live', async () => {
    const { dir } = await seeded('doctor-bare-live')
    const server = await fakeServer((req, res) => {
      if (req.url === '/healthz' || req.url === '/api/instance') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(req.url === '/healthz' ? '{"ok":true}' : JSON.stringify({ brand: { name: 'EZO Watcher', shortName: 'Watcher' }, features: [] }))
        return
      }
      if (req.url === '/api/doctor') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, checks: [{ code: 'source.bare-200', status: 'fail', message: 'source api asserts only a nominal HTTP 200' }], observations: [] }))
        return
      }
      if (req.url === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ generatedAt: new Date().toISOString(), sources: [{ id: 'api', kind: 'http-probe', state: 'ok', lastAttempt: new Date().toISOString(), asserted: 0 }], incidents: [], health: [], channels: [] }))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
    try {
      const g = guard()
      g.set({ WATCHER_PORT: String(server.port) })
      writeConfig(dir, (raw) => {
        raw.sources = [{ id: 'api', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz' }], discovered: { foundAt: 'src/server.ts:1' } }]
      })
      const result = await doctor(dir, { live: true })
      expect(find(result.checks, 'source.bare-200')?.status).toBe('fail')
      expect(find(result.checks, 'source.live')).toBeUndefined()
      expect(result.live).toBe(false)
    } finally {
      await server.close()
    }
  })
})

describe('the no-runtime-surface verdict', () => {
  it('returns ok with live:false and the documented reason when nothing runs', async () => {
    const { dir } = await seeded('doctor-surface')
    copyFileSync(fileURLToPath(new URL('./fixtures/empty-project/README.md', import.meta.url)), join(dir, 'README.md'))
    const result = await doctor(dir, { noRuntimeSurface: true })
    expect(result.ok).toBe(true)
    expect(result.live).toBe(false)
    expect(result.reason).toBe('no-runtime-surface')
    expect(find(result.checks, 'doctor.no-runtime-surface-ignored')).toBeUndefined()
  })

  it('does not answer the verdict for a configured host source, and warns which source is watchable', async () => {
    const { dir } = await seeded('doctor-surface-host')
    writeConfig(dir, (raw) => {
      raw.sources = [{ id: 'host', type: 'host' }]
    })
    const result = await doctor(dir, { noRuntimeSurface: true })
    expect(result.reason).toBeUndefined()
    expect(result.ok).toBe(true)
    const warn = find(result.checks, 'doctor.no-runtime-surface-ignored')
    expect(warn?.status).toBe('warn')
    expect(warn?.message).toContain('source host (host)')
    expect(warn?.message).toContain('--no-runtime-surface')
    expect(warn?.next).toContain('--live --prove')
  })

  it('evaluates a configured host source live instead of answering the verdict', async () => {
    const { dir } = await seeded('doctor-surface-host-live')
    writeConfig(dir, (raw) => {
      raw.sources = [{ id: 'host', type: 'host' }]
      raw.channels = [{ id: 'wall', type: 'file' }]
    })
    const target = await fakeServer((req, res) => {
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
        res.end(JSON.stringify({ generatedAt: new Date().toISOString(), sources: [{ id: 'host', kind: 'host', state: 'ok', lastAttempt: new Date().toISOString(), asserted: 1 }], incidents: [], health: [], channels: [] }))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
    try {
      const g = guard()
      g.set({ WATCHER_PORT: String(target.port) })
      const result = await doctor(dir, { live: true, prove: true, noRuntimeSurface: true })
      expect(result.reason).toBeUndefined()
      expect(find(result.checks, 'source.proven')?.status).toBe('pass')
      expect(find(result.checks, 'doctor.no-runtime-surface-ignored')?.status).toBe('warn')
      expect(result.live).toBe(true)
      expect(result.ok).toBe(true)
    } finally {
      await target.close()
    }
  })

  it('keeps the verdict off when the scan finds a surface, and warns where', async () => {
    const { dir } = await seeded('doctor-surface-scan')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'server.js'),
      ["const express = require('express')", 'const app = express()', "app.get('/healthz', (req, res) => res.json({ ok: true }))", 'app.listen(3000, () => console.log("up"))'].join('\n')
    )
    const result = await doctor(dir, { noRuntimeSurface: true })
    expect(result.reason).toBeUndefined()
    expect(result.ok).toBe(true)
    const warn = find(result.checks, 'doctor.no-runtime-surface-ignored')
    expect(warn?.status).toBe('warn')
    expect(warn?.message).toContain('http-probe')
    expect(warn?.message).toContain('src/server.js:3')
  })

  it('warns doctor.scan-failed, naming the error, when the scan throws instead of reading as nothing found', async () => {
    const { dir } = await seeded('doctor-surface-scan-failed')
    copyFileSync(fileURLToPath(new URL('./fixtures/empty-project/README.md', import.meta.url)), join(dir, 'README.md'))
    const result = await doctor(dir, {
      noRuntimeSurface: true,
      scanImpl: () => {
        throw new Error('walk failed: EACCES')
      }
    })
    expect(result.reason).toBeUndefined()
    expect(result.ok).toBe(true)
    const warn = find(result.checks, 'doctor.scan-failed')
    expect(warn?.status).toBe('warn')
    expect(warn?.message).toContain('walk failed: EACCES')
    expect(warn?.next).toContain('watcher scan --json')
  })
})
