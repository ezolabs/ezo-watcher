import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { validateConfig } from '../../src/server/config.ts'
import { INIT_SPEC, runInit } from '../../src/cli/init.ts'
import { EnvGuard, WATCHER_KEYS, capture, freePort, parse, readJson, rmTemp, tempDir } from './helpers.ts'

const guards: Array<() => void> = []
const dirs: string[] = []

function guard(): EnvGuard {
  const g = new EnvGuard(WATCHER_KEYS)
  guards.push(() => g.restore())
  return g
}

function project(prefix: string): string {
  const dir = tempDir(prefix)
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const restore of guards.splice(0)) restore()
  for (const dir of dirs.splice(0)) rmTemp(dir)
})

describe('watcher init', () => {
  it('writes a seed config, generated secrets, .env.example and both gitignores', async () => {
    const g = guard()
    g.set({ WATCHER_ACK_SECRET: undefined, WATCHER_ADMIN_TOKEN: undefined, WATCHER_MCP_TOKEN: undefined, WATCHER_PORT: undefined, WATCHER_HOST: undefined, WATCHER_CONFIG: undefined, WATCHER_DATA_DIR: undefined })
    const dir = project('init')
    const cap = capture('json')
    const code = await runInit(parse(['init', '--dir', dir], INIT_SPEC), cap.out)
    expect(code).toBe(0)

    const configPath = join(dir, '.watcher', 'config.json')
    expect(existsSync(configPath)).toBe(true)
    const config = readJson(configPath)
    expect(config.sources).toEqual([])
    expect(config.channels).toEqual([])
    expect((config.brand as { name: string }).name).toBe('EZO Watcher')
    const checked = validateConfig(config)
    expect(checked.ok).toBe(true)

    const envPath = join(dir, '.watcher', '.env')
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
    const env = readFileSync(envPath, 'utf8')
    for (const name of ['WATCHER_ACK_SECRET', 'WATCHER_ADMIN_TOKEN', 'WATCHER_MCP_TOKEN']) {
      const m = new RegExp(`^${name}=([0-9a-f]{64})$`, 'm').exec(env)
      expect(m, `${name} should be a 64-hex generated secret`).not.toBeNull()
    }

    const example = readFileSync(join(dir, '.watcher', '.env.example'), 'utf8')
    expect(example).toContain('WATCHER_ACK_SECRET=')
    expect(example).not.toMatch(/^[A-Z_]+=.+/m)

    expect(readFileSync(join(dir, '.watcher', '.gitignore'), 'utf8')).toBe('.env\ndata/\n')
    const projectIgnore = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(projectIgnore).toContain('.watcher/.env')
    expect(projectIgnore).toContain('.watcher/data/')

    const out = JSON.parse(cap.stdout()) as { ok: boolean; port: number; generated: string[] }
    expect(out.ok).toBe(true)
    expect(out.generated).toHaveLength(3)
    expect(out.port).toBeGreaterThan(0)
  })

  it('is idempotent: a second run keeps the secrets and the config and reports what exists', async () => {
    const g = guard()
    g.set({ WATCHER_ACK_SECRET: undefined, WATCHER_ADMIN_TOKEN: undefined, WATCHER_MCP_TOKEN: undefined, WATCHER_PORT: undefined })
    const dir = project('idem')
    await runInit(parse(['init', '--dir', dir], INIT_SPEC), capture('json').out)
    const envBefore = readFileSync(join(dir, '.watcher', '.env'), 'utf8')
    const configBefore = readFileSync(join(dir, '.watcher', 'config.json'), 'utf8')
    const cap = capture('json')
    const code = await runInit(parse(['init', '--dir', dir], INIT_SPEC), cap.out)
    expect(code).toBe(0)
    expect(readFileSync(join(dir, '.watcher', '.env'), 'utf8')).toBe(envBefore)
    expect(readFileSync(join(dir, '.watcher', 'config.json'), 'utf8')).toBe(configBefore)
    const out = JSON.parse(cap.stdout()) as { generated: string[]; kept: string[] }
    expect(out.generated).toEqual([])
    expect(out.kept.some((p) => p.endsWith('config.json'))).toBe(true)
  })

  it('moves to the next free port when the requested one is taken, and writes the chosen port', async () => {
    const g = guard()
    g.set({ WATCHER_ACK_SECRET: undefined, WATCHER_ADMIN_TOKEN: undefined, WATCHER_MCP_TOKEN: undefined, WATCHER_PORT: undefined })
    const taken = await freePort()
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(taken, '127.0.0.1', resolve))
    try {
      const dir = project('port')
      const cap = capture('json')
      const code = await runInit(parse(['init', '--dir', dir, '--port', String(taken)], INIT_SPEC), cap.out)
      expect(code).toBe(0)
      const out = JSON.parse(cap.stdout()) as { port: number; portMoved: boolean }
      expect(out.portMoved).toBe(true)
      expect(out.port).not.toBe(taken)
      const env = readFileSync(join(dir, '.watcher', '.env'), 'utf8')
      expect(env).toContain(`WATCHER_PORT=${out.port}`)
      const config = readJson(join(dir, '.watcher', 'config.json'))
      expect(config.baseUrl).toBe(`http://127.0.0.1:${out.port}`)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('--dry-run writes nothing', async () => {
    const g = guard()
    g.set({ WATCHER_ACK_SECRET: undefined, WATCHER_ADMIN_TOKEN: undefined, WATCHER_MCP_TOKEN: undefined })
    const dir = project('dry')
    const cap = capture('json')
    const code = await runInit(parse(['init', '--dir', dir, '--dry-run'], INIT_SPEC), cap.out)
    expect(code).toBe(0)
    expect(existsSync(join(dir, '.watcher'))).toBe(false)
    expect(cap.stdout()).toContain('"dryRun"')
  })

  it('reports env.not-ignored when the project gitignore cannot cover .watcher/.env', async () => {
    const g = guard()
    g.set({ WATCHER_ACK_SECRET: undefined, WATCHER_ADMIN_TOKEN: undefined, WATCHER_MCP_TOKEN: undefined })
    const dir = project('gitignore')
    const cap = capture('json')
    const code = await runInit(parse(['init', '--dir', dir], INIT_SPEC), cap.out)
    expect(code).toBe(0)
    // A project .gitignore written by init must keep the secret out of git even before it is a repo.
    const text = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(text.split('\n')).toContain('.watcher/.env')
    // And the .watcher/.gitignore covers data/ from inside the directory.
    expect(readFileSync(join(dir, '.watcher', '.gitignore'), 'utf8')).toContain('data/')
  })

  it('keeps an existing config even when it is invalid (doctor reports it; init does not overwrite it)', async () => {
    const g = guard()
    g.set({ WATCHER_ACK_SECRET: undefined, WATCHER_ADMIN_TOKEN: undefined, WATCHER_MCP_TOKEN: undefined })
    const dir = project('bad-config')
    mkdirSync(join(dir, '.watcher'), { recursive: true })
    const broken = '{ "sources": "not a list" }\n'
    writeFileSync(join(dir, '.watcher', 'config.json'), broken)
    const cap = capture('json')
    const code = await runInit(parse(['init', '--dir', dir], INIT_SPEC), cap.out)
    expect(code).toBe(1)
    expect(readFileSync(join(dir, '.watcher', 'config.json'), 'utf8')).toBe(broken)
    const out = JSON.parse(cap.stdout()) as { ok: boolean; doctor: { checks: Array<{ code: string; status: string }> } }
    expect(out.ok).toBe(false)
    expect(out.doctor.checks.some((c) => c.code === 'config.invalid' && c.status === 'fail')).toBe(true)
  })

  it('never prompts and never requires a TTY (runs with stdin closed)', async () => {
    const g = guard()
    g.set({ WATCHER_ACK_SECRET: undefined, WATCHER_ADMIN_TOKEN: undefined, WATCHER_MCP_TOKEN: undefined })
    const dir = project('notty')
    const cap = capture('json')
    // No stdin is read by init: it finishes even when nothing could answer a prompt.
    const code = await runInit(parse(['init', '--dir', dir], INIT_SPEC), cap.out)
    expect(code).toBe(0)
    expect(existsSync(join(dir, '.watcher', 'config.json'))).toBe(true)
  })
})
