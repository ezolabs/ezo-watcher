// The telemetry wire format (src/shared/telemetry-schema.ts) and the builders that fill it: whatever a run hands them (argv full
// of URLs and paths, an error whose message carries a token, a doctor check that names a host), the batch that leaves the
// machine carries none of it, and the collector's own `parseBatch` accepts every batch the client builds.
import { describe, expect, it } from 'vitest'
import {
  CODE_PREFIXES, TELEMETRY_MAX_EVENTS, isFrame, parseBatch, parseEvent, sanitizeCode, sanitizeErrorCode, sanitizeErrorName, uptimeBucket
} from '../src/shared/telemetry-schema.ts'
import type { TelemetryBatch, TelemetryEvent } from '../src/shared/telemetry-schema.ts'
import { errorEvent, heartbeatEvent, packageFrames, telemetryContext } from '../src/shared/telemetry.ts'
import { commandEvent, doctorEvent, flagNames } from '../src/cli/telemetry.ts'

const ID = '00000000-0000-4000-8000-00000000c0de'
const ROOT = '/srv/acme/ezo-watcher'
const AT = new Date('2026-11-05T10:00:00.000Z')

/** Values a user's run can hold. Not one of them may appear in a payload. */
const SECRETS = [
  '/srv/acme/api/.watcher/config.json',
  '/var/lib/acme/data',
  'C:\\work\\acme\\api',
  'https://grafana.example.com/d/checkout?orgId=1&token=tok-acme-9f8e7d6c',
  'http://192.0.2.17:9090/api/v1/query',
  'db.example.com',
  'api.example.org',
  '198.51.100.4',
  'tok-acme-9f8e7d6c',
  'hunter2-acme-secret',
  'ACME_GRAFANA_TOKEN',
  'checkout-api-prod',
  'Checkout p95 over 2s on db-7',
  'ops@example.com'
]

/** A small seeded PRNG, so the property runs are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function pick<T>(r: () => number, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)]
}

const DECLARED = ['id', 'url', 'service', 'token-env', 'live', 'prove', 'hostname', 'target']

function hostileArgv(r: () => number): string[] {
  const argv: string[] = [pick(r, ['add', 'doctor', 'status', SECRETS[0], 'http-probe'])]
  const n = 1 + Math.floor(r() * 8)
  for (let i = 0; i < n; i++) {
    const s = pick(r, SECRETS)
    const shape = Math.floor(r() * 6)
    if (shape === 0) argv.push(`--${pick(r, DECLARED)}`, s)
    else if (shape === 1) argv.push(`--${pick(r, DECLARED)}=${s}`)
    else if (shape === 2) argv.push(s)
    else if (shape === 3) argv.push(`--${s}`)
    else if (shape === 4) argv.push('--', s)
    else argv.push(`-${s}`)
  }
  return argv
}

function hostileError(r: () => number): Error {
  const err = new (pick(r, [Error, TypeError, RangeError]))(`failed reading ${pick(r, SECRETS)} with ${pick(r, SECRETS)}`)
  const frames = [
    `    at readConfig (${ROOT}/src/cli/project.ts:40:11)`,
    `    at async runDoctorCommand (file://${ROOT}/src/cli/doctor.ts:880:18)`,
    `    at Object.<anonymous> (${pick(r, SECRETS)}:1:1)`,
    `    at fetchJson (${ROOT}/node_modules/undici/index.js:10:2)`,
    `    at /srv/acme/api/scripts/deploy.mjs:3:9`,
    `    at ${pick(r, SECRETS)} (${ROOT}/src/server/engine.ts:204:5)`,
    '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)'
  ]
  err.stack = `${err.name}: ${err.message}\n${frames.filter(() => r() > 0.3).join('\n')}`
  if (r() > 0.5) (err as Error & { code?: string }).code = pick(r, ['ENOENT', 'ECONNREFUSED', pick(r, SECRETS), 'config.invalid'])
  return err
}

function hostileDoctor(r: () => number): unknown {
  const checks = Array.from({ length: 1 + Math.floor(r() * 10) }, () => ({
    code: pick(r, ['source.error', 'server.down', 'env.missing', pick(r, SECRETS), 'evil.example.com', 'source.example.com']),
    status: pick(r, ['pass', 'fail', 'warn', 'skip']),
    message: `could not reach ${pick(r, SECRETS)}`,
    next: `watcher add http-probe --id x --url ${pick(r, SECRETS)}`
  }))
  return { ok: r() > 0.5, target: pick(r, ['local', 'cloudflare', SECRETS[3]]), checks, live: r() > 0.5, reason: pick(r, SECRETS) }
}

function batchOf(events: TelemetryEvent[]): TelemetryBatch {
  return { schema: 1, context: telemetryContext(ID, '0.1.0', {}, ROOT), events }
}

describe('a payload carries no value from the run', () => {
  it('holds for 300 seeded runs of hostile argv, errors, doctor results and heartbeat kinds', () => {
    const r = rng(7)
    for (let run = 0; run < 300; run++) {
      const argv = hostileArgv(r)
      const events: TelemetryEvent[] = [
        commandEvent({ command: pick(r, ['add', 'doctor', 'unknown']), sub: null, declared: DECLARED, argv, exitCode: Math.floor(r() * 70), durationMs: r() * 5000, errorCode: pick(r, [null, 'usage.unknown-flag', pick(r, SECRETS)]), now: AT }),
        errorEvent(hostileError(r), pick(r, ['cli', 'server'] as const), pick(r, ['doctor', SECRETS[0], null]), ROOT, AT),
        heartbeatEvent({ uptimeMs: r() * 1e9, sourceKinds: [pick(r, SECRETS), 'http-probe', pick(r, SECRETS)], channelKinds: ['ntfy', pick(r, SECRETS)], severities: ['page', pick(r, SECRETS)], mcp: r() > 0.5 }, AT)
      ]
      const doctor = doctorEvent(hostileDoctor(r), AT)
      if (doctor) events.push(doctor)
      const wire = JSON.stringify(batchOf(events))
      for (const s of SECRETS) expect(wire.includes(s), `run ${run}: ${s} in ${wire}`).toBe(false)
      expect(wire).not.toMatch(/:\/\//)
      expect(wire).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
      expect(wire).not.toMatch(/\b[a-z0-9-]+\.(?:com|org|net|io|example|internal|local)\b/i)
      expect(wire).not.toMatch(/\/srv\/|\/var\/|\\\\|node_modules|node:internal/)
      const parsed = parseBatch(JSON.parse(wire))
      expect(parsed.ok, wire).toBe(true)
      if (parsed.ok) expect(parsed.dropped).toBe(0)
    }
  })

  it('keeps flag names the verb declares and never a value or an undeclared name', () => {
    expect(flagNames(['add', 'http-probe', '--id', 'checkout-api-prod', '--url=https://api.example.com', '--evil.example.com', '-q'], ['id', 'url'])).toEqual(['id', 'quiet', 'url'])
    expect(flagNames(['doctor', '--no-color', '--', '--live'], ['live'])).toEqual(['no-color'])
  })

  it('cuts a stack to frames inside the package, relative to it', () => {
    const stack = [
      'Error: boom at /srv/acme/api',
      `    at async runDoctorCommand (file://${ROOT}/src/cli/doctor.ts:880:18)`,
      `    at Engine.ingest [as onObs] (${ROOT}/src/server/engine.ts:204:5)`,
      `    at ${ROOT}/dist/cli/main.mjs:4567:12`,
      `    at x (${ROOT}/node_modules/hono/dist/index.js:1:1)`,
      '    at y (/srv/acme/api/src/app.ts:1:1)',
      '    at node:internal/main:1:1'
    ].join('\n')
    expect(packageFrames(stack, ROOT)).toEqual(['src/cli/doctor.ts:880:18', 'src/server/engine.ts:204:5', 'dist/cli/main.mjs:4567:12'])
  })
})

describe('the vocabulary checks', () => {
  it('passes our own codes and turns anything else into other', () => {
    expect(sanitizeCode('source.unreachable')).toBe('source.unreachable')
    expect(sanitizeCode('usage.unknown-flag')).toBe('usage.unknown-flag')
    expect(sanitizeCode('test-alert.no-channel')).toBe('test-alert.no-channel')
    for (const bad of ['db.example.com', 'source.db.example.com', 'source.Error', '/etc/passwd', 'source.', 'x'.repeat(80), 42]) expect(sanitizeCode(bad)).toBe('other')
    for (const p of CODE_PREFIXES) expect(sanitizeCode(`${p}.x`)).toBe(`${p}.x`)
  })

  it('passes Node and Watcher error codes and nothing else', () => {
    expect(sanitizeErrorCode('ENOENT')).toBe('ENOENT')
    expect(sanitizeErrorCode('ERR_INVALID_ARG_TYPE')).toBe('ERR_INVALID_ARG_TYPE')
    expect(sanitizeErrorCode('config.invalid')).toBe('config.invalid')
    expect(sanitizeErrorCode('api.example.com')).toBeNull()
    expect(sanitizeErrorCode(404)).toBeNull()
    expect(sanitizeErrorName('TypeError')).toBe('TypeError')
    expect(sanitizeErrorName('failed: /srv/x')).toBe('Error')
  })

  it('accepts only package-relative frames, without a function name', () => {
    expect(isFrame('src/cli/doctor.ts:880:18')).toBe(true)
    expect(isFrame('dist/server/main.mjs:10:2')).toBe(true)
    expect(isFrame('runDoctorCommand (src/cli/doctor.ts:880:18)')).toBe(false)
    expect(isFrame('x (../src/a.ts:1:1)')).toBe(false)
    expect(isFrame('x (/srv/src/a.ts:1:1)')).toBe(false)
    expect(isFrame('src/../../etc/passwd:1:1')).toBe(false)
  })

  it('buckets uptime', () => {
    expect([0, 3_599_999, 3_600_000, 86_400_000 * 6, 86_400_000 * 7].map(uptimeBucket)).toEqual(['<1h', '<1h', '1-24h', '1-7d', '>7d'])
  })
})

describe('the collector boundary (parseBatch)', () => {
  const good = (): Record<string, unknown> => ({
    schema: 1,
    context: { id: ID, version: '0.1.0', node: '24.1.0', os: 'darwin', arch: 'arm64', ci: false, install: 'npm' },
    events: [{ name: 'cli.command', at: '2026-11-05T10:00:00.000Z', command: 'doctor', sub: null, flags: ['live'], exitCode: 1, durationMs: 812, errorCode: null }]
  })

  it('accepts a well-formed batch and rebuilds each event from its known fields only', () => {
    const body = good()
    ;(body.events as Array<Record<string, unknown>>)[0].extra = '/srv/acme/api'
    const r = parseBatch(body)
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.stringify(r.batch)).not.toContain('/srv/acme')
  })

  it('refuses a bad envelope and drops only the bad events', () => {
    expect(parseBatch(null).ok).toBe(false)
    expect(parseBatch({ ...good(), schema: 2 }).ok).toBe(false)
    expect(parseBatch({ ...good(), context: { ...(good().context as object), id: 'host-alice' } }).ok).toBe(false)
    expect(parseBatch({ ...good(), events: [] }).ok).toBe(false)
    const many = { ...good(), events: Array.from({ length: TELEMETRY_MAX_EVENTS + 1 }, () => (good().events as unknown[])[0]) }
    expect(parseBatch(many).ok).toBe(false)
    const mixed = { ...good(), events: [...(good().events as unknown[]), { name: 'cli.command', at: 'yesterday' }, { name: 'future.event', at: '2026-11-05T10:00:00Z' }] }
    const r = parseBatch(mixed)
    expect(r.ok && r.dropped).toBe(2)
  })

  it('refuses a value outside its pattern in every event kind', () => {
    const at = '2026-11-05T10:00:00Z'
    expect(parseEvent({ name: 'cli.command', at, command: 'https://x', sub: null, flags: [], exitCode: 0, durationMs: 1, errorCode: null })).toBeNull()
    expect(parseEvent({ name: 'cli.command', at, command: 'add', sub: null, flags: ['--url=https://x'], exitCode: 0, durationMs: 1, errorCode: null })).toBeNull()
    expect(parseEvent({ name: 'doctor.result', at, ok: false, live: false, target: 'local', checks: 1, failing: ['db.example.com'], warning: [] })).toBeNull()
    expect(parseEvent({ name: 'error', at, where: 'cli', command: null, errorName: 'Error', code: null, frames: ['x (/srv/a.ts:1:1)'] })).toBeNull()
    expect(parseEvent({ name: 'server.heartbeat', at, uptime: '<1h', sources: { 'db.example.com': 1 }, channels: {}, incidents: { page: 0, warning: 0, info: 0 }, mcp: false })).toBeNull()
    expect(parseEvent({ name: 'server.heartbeat', at, uptime: '<1h', sources: { 'checkout-api': 1 }, channels: {}, incidents: { page: 0, warning: 0, info: 0 }, mcp: false })).toBeNull()
    expect(parseEvent({ name: 'server.heartbeat', at, uptime: '<1h', sources: { 'http-probe': 2, other: 1 }, channels: { ntfy: 1 }, incidents: { page: 0, warning: 1, info: 0 }, mcp: true })).not.toBeNull()
  })
})
