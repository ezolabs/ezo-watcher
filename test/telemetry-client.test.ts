// The telemetry client (src/shared/telemetry.ts): who decides (env over the stored choice over the default), the first-run
// notice shown once, nothing sent under a test runner, debug mode printing instead of sending, a send that cannot fail the
// caller, the crash event kept for the next run, and one heartbeat a day. Every case passes its own env with HOME in a temp
// dir: the real home directory is never read or written.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Telemetry, decideTelemetry, envOptOut, scheduleHeartbeat, setTelemetryEnabled, telemetryConfigPath, telemetryNotice
} from '../src/shared/telemetry.ts'
import type { Env, TelemetryFile } from '../src/shared/telemetry.ts'
import { TELEMETRY_ENDPOINT, parseBatch } from '../src/shared/telemetry-schema.ts'
import type { TelemetryBatch } from '../src/shared/telemetry-schema.ts'

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function home(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-telemetry-'))
  dirs.push(dir)
  return { HOME: dir }
}

function sink() {
  const lines: string[] = []
  const sent: TelemetryBatch[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(TELEMETRY_ENDPOINT)
    sent.push(JSON.parse(String(init?.body)) as TelemetryBatch)
    return new Response(null, { status: 202 })
  })
  return { lines, sent, fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch, print: (t: string) => lines.push(t) }
}

const cmd = { name: 'cli.command' as const, at: '2026-11-05T10:00:00.000Z', command: 'doctor', sub: null, flags: ['live'], exitCode: 1, durationMs: 80, errorCode: null }
const file = (over: Partial<TelemetryFile> = {}): TelemetryFile => ({
  id: '00000000-0000-4000-8000-000000000001', enabled: true, chosenAt: null, notifiedAt: '2026-11-01T00:00:00.000Z', lastHeartbeatAt: null, backoffUntil: null, pending: [], ...over
})

describe('the config path', () => {
  it('follows XDG_CONFIG_HOME when it is absolute, and ~/.config otherwise', () => {
    expect(telemetryConfigPath({ XDG_CONFIG_HOME: '/srv/cfg', HOME: '/srv/home' })).toBe(join('/srv/cfg', 'ezo-watcher', 'telemetry.json'))
    expect(telemetryConfigPath({ XDG_CONFIG_HOME: 'relative/cfg', HOME: '/srv/home' })).toBe(join('/srv/home', '.config', 'ezo-watcher', 'telemetry.json'))
    expect(telemetryConfigPath({ HOME: '/srv/home' })).toBe(join('/srv/home', '.config', 'ezo-watcher', 'telemetry.json'))
  })
})

describe('who decides: env, then the stored choice, then the default', () => {
  const cases: Array<[string, Env, TelemetryFile | null, boolean, string]> = [
    ['no file, no env', {}, null, true, 'default'],
    ['stored disable', {}, file({ enabled: false, chosenAt: '2026-11-02T00:00:00.000Z' }), false, 'disabled-by-command'],
    ['stored enable', {}, file({ chosenAt: '2026-11-02T00:00:00.000Z' }), true, 'enabled-by-command'],
    ['DO_NOT_TRACK over a stored enable', { DO_NOT_TRACK: '1' }, file({ chosenAt: '2026-11-02T00:00:00.000Z' }), false, 'DO_NOT_TRACK'],
    ['WATCHER_TELEMETRY_DISABLED over the default', { WATCHER_TELEMETRY_DISABLED: 'true' }, null, false, 'WATCHER_TELEMETRY_DISABLED'],
    ['DO_NOT_TRACK named first when both are set', { DO_NOT_TRACK: '1', WATCHER_TELEMETRY_DISABLED: '1' }, null, false, 'DO_NOT_TRACK'],
    ['DO_NOT_TRACK=0 is not an opt-out', { DO_NOT_TRACK: '0' }, null, true, 'default'],
    ['WATCHER_TELEMETRY_DISABLED=false is not an opt-out', { WATCHER_TELEMETRY_DISABLED: 'false' }, null, true, 'default'],
    ['env cannot turn a stored disable back on', { DO_NOT_TRACK: '0' }, file({ enabled: false, chosenAt: '2026-11-02T00:00:00.000Z' }), false, 'disabled-by-command'],
    ['vitest', { VITEST: 'true' }, file(), false, 'test-runner'],
    ['NODE_ENV=test', { NODE_ENV: 'test' }, null, false, 'test-runner']
  ]
  for (const [name, env, stored, enabled, reason] of cases) {
    it(name, () => {
      expect(decideTelemetry(env, stored)).toEqual({ enabled, reason })
    })
  }

  it('is off in this very process, which runs under vitest', () => {
    expect(envOptOut(process.env)).not.toBeNull()
  })
})

describe('the first-run notice', () => {
  it('prints once, writes the id, and the second run is quiet', async () => {
    const env = home()
    const a = sink()
    const first = Telemetry.open({ env, print: a.print, fetch: a.fetch, version: '0.1.0' })
    expect(first.decision).toEqual({ enabled: true, reason: 'default' })
    expect(a.lines).toEqual([telemetryNotice()])
    expect(a.lines[0]).toContain('watcher telemetry disable')
    expect(a.lines[0]).toContain('DO_NOT_TRACK=1')
    const stored = JSON.parse(readFileSync(first.path, 'utf8')) as TelemetryFile
    expect(stored.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(stored.notifiedAt).not.toBeNull()

    const b = sink()
    const second = Telemetry.open({ env, print: b.print, fetch: b.fetch, version: '0.1.0' })
    expect(b.lines).toEqual([])
    second.record(cmd)
    await second.flush()
    expect(b.sent).toHaveLength(1)
    expect(b.sent[0].context.id).toBe(stored.id)
    expect(parseBatch(b.sent[0]).ok).toBe(true)
  })

  it('is not shown, and nothing is sent, when the config cannot be written', async () => {
    const env = home()
    writeFileSync(join(env.HOME as string, '.config'), 'a file where the config dir would go')
    const s = sink()
    const t = Telemetry.open({ env, print: s.print, fetch: s.fetch })
    expect(t.decision).toEqual({ enabled: false, reason: 'config-unwritable' })
    t.record(cmd)
    await t.flush()
    expect(s.lines).toEqual([])
    expect(s.calls).not.toHaveBeenCalled()
  })

  it('leaves a config that does not parse alone and sends nothing', async () => {
    const env = home()
    const path = telemetryConfigPath(env)
    setTelemetryEnabled(false, env)
    writeFileSync(path, '{ "enabled": false, oops')
    const s = sink()
    const t = Telemetry.open({ env, print: s.print, fetch: s.fetch })
    expect(t.decision.reason).toBe('config-unreadable')
    t.record(cmd)
    await t.flush()
    expect(s.calls).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toBe('{ "enabled": false, oops')
  })
})

describe('nothing leaves under a test runner or an opt-out', () => {
  for (const env of [{ VITEST: 'true' }, { NODE_ENV: 'test' }, { DO_NOT_TRACK: '1' }, { WATCHER_TELEMETRY_DISABLED: '1' }]) {
    it(`${Object.keys(env)[0]}: no notice, no file, no request`, async () => {
      const e = { ...home(), ...env }
      const s = sink()
      const t = Telemetry.open({ env: e, print: s.print, fetch: s.fetch })
      expect(t.active).toBe(false)
      t.record(cmd)
      t.captureError(new Error('boom'), 'cli')
      await t.flush()
      expect(s.calls).not.toHaveBeenCalled()
      expect(s.lines).toEqual([])
      expect(existsSync(t.path)).toBe(false)
    })
  }

  it('a stored disable stops the next process', async () => {
    const env = home()
    setTelemetryEnabled(false, env)
    const s = sink()
    const t = Telemetry.open({ env, print: s.print, fetch: s.fetch })
    t.record(cmd)
    await t.flush()
    expect(t.decision.reason).toBe('disabled-by-command')
    expect(s.calls).not.toHaveBeenCalled()
  })
})

describe('debug mode', () => {
  it('prints the exact payload to the debug output and sends nothing', async () => {
    const env = { ...home(), WATCHER_TELEMETRY_DEBUG: '1' }
    const s = sink()
    const t = Telemetry.open({ env, print: s.print, fetch: s.fetch, version: '0.1.0' })
    t.record(cmd)
    await t.flush()
    expect(s.calls).not.toHaveBeenCalled()
    expect(s.lines).toHaveLength(1)
    expect(s.lines[0]).toMatch(/^\[telemetry\] not sent \(debug\): \{/)
    const payload = JSON.parse(s.lines[0].slice(s.lines[0].indexOf('{'))) as TelemetryBatch
    expect(payload.events).toEqual([cmd])
    expect(parseBatch(payload).ok).toBe(true)
    expect(existsSync(t.path)).toBe(false)
  })

  it('shows what would go even while telemetry is off, and still sends nothing', async () => {
    const env = { ...home(), WATCHER_TELEMETRY_DEBUG: '1', DO_NOT_TRACK: '1' }
    const s = sink()
    const t = Telemetry.open({ env, print: s.print, fetch: s.fetch })
    t.record(cmd)
    await t.flush()
    expect(s.calls).not.toHaveBeenCalled()
    expect(s.lines[0]).toContain('not sent (telemetry is off: DO_NOT_TRACK)')
  })
})

describe('sending', () => {
  it('never rejects: a failing request is counted, not thrown', async () => {
    const env = home()
    setTelemetryEnabled(true, env)
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    const t = Telemetry.open({ env, print: () => {}, fetch })
    t.record(cmd)
    await expect(t.flush()).resolves.toBeUndefined()
    expect(t.sendFailures).toBe(1)
  })

  it('after a send that got no answer, skips sending for an hour across processes', async () => {
    const env = home()
    setTelemetryEnabled(true, env)
    let now = new Date('2026-11-05T10:00:00.000Z')
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    const a = Telemetry.open({ env, print: () => {}, fetch: offline, now: () => now })
    a.record(cmd)
    await a.flush()
    expect((JSON.parse(readFileSync(a.path, 'utf8')) as TelemetryFile).backoffUntil).toBe('2026-11-05T11:00:00.000Z')

    now = new Date('2026-11-05T10:59:00.000Z')
    const s = sink()
    const b = Telemetry.open({ env, print: s.print, fetch: s.fetch, now: () => now })
    b.record(cmd)
    await b.flush()
    expect(s.calls).not.toHaveBeenCalled()

    now = new Date('2026-11-05T11:01:00.000Z')
    const c = Telemetry.open({ env, print: s.print, fetch: s.fetch, now: () => now })
    c.record(cmd)
    await c.flush()
    expect(s.calls).toHaveBeenCalledTimes(1)
  })

  it('does not back off on an HTTP error: the collector answered', async () => {
    const env = home()
    setTelemetryEnabled(true, env)
    const refused = vi.fn(async () => new Response('{"ok":false}', { status: 400 })) as unknown as typeof globalThis.fetch
    const t = Telemetry.open({ env, print: () => {}, fetch: refused })
    t.record(cmd)
    await t.flush()
    expect(t.sendFailures).toBe(1)
    expect((JSON.parse(readFileSync(t.path, 'utf8')) as TelemetryFile).backoffUntil).toBeNull()
  })

  it('gives up at the timeout', async () => {
    const env = home()
    setTelemetryEnabled(true, env)
    const fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as unknown as typeof globalThis.fetch
    const t = Telemetry.open({ env, print: () => {}, fetch, timeoutMs: 50 })
    t.record(cmd)
    const started = Date.now()
    await t.flush()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(t.sendFailures).toBe(1)
  })

  it('sends one batch per flush and nothing when the queue is empty', async () => {
    const env = home()
    setTelemetryEnabled(true, env)
    const s = sink()
    const t = Telemetry.open({ env, print: s.print, fetch: s.fetch })
    await t.flush()
    t.record(cmd)
    t.record({ ...cmd, command: 'status' })
    await t.flush()
    await t.flush()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].events.map((e) => (e as typeof cmd).command)).toEqual(['doctor', 'status'])
  })

  it('reports one internal error once per process, however often it repeats', async () => {
    const env = home()
    setTelemetryEnabled(true, env)
    const s = sink()
    const t = Telemetry.open({ env, print: s.print, fetch: s.fetch })
    const boom = (): Error => new RangeError('tick over /srv/acme')
    for (let i = 0; i < 5; i++) t.captureError(boom(), 'server')
    await vi.waitFor(() => expect(s.sent).toHaveLength(1))
    expect(s.sent[0].events[0]).toMatchObject({ name: 'error', where: 'server', errorName: 'RangeError' })
    expect(JSON.stringify(s.sent[0])).not.toContain('/srv/acme')
  })
})

describe('a crash is kept for the next run', () => {
  it('writes the error event synchronously and the next process sends it once', async () => {
    const env = home()
    setTelemetryEnabled(true, env)
    const crashing = Telemetry.open({ env, print: () => {}, fetch: sink().fetch })
    crashing.captureCrash(Object.assign(new Error('EACCES /srv/acme/data'), { code: 'EACCES' }), 'server')
    expect((JSON.parse(readFileSync(crashing.path, 'utf8')) as TelemetryFile).pending).toHaveLength(1)

    const s = sink()
    const next = Telemetry.open({ env, print: s.print, fetch: s.fetch })
    await next.flush()
    expect(s.sent[0].events[0]).toMatchObject({ name: 'error', code: 'EACCES', errorName: 'Error' })
    expect((JSON.parse(readFileSync(next.path, 'utf8')) as TelemetryFile).pending).toEqual([])
  })

  it('a disable drops what was kept', () => {
    const env = home()
    setTelemetryEnabled(true, env)
    Telemetry.open({ env, print: () => {} }).captureCrash(new Error('x'), 'cli')
    expect(setTelemetryEnabled(false, env).file.pending).toEqual([])
  })
})

describe('the daily heartbeat', () => {
  const input = { uptimeMs: 7_200_000, sourceKinds: ['http-probe', 'http-probe', 'self-made'], channelKinds: ['ntfy'], severities: ['page', 'warning', 'warning'], mcp: true }

  it('goes once a day across processes on one machine', () => {
    const env = home()
    setTelemetryEnabled(true, env)
    let now = new Date('2026-11-05T10:00:00.000Z')
    const a = Telemetry.open({ env, print: () => {}, now: () => now })
    expect(a.heartbeatDue()).toBe(true)
    a.markHeartbeat()
    expect(a.heartbeatDue()).toBe(false)
    now = new Date('2026-11-06T09:00:00.000Z')
    const b = Telemetry.open({ env, print: () => {}, now: () => now })
    expect(b.heartbeatDue()).toBe(false)
    now = new Date('2026-11-06T10:00:00.000Z')
    expect(b.heartbeatDue()).toBe(true)
  })

  it('is scheduled on unref timers, sends counts by kind, and reports a collector failure instead of crashing', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T10:00:00.000Z') })
    const env = home()
    setTelemetryEnabled(true, env)
    const s = sink()
    const t = Telemetry.open({ env, print: s.print, fetch: s.fetch })
    const stop = scheduleHeartbeat(t, () => input, { firstMs: 1000, everyMs: 3_600_000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].events[0]).toMatchObject({
      name: 'server.heartbeat', uptime: '1-24h', sources: { 'http-probe': 2, other: 1 }, channels: { ntfy: 1 }, incidents: { page: 1, warning: 2, info: 0 }, mcp: true
    })
    await vi.advanceTimersByTimeAsync(3 * 3_600_000)
    expect(s.sent).toHaveLength(1)
    stop()

    const env2 = home()
    setTelemetryEnabled(true, env2)
    const s2 = sink()
    const t2 = Telemetry.open({ env: env2, print: s2.print, fetch: s2.fetch })
    const stop2 = scheduleHeartbeat(t2, () => {
      throw new TypeError('wall failed')
    }, { firstMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    expect(s2.sent[0].events[0]).toMatchObject({ name: 'error', where: 'server', errorName: 'TypeError' })
    stop2()
  })
})
