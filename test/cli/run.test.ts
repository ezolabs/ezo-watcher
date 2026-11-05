import { describe, expect, it, afterEach, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { INIT_SPEC, runInit } from '../../src/cli/init.ts'
import { RUN_SPEC, STOP_SPEC, runRun, runStop, loadProjectEnv, SERVER_ENTRY } from '../../src/cli/run.ts'
import { installService, serviceName, uninstallService } from '../../src/cli/service.ts'
import { EnvGuard, WATCHER_KEYS, capture, fakeServer, freePort, parse, rmTemp, tempDir } from './helpers.ts'

const BIN = fileURLToPath(new URL('../../bin/watcher.mjs', import.meta.url))
const dirs: string[] = []
const guards: Array<() => void> = []

function temp(prefix: string): string {
  const dir = tempDir(prefix)
  dirs.push(dir)
  return dir
}

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
  g.set({ WATCHER_ACK_SECRET: 'ack-for-run', WATCHER_ADMIN_TOKEN: 'admin-for-run', WATCHER_MCP_TOKEN: 'mcp-for-run', WATCHER_PORT: String(port), ...env })
  const dir = temp(prefix)
  expect(await runInit(parse(['init', '--dir', dir], INIT_SPEC), capture('json').out)).toBe(0)
  g.set({ WATCHER_ACK_SECRET: 'ack-for-run', WATCHER_ADMIN_TOKEN: 'admin-for-run', WATCHER_MCP_TOKEN: 'mcp-for-run', WATCHER_PORT: String(port) })
  return { dir, port }
}

describe('watcher run', () => {
  it('names src/server/main.ts as the entry it imports, not the bundle', () => {
    expect(SERVER_ENTRY).toBe('src/server/main.ts')
  })

  it('loads .watcher/.env without overriding an exported value', () => {
    const dir = temp('run-env')
    const envFile = join(dir, 'test.env')
    writeFileSync(envFile, 'WATCHER_RUN_TEST_ONE=from-file\nWATCHER_RUN_TEST_TWO=from-file\n')
    const g = guard()
    g.set({ WATCHER_RUN_TEST_TWO: 'from-parent' } as Record<string, string>)
    delete process.env.WATCHER_RUN_TEST_ONE
    try {
      expect(loadProjectEnv(envFile)).toBe(true)
      expect(process.env.WATCHER_RUN_TEST_ONE).toBe('from-file')
      expect(process.env.WATCHER_RUN_TEST_TWO).toBe('from-parent')
    } finally {
      delete process.env.WATCHER_RUN_TEST_ONE
      delete process.env.WATCHER_RUN_TEST_TWO
    }
  })

  it('fails when the project has no .env yet', async () => {
    const g = guard()
    g.set({ WATCHER_ACK_SECRET: 'x' })
    const dir = temp('run-noenv')
    await expect(runRun(parse(['run', '--dir', dir], RUN_SPEC), capture('json').out)).rejects.toMatchObject({ code: 'run.no-env' })
  })

  it('fails with run.missing-secret when WATCHER_ACK_SECRET is absent from the shell and the file', async () => {
    const { dir } = await seeded('run-secret')
    const envPath = join(dir, '.watcher', '.env')
    writeFileSync(envPath, readFileSync(envPath, 'utf8').replace(/^WATCHER_ACK_SECRET=.*$/m, 'WATCHER_ACK_SECRET='))
    const g = guard()
    g.set({ WATCHER_ACK_SECRET: undefined })
    await expect(runRun(parse(['run', '--dir', dir], RUN_SPEC), capture('json').out)).rejects.toMatchObject({ code: 'run.missing-secret' })
  })

  it('refuses a port another process holds', async () => {
    const { dir } = await seeded('run-port')
    const other = await fakeServer((req, res) => {
      res.writeHead(404)
      res.end('{}')
    })
    try {
      const g = guard()
      g.set({ WATCHER_PORT: String(other.port) })
      await expect(runRun(parse(['run', '--dir', dir], RUN_SPEC), capture('json').out)).rejects.toMatchObject({ code: 'port.in-use' })
    } finally {
      await other.close()
    }
  })
})

describe('watcher stop', () => {
  it('says not running when there is no pid file and nothing answers', async () => {
    const { dir } = await seeded('stop-none')
    const cap = capture('json')
    expect(await runStop(parse(['stop', '--dir', dir], STOP_SPEC), cap.out)).toBe(0)
    expect(JSON.parse(cap.stdout())).toMatchObject({ ok: true, stopped: false, reason: 'not-running' })
  })

  it('removes a stale pid file', async () => {
    const { dir } = await seeded('stop-stale')
    writeFileSync(join(dir, '.watcher', 'data', 'watcher.pid'), '999999\n')
    const cap = capture('json')
    expect(await runStop(parse(['stop', '--dir', dir], STOP_SPEC), cap.out)).toBe(0)
    expect(JSON.parse(cap.stdout())).toMatchObject({ ok: true, stopped: false, reason: 'stale-pid' })
    expect(existsSync(join(dir, '.watcher', 'data', 'watcher.pid'))).toBe(false)
  })

  it('SIGTERMs the process named by the pid file', async () => {
    const { dir } = await seeded('stop-live')
    // A Watcher-shaped command line: `stop` verifies the pid before signalling, so a bare `sleep` would be refused.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', BIN], { stdio: 'ignore' })
    writeFileSync(join(dir, '.watcher', 'data', 'watcher.pid'), `${child.pid}\n`)
    let alive = true
    child.once('exit', () => { alive = false })
    const cap = capture('json')
    expect(await runStop(parse(['stop', '--dir', dir], STOP_SPEC), cap.out)).toBe(0)
    expect(JSON.parse(cap.stdout())).toMatchObject({ ok: true, stopped: true, pid: child.pid })
    expect(alive).toBe(false)
    expect(existsSync(join(dir, '.watcher', 'data', 'watcher.pid'))).toBe(false)
  })

  it('refuses a pid that is not a Watcher, and leaves the process alone', async () => {
    const { dir } = await seeded('stop-recycled')
    const child = spawn('sleep', ['60'], { stdio: 'ignore' })
    writeFileSync(join(dir, '.watcher', 'data', 'watcher.pid'), `${child.pid}\n`)
    let alive = true
    child.once('exit', () => { alive = false })
    try {
      await expect(runStop(parse(['stop', '--dir', dir], STOP_SPEC), capture('json').out)).rejects.toMatchObject({ code: 'stop.not-watcher' })
      expect(alive).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('does not mistake EPERM for a dead process: it sends SIGTERM anyway and keeps the pid file when the signal is refused', async () => {
    const { dir } = await seeded('stop-eperm-denied')
    const pidPath = join(dir, '.watcher', 'data', 'watcher.pid')
    writeFileSync(pidPath, '424242\n')
    const signals: Array<string | number> = []
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      void pid
      signals.push(signal ?? 0)
      const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    }) as typeof process.kill)
    try {
      await expect(runStop(parse(['stop', '--dir', dir], STOP_SPEC), capture('json').out)).rejects.toMatchObject({ code: 'stop.denied', exitCode: 1 })
    } finally {
      kill.mockRestore()
    }
    // The probe answered EPERM, and a SIGTERM was attempted anyway rather than the pid file being called stale.
    expect(signals).toContain('SIGTERM')
    // The pid file survives a denied stop, so a retry (or the user who started it) can still find the process.
    expect(existsSync(pidPath)).toBe(true)
  })

  it('sends SIGTERM when the existence probe answers EPERM, and stops the process', async () => {
    const { dir } = await seeded('stop-eperm-signal')
    const pidPath = join(dir, '.watcher', 'data', 'watcher.pid')
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', BIN], { stdio: 'ignore' })
    writeFileSync(pidPath, `${child.pid}\n`)
    let alive = true
    child.once('exit', () => { alive = false })
    const real = process.kill.bind(process)
    let probed = false
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (!probed && (signal === 0 || signal === undefined)) {
        probed = true
        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      return real(pid, signal as NodeJS.Signals)
    }) as typeof process.kill)
    try {
      const cap = capture('json')
      expect(await runStop(parse(['stop', '--dir', dir], STOP_SPEC), cap.out)).toBe(0)
      expect(JSON.parse(cap.stdout())).toMatchObject({ ok: true, stopped: true, pid: child.pid })
    } finally {
      kill.mockRestore()
    }
    expect(alive).toBe(false)
    expect(existsSync(pidPath)).toBe(false)
  })
})

describe('watcher service (temp HOME, not loaded)', () => {
  it('writes a launchd plist or a systemd unit for the project and removes it again', async () => {
    const { dir } = await seeded('service')
    const home = temp('service-home')
    const g = guard()
    g.set({ HOME: home })
    const result = await installService({ projectDir: dir, withTunnel: false, force: true, dryRun: false, load: false })
    expect(result.ok).toBe(true)
    expect(existsSync(result.path)).toBe(true)
    const text = readFileSync(result.path, 'utf8')
    expect(text).toContain(dir)
    expect(text).toContain('run')
    expect(text).toContain('--dir')
    if (process.platform === 'darwin') {
      expect(result.path).toContain(join(home, 'Library', 'LaunchAgents'))
      expect(text).toContain('<key>KeepAlive</key>')
    } else {
      expect(result.path).toContain(join(home, '.config', 'systemd', 'user'))
      expect(text).toContain('Restart=always')
    }
    const removed = await uninstallService({ projectDir: dir, dryRun: false })
    expect(removed.removed).toContain(result.path)
    expect(existsSync(result.path)).toBe(false)
    expect(serviceName(dir)).toContain('watcher-')
  })

  it('is idempotent only with --force when the file exists', async () => {
    const { dir } = await seeded('service-force')
    const home = temp('service-home2')
    const g = guard()
    g.set({ HOME: home })
    await installService({ projectDir: dir, withTunnel: false, force: false, dryRun: false, load: false })
    await expect(installService({ projectDir: dir, withTunnel: false, force: false, dryRun: false, load: false })).rejects.toMatchObject({ code: 'service.exists' })
    await expect(installService({ projectDir: dir, withTunnel: false, force: true, dryRun: false, load: false })).resolves.toMatchObject({ ok: true })
  })
})
