// `watcher telemetry status|enable|disable`, and what main() records for a run: the verb, flag names, exit code and the doctor
// codes, seen through WATCHER_TELEMETRY_DEBUG=1 (which prints the payload and sends nothing). XDG_CONFIG_HOME points at a temp
// dir in every case, so the real ~/.config is never touched; the vitest guard is lifted only where a case needs telemetry on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, telemetryCommandOf } from '../../src/cli/main.ts'
import { finishCliTelemetry } from '../../src/cli/telemetry.ts'
import { Telemetry } from '../../src/shared/telemetry.ts'
import type { TelemetryFile } from '../../src/shared/telemetry.ts'
import { parseBatch } from '../../src/shared/telemetry-schema.ts'
import type { TelemetryBatch } from '../../src/shared/telemetry-schema.ts'

const dirs: string[] = []
let config = ''
let stdout = ''
let stderr = ''

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `watcher-cli-${prefix}-`))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  config = temp('telemetry-config')
  vi.stubEnv('XDG_CONFIG_HOME', config)
  for (const name of ['DO_NOT_TRACK', 'WATCHER_TELEMETRY_DISABLED', 'WATCHER_TELEMETRY_DEBUG']) vi.stubEnv(name, undefined)
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Lift the test-runner guard, as on a user's machine. */
function asUser(): void {
  vi.stubEnv('VITEST', '')
  vi.stubEnv('NODE_ENV', 'production')
}

const filePath = (): string => join(config, 'ezo-watcher', 'telemetry.json')
const stored = (): TelemetryFile => JSON.parse(readFileSync(filePath(), 'utf8')) as TelemetryFile

/** The payloads debug mode printed. */
function debugBatches(): TelemetryBatch[] {
  return stderr
    .split('\n')
    .filter((l) => l.startsWith('[telemetry] '))
    .map((l) => JSON.parse(l.slice(l.indexOf('{'))) as TelemetryBatch)
}

describe('watcher telemetry', () => {
  it('status reports off under the test runner and writes nothing', async () => {
    expect(await main(['telemetry', 'status', '--json'])).toBe(0)
    const status = JSON.parse(stdout) as Record<string, unknown>
    expect(status).toMatchObject({ ok: true, action: 'status', enabled: false, reason: 'test-runner', stored: null, id: null, path: filePath(), endpoint: 'https://telemetry.ezolabs.io/v1/events' })
    expect(existsSync(filePath())).toBe(false)
  })

  it('a bare `watcher telemetry` is status, in words', async () => {
    asUser()
    expect(await main(['telemetry'])).toBe(0)
    expect(stdout).toContain('telemetry enabled')
    expect(stdout).toContain('on by default')
    expect(stdout).toContain('DO_NOT_TRACK=1')
    expect(stdout).toContain(filePath())
  })

  it('disable and enable store the choice; the env still wins over an enable', async () => {
    asUser()
    expect(await main(['telemetry', 'disable', '--json'])).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ action: 'disable', enabled: false, reason: 'disabled-by-command', stored: false })
    expect(stored().enabled).toBe(false)
    stdout = ''
    expect(await main(['telemetry', 'enable', '--json'])).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ action: 'enable', enabled: true, reason: 'enabled-by-command', stored: true })
    expect(stored().chosenAt).not.toBeNull()
    stdout = ''
    vi.stubEnv('DO_NOT_TRACK', '1')
    expect(await main(['telemetry', 'enable'])).toBe(0)
    expect(stdout).toContain('DO_NOT_TRACK is set in this environment and wins')
  })

  it('--dry-run writes nothing', async () => {
    asUser()
    expect(await main(['telemetry', 'disable', '--dry-run', '--json'])).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ action: 'disable', dryRun: true, enabled: true })
    expect(existsSync(filePath())).toBe(false)
  })

  it('refuses an unknown action as a usage error', async () => {
    expect(await main(['telemetry', 'off', '--json'])).toBe(64)
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: 'telemetry.unknown-action' } })
  })

  it('records nothing about itself, not even with debug on', async () => {
    asUser()
    vi.stubEnv('WATCHER_TELEMETRY_DEBUG', '1')
    expect(await main(['telemetry', 'disable'])).toBe(0)
    expect(stderr).not.toContain('[telemetry]')
  })
})

describe('what a run records', () => {
  it('nothing, and no notice, under the test runner', async () => {
    const project = temp('project')
    await main(['doctor', '--dir', project, '--json'])
    expect(stderr).not.toContain('[telemetry]')
    expect(stderr).not.toContain('anonymous telemetry')
    expect(existsSync(filePath())).toBe(false)
  })

  it('the verb, flag names, exit code and doctor codes, and no value from the command line', async () => {
    asUser()
    vi.stubEnv('WATCHER_TELEMETRY_DEBUG', '1')
    const project = temp('project')
    const code = await main(['doctor', '--dir', project, '--json'])
    const [batch] = debugBatches()
    expect(parseBatch(batch).ok).toBe(true)
    const [command, doctor] = batch.events
    expect(command).toMatchObject({ name: 'cli.command', command: 'doctor', sub: null, flags: ['dir', 'json'], exitCode: code, errorCode: null })
    expect(doctor).toMatchObject({ name: 'doctor.result', ok: false, live: false, target: 'local' })
    expect((doctor as { failing: string[] }).failing).toContain('watcher.dir')
    expect(JSON.stringify(batch)).not.toContain(project)
    expect(existsSync(filePath())).toBe(false) // debug mode never writes the file
  })

  it('an unknown verb as `unknown`, and a CliError by its code', async () => {
    asUser()
    vi.stubEnv('WATCHER_TELEMETRY_DEBUG', '1')
    expect(await main(['deploy-prod-db', '--url', 'https://db.example.com'])).toBe(64)
    const [batch] = debugBatches()
    expect(batch.events[0]).toMatchObject({ name: 'cli.command', command: 'unknown', flags: [], exitCode: 64, errorCode: 'usage.unknown-verb' })
    expect(JSON.stringify(batch)).not.toMatch(/deploy-prod-db|example\.com/)
  })

  it('shows the first-run notice once on stderr, before the verb', async () => {
    asUser()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })))
    expect(await main(['--version'])).toBe(0)
    expect(stderr).toContain('EZO Watcher collects anonymous telemetry')
    expect(stderr).toContain('watcher telemetry disable')
    expect(stored().notifiedAt).not.toBeNull()
    stderr = ''
    expect(await main(['--version'])).toBe(0)
    expect(stderr).toBe('')
    vi.unstubAllGlobals()
  })

  it('an internal error by type, code and package frames', async () => {
    const lines: string[] = []
    const env = { XDG_CONFIG_HOME: config, WATCHER_TELEMETRY_DEBUG: '1' }
    const t = Telemetry.open({ env, print: (l) => lines.push(l) })
    const err = Object.assign(new TypeError('cannot read /srv/acme/api/.watcher/config.json'), { code: 'ERR_INVALID_ARG_TYPE' })
    await finishCliTelemetry(t, { command: 'add', sub: null, declared: ['id'], argv: ['add', 'http-probe', '--id', 'acme-api'], exitCode: 1, durationMs: 12, errorCode: 'internal.error' }, { thrown: err })
    const batch = JSON.parse(lines[0].slice(lines[0].indexOf('{'))) as TelemetryBatch
    expect(batch.events.map((e) => e.name)).toEqual(['cli.command', 'error'])
    expect(batch.events[1]).toMatchObject({ where: 'cli', command: 'add', errorName: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' })
    expect((batch.events[1] as { frames: string[] }).frames.every((f) => /^(?:src|dist)\//.test(f))).toBe(true)
    expect(JSON.stringify(batch)).not.toMatch(/acme|\/srv\//)
  })
})

describe('telemetryCommandOf', () => {
  it('names a verb, help, version or unknown, never the typed word', () => {
    expect(telemetryCommandOf(['--dir', 'x', 'doctor', '--live'])).toBe('doctor')
    expect(telemetryCommandOf(['add', '--help'])).toBe('add')
    expect(telemetryCommandOf([])).toBe('help')
    expect(telemetryCommandOf(['-v'])).toBe('version')
    expect(telemetryCommandOf(['https://example.com'])).toBe('unknown')
    expect(telemetryCommandOf(['telemetry', 'disable'])).toBe('telemetry')
  })
})
