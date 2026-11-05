// `watcher mcp`: spawn the real bin against a stub /mcp and speak JSON-RPC over its stdin/stdout, the way an MCP client does.
// The bridge lists the tools locally and forwards every call to the running Watcher with WATCHER_MCP_TOKEN from .watcher/.env;
// when the Watcher is down it still lists the tools and answers each call with the command that starts the Watcher.
import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { INIT_SPEC, runInit } from '../../src/cli/init.ts'
import { MCP_CONFIG_SPEC, runMcpConfig } from '../../src/cli/status.ts'
import { readEnvVars, resolveProject } from '../../src/cli/project.ts'
import { EnvGuard, WATCHER_KEYS, capture, fakeServer, parse, readJson, rmTemp, tempDir } from './helpers.ts'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const guards: Array<() => void> = []
const dirs: string[] = []

function guard(): EnvGuard {
  const g = new EnvGuard(WATCHER_KEYS)
  guards.push(() => g.restore())
  return g
}

const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
  }
  for (const restore of guards.splice(0)) restore()
  for (const dir of dirs.splice(0)) rmTemp(dir)
})

async function seeded(prefix: string): Promise<{ dir: string; token: string }> {
  const g = guard()
  g.set({ WATCHER_ACK_SECRET: 'ack-test', WATCHER_MCP_TOKEN: undefined, WATCHER_PORT: undefined, WATCHER_HOST: undefined, WATCHER_CONFIG: undefined, WATCHER_DATA_DIR: undefined })
  const dir = tempDir(prefix)
  dirs.push(dir)
  expect(await runInit(parse(['init', '--dir', dir], INIT_SPEC), capture('json').out)).toBe(0)
  // The project the bridge reads: a config (any source) and the token runInit wrote to .watcher/.env.
  const path = join(dir, '.watcher', 'config.json')
  const raw = readJson(path)
  raw.channels = []
  raw.routes = []
  raw.sources = [{ id: 'probe', type: 'http-probe', targets: [{ id: 'api', service: 'api', url: 'https://api.example.com/healthz' }] }]
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path, JSON.stringify(raw, null, 2))
  const token = readEnvVars(join(dir, '.watcher', '.env')).get('WATCHER_MCP_TOKEN') ?? ''
  expect(token.length).toBeGreaterThanOrEqual(32)
  return { dir, token }
}

interface Rpc {
  jsonrpc?: string
  id?: number
  result?: any
  error?: { message?: string }
}

/** A tiny MCP client over the child's stdio: one JSON-RPC message per line. */
function client(child: ChildProcessWithoutNullStreams) {
  let buffer = ''
  const pending = new Map<number, (value: Rpc) => void>()
  const seen: Rpc[] = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl === -1) break
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line === '') continue
      let msg: Rpc
      try {
        msg = JSON.parse(line) as Rpc
      } catch {
        continue
      }
      seen.push(msg)
      if (typeof msg.id === 'number') pending.get(msg.id)?.(msg)
    }
  })
  const send = (msg: unknown): void => {
    child.stdin.write(`${JSON.stringify(msg)}\n`)
  }
  const request = (id: number, method: string, params: unknown = {}): Promise<Rpc> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} in 8 s; saw ${JSON.stringify(seen.slice(-3))}`)), 8000)
      pending.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      send({ jsonrpc: '2.0', id, method, params })
    })
  return { send, request }
}

function start(dir: string, args: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ['bin/watcher.mjs', 'mcp', '--dir', dir, ...args], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, WATCHER_MCP_TOKEN: undefined, WATCHER_PORT: undefined, WATCHER_HOST: undefined }
  })
  children.push(child)
  return child
}

async function stub(token: string) {
  const calls: Array<{ method: string; name?: string; authorization?: string }> = []
  const server = await fakeServer((req, res, body) => {
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if ((req.url ?? '') !== '/mcp' || req.method !== 'POST') return json(404, { error: 'not found' })
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'unauthorized' })
    const rpc = JSON.parse(body) as { id: number; method: string; params?: { name?: string } }
    calls.push({ method: rpc.method, ...(rpc.params?.name ? { name: rpc.params.name } : {}), authorization: req.headers.authorization as string | undefined })
    if (rpc.method === 'initialize') {
      return json(200, { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'ezo-watcher', title: 'EZO Watcher', version: '1.0.0' }, instructions: 'read freely' } })
    }
    if (rpc.method === 'tools/call') {
      return json(200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ key: 'Api|ProbeDown', title: 'ProbeDown', from: 'stub' }) }] }
      })
    }
    return json(200, { jsonrpc: '2.0', id: rpc.id, result: {} })
  })
  return { server, calls }
}

async function closeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdin.end()
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

describe('watcher mcp over stdio', () => {
  it('answers initialize and tools/list locally, then forwards a tools/call to the running Watcher with the token from .watcher/.env', async () => {
    const { dir, token } = await seeded('mcp-stdio')
    const { server, calls } = await stub(token)
    try {
      const child = start(dir, ['--url', server.url])
      const c = client(child)
      const init = await c.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      expect(init.result?.serverInfo).toMatchObject({ name: 'ezo-watcher' })
      expect(String(init.result?.instructions)).toContain('stdio')
      c.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

      const list = await c.request(2, 'tools/list')
      const names = (list.result?.tools as Array<{ name: string }>).map((t) => t.name)
      expect(names).toHaveLength(16)
      expect(names).toContain('get_fix_context')
      expect(names).toContain('verify_fix')
      expect(calls).toHaveLength(0)

      const call = await c.request(3, 'tools/call', { name: 'get_fix_context', arguments: { key: 'Api|ProbeDown' } })
      expect(call.result?.isError).not.toBe(true)
      expect(call.result?.content?.[0]?.text).toContain('ProbeDown')
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ method: 'tools/call', name: 'get_fix_context', authorization: `Bearer ${token}` })
      await closeChild(child)
    } finally {
      await server.close()
    }
  })

  it('answers every tool with the command that starts the Watcher when nothing is listening', async () => {
    const { dir } = await seeded('mcp-stdio-down')
    const child = start(dir, ['--url', 'http://127.0.0.1:1'])
    const c = client(child)
    const init = await c.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(init.result?.serverInfo).toBeDefined()
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const list = await c.request(2, 'tools/list')
    expect((list.result?.tools as Array<{ name: string }>).length).toBe(16)
    const call = await c.request(3, 'tools/call', { name: 'watch_state', arguments: {} })
    expect(call.result?.isError).toBe(true)
    expect(call.result?.content?.[0]?.text).toContain('watcher run --detach')
    await closeChild(child)
  })

  it('names the missing token rather than starting a second engine', async () => {
    const { dir } = await seeded('mcp-stdio-no-token')
    const envPath = join(dir, '.watcher', '.env')
    const { writeFileSync } = await import('node:fs')
    const text = (await import('node:fs')).readFileSync(envPath, 'utf8').replace(/^WATCHER_MCP_TOKEN=.*$/m, '')
    writeFileSync(envPath, text)
    const child = start(dir, ['--url', 'http://127.0.0.1:1'])
    const c = client(child)
    await c.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    const call = await c.request(2, 'tools/call', { name: 'watch_state', arguments: {} })
    expect(call.result?.isError).toBe(true)
    expect(call.result?.content?.[0]?.text).toContain('WATCHER_MCP_TOKEN is not set')
    await closeChild(child)
  })
})

describe('watcher mcp-config', () => {
  it('prints the stdio form first and the HTTP form second', async () => {
    const { dir } = await seeded('mcp-config-forms')
    const project = resolveProject(dir)
    const cap = capture('json')
    expect(await runMcpConfig(parse(['mcp-config', '--dir', dir, '--client', 'claude'], MCP_CONFIG_SPEC), cap.out)).toBe(0)
    const out = JSON.parse(cap.stdout()) as { stdio: string; forms: { stdio: { value: string }; http: { value: string } } }
    // The stdio form starts the executable this CLI is running from, not a package name npm could resolve to
    // a stale cached copy (the live-run finding: `npx ezo-watcher` had no `mcp` verb).
    expect(out.stdio).toContain('claude mcp add ezo-watcher -- ')
    expect(out.stdio).toContain(process.execPath)
    expect(out.stdio).toContain('mcp --dir')
    expect(out.stdio).toContain(project.dir)
    expect(out.stdio).toContain('bin/watcher.mjs')
    expect(out.forms.http.value).toContain('claude mcp add --transport http ezo-watcher')
    expect(out.forms.stdio.value).toBe(out.stdio)
    expect((out as Record<string, unknown>).config).toBeUndefined()

    const table = capture('table')
    expect(await runMcpConfig(parse(['mcp-config', '--dir', dir, '--client', 'cursor'], MCP_CONFIG_SPEC), table.out)).toBe(0)
    const text = table.stdout()
    const stdioAt = text.indexOf('stdio: local process, first')
    const httpAt = text.indexOf('HTTP: remote or shared, second')
    expect(stdioAt).toBeGreaterThanOrEqual(0)
    expect(httpAt).toBeGreaterThan(stdioAt)
    const stdioSection = text.slice(stdioAt, httpAt)
    expect(stdioSection).toContain(`"command": ${JSON.stringify(process.execPath)}`)
    expect(stdioSection).toContain('"mcp"')
    expect(text).not.toContain('npx')
  })
})
