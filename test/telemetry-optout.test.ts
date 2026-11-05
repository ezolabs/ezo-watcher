// An opt-out taken while a process runs (src/shared/telemetry.ts): `watcher telemetry disable`, run while a server is up,
// writes `enabled: false` from another process. The running one must stop sending at its next send and must never write
// `enabled: true` back over it: every write re-reads the file and moves only its own field. Every case points
// XDG_CONFIG_HOME (and HOME) at a temp dir and injects fetch and the clock: the real home directory is never touched.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Telemetry, heartbeatEvent, setTelemetryEnabled, telemetryConfigPath, updateTelemetryFile } from '../src/shared/telemetry.ts'
import type { Env, TelemetryFile } from '../src/shared/telemetry.ts'
import type { TelemetryBatch } from '../src/shared/telemetry-schema.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function env(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-telemetry-optout-'))
  dirs.push(dir)
  return { HOME: dir, XDG_CONFIG_HOME: join(dir, 'config') }
}

function sink(fail = false) {
  const sent: TelemetryBatch[] = []
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (fail) throw new TypeError('fetch failed')
    sent.push(JSON.parse(String(init?.body)) as TelemetryBatch)
    return new Response(null, { status: 202 })
  })
  return { sent, fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch }
}

const onDisk = (e: Env): TelemetryFile => JSON.parse(readFileSync(telemetryConfigPath(e), 'utf8')) as TelemetryFile
const cmd = { name: 'cli.command' as const, at: '2026-11-05T10:00:00.000Z', command: 'doctor', sub: null, flags: [], exitCode: 0, durationMs: 80, errorCode: null }
const input = { uptimeMs: 7_200_000, sourceKinds: ['http-probe'], channelKinds: ['ntfy'], severities: [], mcp: false }
const T0 = new Date('2026-11-05T10:00:00.000Z')

/** A server-like process on the default (on, notice shown), its fetch and its clock. */
function running(e: Env, fail = false) {
  const s = sink(fail)
  let now = T0
  const t = Telemetry.open({ env: e, print: () => {}, fetch: s.fetch, now: () => now, version: '0.1.0' })
  expect(t.decision).toEqual({ enabled: true, reason: 'default' })
  expect(onDisk(e).enabled).toBe(true)
  return { t, s, at: (iso: string) => (now = new Date(iso)) }
}

describe('a disable from another process stops a running one', () => {
  it('the daily heartbeat: nothing sent, and the stored disable is not written over', async () => {
    const e = env()
    const { t, s, at } = running(e)
    const disabled = setTelemetryEnabled(false, e, new Date('2026-11-05T10:30:00.000Z')).file

    at('2026-11-06T10:00:00.000Z')
    t.markHeartbeat()
    expect(onDisk(e)).toEqual(disabled)
    t.record(heartbeatEvent(input, new Date('2026-11-06T10:00:00.000Z')))
    await t.flush()

    expect(s.calls).not.toHaveBeenCalled()
    expect(onDisk(e)).toEqual(disabled)
    expect(t.decision).toEqual({ enabled: false, reason: 'disabled-by-command' })
    expect(t.active).toBe(false)
    expect(t.heartbeatDue()).toBe(false)
  })

  it('a heartbeat already queued when the disable lands is dropped, not sent', async () => {
    const e = env()
    const { t, s } = running(e)
    t.record(heartbeatEvent(input, T0))
    t.markHeartbeat()
    expect(onDisk(e).lastHeartbeatAt).toBe(T0.toISOString())
    setTelemetryEnabled(false, e)
    await t.flush()
    expect(s.calls).not.toHaveBeenCalled()
    expect(onDisk(e).enabled).toBe(false)
  })

  it('the no-answer backoff: a send that fails while the disable lands does not write enabled back', async () => {
    const e = env()
    const s = sink()
    const offline = vi.fn(async () => {
      setTelemetryEnabled(false, e, new Date('2026-11-05T10:00:01.000Z')) // the user disables while the send is in flight
      throw new TypeError('fetch failed')
    })
    const t = Telemetry.open({ env: e, print: () => {}, fetch: offline as unknown as typeof globalThis.fetch, now: () => T0 })
    t.record(cmd)
    await t.flush()
    expect(offline).toHaveBeenCalledTimes(1)
    expect(t.sendFailures).toBe(1)
    const stored = onDisk(e)
    expect(stored.enabled).toBe(false)
    expect(stored.chosenAt).toBe('2026-11-05T10:00:01.000Z')
    expect(stored.backoffUntil).toBeNull()

    t.record(cmd)
    await t.flush()
    expect(offline).toHaveBeenCalledTimes(1)
    expect(s.calls).not.toHaveBeenCalled()
  })

  it('the no-answer backoff: a disable before the send means no send and no backoff write', async () => {
    const e = env()
    const { t, s } = running(e, true)
    const disabled = setTelemetryEnabled(false, e).file
    t.record(cmd)
    await t.flush()
    expect(s.calls).not.toHaveBeenCalled()
    expect(t.sendFailures).toBe(0)
    expect(onDisk(e)).toEqual(disabled)
  })

  it('a crash kept for the next run: not stored, and the stored disable stays', () => {
    const e = env()
    const { t } = running(e)
    const disabled = setTelemetryEnabled(false, e).file
    t.captureCrash(Object.assign(new Error('EACCES'), { code: 'EACCES' }), 'server')
    expect(onDisk(e)).toEqual(disabled)
    expect(onDisk(e).pending).toEqual([])
  })

  it('an internal error is not sent', async () => {
    const e = env()
    const { t, s } = running(e)
    setTelemetryEnabled(false, e)
    t.captureError(new RangeError('tick'), 'server')
    await t.flush()
    expect(s.calls).not.toHaveBeenCalled()
    expect(onDisk(e).enabled).toBe(false)
  })

  it('an opt-out env var set while running stops the next send', async () => {
    const e = env()
    const { t, s } = running(e)
    e.DO_NOT_TRACK = '1'
    t.record(cmd)
    await t.flush()
    expect(s.calls).not.toHaveBeenCalled()
    expect(t.decision).toEqual({ enabled: false, reason: 'DO_NOT_TRACK' })
  })

  it('a config edited by hand into something that does not parse stops the next send and is left alone', async () => {
    const e = env()
    const { t, s } = running(e)
    writeFileSync(telemetryConfigPath(e), '{ "enabled": false, oops')
    t.markHeartbeat()
    t.record(cmd)
    await t.flush()
    expect(s.calls).not.toHaveBeenCalled()
    expect(t.decision.reason).toBe('config-unreadable')
    expect(readFileSync(telemetryConfigPath(e), 'utf8')).toBe('{ "enabled": false, oops')
  })

  it('debug mode says the send is off, by the stored choice', async () => {
    const e = { ...env(), WATCHER_TELEMETRY_DEBUG: '1' }
    setTelemetryEnabled(true, e)
    const lines: string[] = []
    const s = sink()
    const t = Telemetry.open({ env: e, print: (text) => lines.push(text), fetch: s.fetch })
    setTelemetryEnabled(false, e)
    t.record(cmd)
    await t.flush()
    expect(s.calls).not.toHaveBeenCalled()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('not sent (telemetry is off: disabled-by-command)')
  })
})

describe('a write moves only its own field', () => {
  it('a heartbeat keeps the backoff another process stored after this one started', async () => {
    const e = env()
    const { t: server } = running(e)
    const cli = Telemetry.open({ env: e, print: () => {}, fetch: sink(true).fetch, now: () => T0 })
    cli.record(cmd)
    await cli.flush()
    expect(onDisk(e).backoffUntil).toBe('2026-11-05T11:00:00.000Z')

    server.markHeartbeat()
    expect(onDisk(e)).toMatchObject({ enabled: true, lastHeartbeatAt: T0.toISOString(), backoffUntil: '2026-11-05T11:00:00.000Z' })
  })

  it('a running process honours the backoff another process stored after it started', async () => {
    const e = env()
    const { t: server, s } = running(e)
    const cli = Telemetry.open({ env: e, print: () => {}, fetch: sink(true).fetch, now: () => T0 })
    cli.record(cmd)
    await cli.flush()
    server.record(cmd)
    await server.flush()
    expect(s.calls).not.toHaveBeenCalled()
    expect(server.decision.enabled).toBe(true)
  })

  it('updateTelemetryFile merges into what is on disk and writes nothing over a disable, a missing or a broken file', () => {
    const e = env()
    const path = telemetryConfigPath(e)
    expect(updateTelemetryFile(path, { lastHeartbeatAt: T0.toISOString() })).toBeNull()
    expect(() => readFileSync(path)).toThrow()

    const enabled = setTelemetryEnabled(true, e, T0).file
    const merged = updateTelemetryFile(path, { lastHeartbeatAt: '2026-11-05T12:00:00.000Z' })
    expect(merged).toEqual({ ...enabled, lastHeartbeatAt: '2026-11-05T12:00:00.000Z' })
    expect(onDisk(e)).toEqual(merged)
    expect(updateTelemetryFile(path, (disk) => ({ pending: [...disk.pending, cmd] }))?.pending).toEqual([cmd])

    const disabled = setTelemetryEnabled(false, e).file
    expect(updateTelemetryFile(path, { lastHeartbeatAt: '2026-11-06T12:00:00.000Z' })).toEqual(disabled)
    expect(onDisk(e)).toEqual(disabled)

    writeFileSync(path, '{ oops')
    expect(updateTelemetryFile(path, { backoffUntil: T0.toISOString() })).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('{ oops')
  })
})

describe('an enabled process is unchanged', () => {
  it('still sends, and still records the heartbeat in the file', async () => {
    const e = env()
    const { t, s } = running(e)
    expect(t.heartbeatDue()).toBe(true)
    t.record(heartbeatEvent(input, T0))
    t.markHeartbeat()
    await t.flush()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].events[0]).toMatchObject({ name: 'server.heartbeat' })
    expect(onDisk(e)).toMatchObject({ enabled: true, lastHeartbeatAt: T0.toISOString(), backoffUntil: null })
    expect(t.heartbeatDue()).toBe(false)
    expect(t.decision).toEqual({ enabled: true, reason: 'default' })
  })

  it('still keeps a crash for the next run, which sends it once', async () => {
    const e = env()
    const { t } = running(e)
    t.captureCrash(new Error('x'), 'cli')
    expect(onDisk(e).pending).toHaveLength(1)
    const s = sink()
    const next = Telemetry.open({ env: e, print: () => {}, fetch: s.fetch })
    await next.flush()
    expect(s.sent).toHaveLength(1)
    expect(onDisk(e)).toMatchObject({ enabled: true, pending: [] })
  })
})
