// The telemetry wire format: one versioned schema, read by both ends.
//
// The CLI and the server build batches of these events (src/shared/telemetry.ts); the collector Worker in
// deploy/telemetry/ validates every batch with `parseBatch` below before it stores a row, so the two ends cannot drift.
// This module is pure (no Node or Worker API) for that reason.
//
// What may travel is decided here, field by field: a verb from the CLI's own list, flag NAMES, exit codes, durations,
// our own error and doctor codes (a fixed vocabulary, checked against its prefixes), counts by kind, and stack frames
// cut down to package-relative paths. Every string field has a pattern that a path, a URL, a hostname, an IP, a token or
// free text cannot satisfy; a value that does not fit is replaced by `other` on the client and refused by the collector.
// docs/telemetry.md is the human-readable copy of this file.

import type { SourceKind } from './types.ts'
import type { ChannelConfig } from '../server/config.ts'

export const TELEMETRY_SCHEMA = 1
export const TELEMETRY_ENDPOINT = 'https://telemetry.ezolabs.io/v1/events'
/** A batch larger than this is refused by the collector; a client batch is far smaller. */
export const TELEMETRY_MAX_BYTES = 16 * 1024
export const TELEMETRY_MAX_EVENTS = 50
const MAX_FRAMES = 12
const MAX_FLAGS = 24
const MAX_CODES = 64
const MAX_KINDS = 32

export type InstallMethod = 'npm' | 'checkout' | 'docker' | 'unknown'
export type UptimeBucket = '<1h' | '1-24h' | '1-7d' | '>7d'

/** Fields every event of a batch shares: who (an anonymous random id) and on what. */
export interface TelemetryContext {
  /** A random v4 UUID made on first run and kept in the user's config dir; derived from nothing. */
  id: string
  version: string
  node: string
  os: string
  arch: string
  ci: boolean
  install: InstallMethod
}

export interface CliCommandEvent {
  name: 'cli.command'
  at: string
  /** The verb (`doctor`, `add`), or `unknown` when the word typed is not a verb: never the typed word. */
  command: string
  /** The sub-verb when the verb declares one (`service install`, `add channel`); null otherwise. */
  sub: string | null
  /** Flag names only, never their values; names the verb does not declare are dropped. */
  flags: string[]
  exitCode: number
  durationMs: number
  /** Our own error code when the command ended in a CliError (`usage.unknown-flag`), `other` when it is not one; null on success. */
  errorCode: string | null
}

export interface DoctorResultEvent {
  name: 'doctor.result'
  at: string
  ok: boolean
  live: boolean
  target: 'local' | 'cloudflare'
  /** How many checks ran. */
  checks: number
  /** Codes of the checks that failed / warned (`source.unreachable`), never their messages. */
  failing: string[]
  warning: string[]
}

export interface ErrorEvent {
  name: 'error'
  at: string
  where: 'cli' | 'server'
  /** The verb that was running (cli), or null. */
  command: string | null
  /** The error's class name (`TypeError`), never its message. */
  errorName: string
  /** A Node system code (`ENOENT`) or our own code, or null. */
  code: string | null
  /** Stack frames inside this package, as `src/x.ts:1:2`; frames outside the package are dropped. */
  frames: string[]
}

export interface HeartbeatEvent {
  name: 'server.heartbeat'
  at: string
  uptime: UptimeBucket
  /** Configured sources by kind (`http-probe: 3`), never their ids, names or targets. */
  sources: Record<string, number>
  channels: Record<string, number>
  /** Firing incidents by severity. */
  incidents: { page: number; warning: number; info: number }
  mcp: boolean
}

export type TelemetryEvent = CliCommandEvent | DoctorResultEvent | ErrorEvent | HeartbeatEvent
export type TelemetryEventName = TelemetryEvent['name']
export const TELEMETRY_EVENT_NAMES: readonly TelemetryEventName[] = ['cli.command', 'doctor.result', 'error', 'server.heartbeat']

export interface TelemetryBatch {
  schema: typeof TELEMETRY_SCHEMA
  context: TelemetryContext
  events: TelemetryEvent[]
}

// ---- value patterns ----------------------------------------------------------------------------------------------------

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/
const NODE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
/** A CLI word: a verb, a sub-verb, a flag name or a source/channel kind. */
const WORD = /^[a-z][a-z0-9-]{0,31}$/
const ERROR_NAME = /^[A-Z][A-Za-z0-9_]{0,63}$/
/** Node's system and internal error codes: ENOENT, ECONNREFUSED, ERR_INVALID_ARG_TYPE. */
const NODE_CODE = /^(?:E[A-Z0-9]{2,30}|ERR_[A-Z0-9_]{1,60})$/
const OS_NAMES = new Set(['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'netbsd', 'sunos', 'win32', 'cygwin', 'other'])
const ARCH_NAMES = new Set(['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64', 'other'])
const INSTALL_METHODS = new Set<InstallMethod>(['npm', 'checkout', 'docker', 'unknown'])
const UPTIME_BUCKETS = new Set<UptimeBucket>(['<1h', '1-24h', '1-7d', '>7d'])

/**
 * The first segment of every error and doctor code the Watcher emits (`usage.unknown-flag`, `source.unreachable`). A code is
 * sent only when it starts with one of these and its tail is a plain word: that is what keeps a hostname-shaped string
 * (`example.com`) from passing as a code.
 */
export const CODE_PREFIXES: readonly string[] = [
  'add', 'auth', 'bundle', 'channel', 'channels', 'cloudflare', 'config', 'data', 'doctor', 'env', 'hooks', 'incident', 'init',
  'internal', 'mcp', 'mcp-config', 'node', 'port', 'recheck', 'rm', 'run', 'scan', 'server', 'service', 'skills', 'source',
  'status', 'stop', 'telemetry', 'test-alert', 'usage', 'watcher'
]
/**
 * The heartbeat counts sources and channels by these kinds only. The records are exhaustive over the config types, so a new
 * kind fails the typecheck here until it is listed; a `type` a hand-edited config invents is counted as `other`.
 */
const SOURCE_KINDS: Record<SourceKind, true> = {
  grafana: true, zulip: true, webhook: true, self: true, vmalert: true, 'netdata-cloud': true, 'netdata-fleet': true, sentry: true,
  'http-probe': true, 'tcp-probe': true, 'domain-expiry': true, feed: true, heartbeat: true, host: true
}
const CHANNEL_TYPES: Record<ChannelConfig['type'], true> = { ntfy: true, webpush: true, sms: true, email: true, webhook: true, file: true }

export function knownSourceKind(kind: unknown): string {
  return typeof kind === 'string' && Object.hasOwn(SOURCE_KINDS, kind) ? kind : 'other'
}

export function knownChannelType(type: unknown): string {
  return typeof type === 'string' && Object.hasOwn(CHANNEL_TYPES, type) ? type : 'other'
}

const CODE = new RegExp(`^(?:${CODE_PREFIXES.map((p) => p.replace(/-/g, '\\-')).join('|')})\\.[a-z0-9][a-z0-9-]{0,47}$`)

/**
 * A package-relative stack frame, `src/cli/doctor.ts:12:3`. The function name is left out: V8 names a function after the key
 * it was assigned to, which can be a runtime value (a host, an id), and the version plus the line already locate it.
 */
const FRAME = /^(?:src|dist|bin|scripts)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:ts|tsx|mjs|js):\d{1,6}:\d{1,5}$/

/** Our own code as-is when it fits the vocabulary, `other` when it does not. */
export function sanitizeCode(code: unknown): string {
  return typeof code === 'string' && CODE.test(code) ? code : 'other'
}

/** A Node or Watcher error code when it fits either shape, null otherwise (a code that does not fit is not sent). */
export function sanitizeErrorCode(code: unknown): string | null {
  if (typeof code !== 'string') return null
  if (NODE_CODE.test(code) || CODE.test(code)) return code
  return null
}

export function sanitizeWord(word: unknown): string | null {
  return typeof word === 'string' && WORD.test(word) ? word : null
}

export function sanitizeErrorName(name: unknown): string {
  return typeof name === 'string' && ERROR_NAME.test(name) ? name : 'Error'
}

export function isFrame(frame: string): boolean {
  return FRAME.test(frame)
}

/** `process.platform` as the schema names it; a platform it does not list is `other`. */
export function knownOs(platform: string): string {
  return OS_NAMES.has(platform) ? platform : 'other'
}

export function knownArch(arch: string): string {
  return ARCH_NAMES.has(arch) ? arch : 'other'
}

/** `ms` since start, in the four buckets the heartbeat reports. */
export function uptimeBucket(ms: number): UptimeBucket {
  const h = ms / 3_600_000
  if (h < 1) return '<1h'
  if (h < 24) return '1-24h'
  if (h < 24 * 7) return '1-7d'
  return '>7d'
}

// ---- the collector's boundary ------------------------------------------------------------------------------------------

export type ParseResult = { ok: true; batch: TelemetryBatch; dropped: number } | { ok: false; error: string }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const isStr = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v)
const strList = (v: unknown, max: number, ok: (s: string) => boolean): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((s) => typeof s === 'string' && ok(s)) ? (v as string[]) : null

function parseContext(v: unknown): TelemetryContext | string {
  if (!isObj(v)) return 'context is not an object'
  if (!isStr(v.id, UUID_V4)) return 'context.id is not a v4 UUID'
  if (!isStr(v.version, SEMVER)) return 'context.version is not a version'
  if (!isStr(v.node, NODE_VERSION)) return 'context.node is not a Node version'
  if (typeof v.os !== 'string' || !OS_NAMES.has(v.os)) return 'context.os is not a platform'
  if (typeof v.arch !== 'string' || !ARCH_NAMES.has(v.arch)) return 'context.arch is not an architecture'
  if (typeof v.ci !== 'boolean') return 'context.ci is not a boolean'
  if (typeof v.install !== 'string' || !INSTALL_METHODS.has(v.install as InstallMethod)) return 'context.install is not an install method'
  return { id: v.id, version: v.version, node: v.node, os: v.os, arch: v.arch, ci: v.ci, install: v.install as InstallMethod }
}

function parseCounts(v: unknown, known: (k: string) => string): Record<string, number> | null {
  if (!isObj(v)) return null
  const keys = Object.keys(v)
  if (keys.length > MAX_KINDS) return null
  const out: Record<string, number> = {}
  for (const k of keys) {
    if (known(k) !== k || !isInt(v[k], 0, 100_000)) return null
    out[k] = v[k] as number
  }
  return out
}

/**
 * One event, rebuilt from the fields the schema names: an unknown field is not copied, so it can never reach storage. Null
 * when the event is malformed or of a name this collector does not know.
 */
export function parseEvent(v: unknown): TelemetryEvent | null {
  if (!isObj(v) || !isStr(v.at, ISO_TIME)) return null
  const at = v.at
  switch (v.name) {
    case 'cli.command': {
      const flags = strList(v.flags, MAX_FLAGS, (s) => WORD.test(s))
      if (!isStr(v.command, WORD) || !(v.sub === null || isStr(v.sub, WORD)) || flags === null) return null
      if (!isInt(v.exitCode, 0, 255) || !isInt(v.durationMs, 0, 2 ** 31 - 1)) return null
      if (!(v.errorCode === null || v.errorCode === 'other' || isStr(v.errorCode, CODE))) return null
      return { name: 'cli.command', at, command: v.command, sub: v.sub, flags, exitCode: v.exitCode, durationMs: v.durationMs, errorCode: v.errorCode }
    }
    case 'doctor.result': {
      const failing = strList(v.failing, MAX_CODES, (s) => s === 'other' || CODE.test(s))
      const warning = strList(v.warning, MAX_CODES, (s) => s === 'other' || CODE.test(s))
      if (typeof v.ok !== 'boolean' || typeof v.live !== 'boolean' || (v.target !== 'local' && v.target !== 'cloudflare')) return null
      if (!isInt(v.checks, 0, 1000) || failing === null || warning === null) return null
      return { name: 'doctor.result', at, ok: v.ok, live: v.live, target: v.target, checks: v.checks, failing, warning }
    }
    case 'error': {
      const frames = strList(v.frames, MAX_FRAMES, isFrame)
      if ((v.where !== 'cli' && v.where !== 'server') || !(v.command === null || isStr(v.command, WORD))) return null
      if (!isStr(v.errorName, ERROR_NAME) || !(v.code === null || isStr(v.code, NODE_CODE) || isStr(v.code, CODE)) || frames === null) return null
      return { name: 'error', at, where: v.where, command: v.command, errorName: v.errorName, code: v.code, frames }
    }
    case 'server.heartbeat': {
      const sources = parseCounts(v.sources, knownSourceKind)
      const channels = parseCounts(v.channels, knownChannelType)
      const inc = v.incidents
      if (typeof v.uptime !== 'string' || !UPTIME_BUCKETS.has(v.uptime as UptimeBucket) || sources === null || channels === null) return null
      if (!isObj(inc) || !isInt(inc.page, 0, 100_000) || !isInt(inc.warning, 0, 100_000) || !isInt(inc.info, 0, 100_000)) return null
      if (typeof v.mcp !== 'boolean') return null
      return {
        name: 'server.heartbeat', at, uptime: v.uptime as UptimeBucket, sources, channels,
        incidents: { page: inc.page, warning: inc.warning, info: inc.info }, mcp: v.mcp
      }
    }
    default:
      return null
  }
}

/**
 * The collector's check of one POST body (already JSON-parsed). The envelope must be exact; an event that does not parse is
 * dropped and counted rather than failing its whole batch, so a newer client's new event name costs only that event.
 */
export function parseBatch(body: unknown): ParseResult {
  if (!isObj(body)) return { ok: false, error: 'body is not a JSON object' }
  if (body.schema !== TELEMETRY_SCHEMA) return { ok: false, error: `schema must be ${TELEMETRY_SCHEMA}` }
  const context = parseContext(body.context)
  if (typeof context === 'string') return { ok: false, error: context }
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > TELEMETRY_MAX_EVENTS) {
    return { ok: false, error: `events must be a list of 1 to ${TELEMETRY_MAX_EVENTS}` }
  }
  const events: TelemetryEvent[] = []
  for (const raw of body.events) {
    const event = parseEvent(raw)
    if (event) events.push(event)
  }
  if (events.length === 0) return { ok: false, error: 'no event in the batch matches the schema' }
  return { ok: true, batch: { schema: TELEMETRY_SCHEMA, context, events }, dropped: body.events.length - events.length }
}
