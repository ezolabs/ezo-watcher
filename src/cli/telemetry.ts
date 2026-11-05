// `watcher telemetry status|enable|disable`, and the CLI's half of telemetry: the `cli.command`, `doctor.result` and
// `error` events main() records for each run. What may be sent, and how it is turned off, is src/shared/telemetry*.ts and
// docs/telemetry.md.

import { CliError, usageError } from './util.ts'
import type { ParsedArgs } from './util.ts'
import { Output } from './output.ts'
import {
  TELEMETRY_DOCS, Telemetry, decideTelemetry, envOptOut, errorEvent, readTelemetryFile, setTelemetryEnabled, telemetryConfigPath,
  telemetryDebug
} from '../shared/telemetry.ts'
import type { Env, TelemetryDecision, TelemetryFile } from '../shared/telemetry.ts'
import { TELEMETRY_ENDPOINT, sanitizeCode } from '../shared/telemetry-schema.ts'
import type { CliCommandEvent, DoctorResultEvent } from '../shared/telemetry-schema.ts'

export const TELEMETRY_SPEC = {
  valueFlags: ['dir', 'output'],
  switchFlags: ['help', 'dry-run'],
  subVerbs: ['status', 'enable', 'disable']
} as const

/** What one run sends, in the words `status` prints. Kept beside the code that sends it. */
export const TELEMETRY_SENDS = 'the verb run (flag names only), its exit code and duration; doctor check codes; internal error types with package stack frames; a daily server heartbeat of counts'
export const TELEMETRY_NEVER = 'paths, hostnames, URLs, IPs, source or channel ids, config or env values, incident text, error messages'

const REASONS: Record<TelemetryDecision['reason'], string> = {
  default: 'on by default (anonymous; see docs)',
  'enabled-by-command': 'enabled with `watcher telemetry enable`',
  'disabled-by-command': 'disabled with `watcher telemetry disable`',
  DO_NOT_TRACK: 'off: DO_NOT_TRACK is set',
  WATCHER_TELEMETRY_DISABLED: 'off: WATCHER_TELEMETRY_DISABLED is set',
  'test-runner': 'off under a test runner (VITEST / NODE_ENV=test)',
  'config-unreadable': 'off: the telemetry config does not parse',
  'config-unwritable': 'off: the telemetry config cannot be written'
}

export interface TelemetryStatus {
  ok: true
  enabled: boolean
  reason: TelemetryDecision['reason']
  /** The stored choice, null when no file exists yet (the default applies). */
  stored: boolean | null
  id: string | null
  path: string
  endpoint: string
  debug: boolean
  docs: string
}

export function telemetryStatus(env: Env = process.env): TelemetryStatus {
  const path = telemetryConfigPath(env)
  let file: TelemetryFile | null = null
  let unreadable = false
  try {
    file = readTelemetryFile(path)
  } catch {
    unreadable = true
  }
  const decision = decideTelemetry(env, file, unreadable)
  return {
    ok: true,
    enabled: decision.enabled,
    reason: decision.reason,
    stored: file ? file.enabled : null,
    id: file?.id ?? null,
    path,
    endpoint: TELEMETRY_ENDPOINT,
    debug: telemetryDebug(env),
    docs: TELEMETRY_DOCS
  }
}

export async function runTelemetry(args: ParsedArgs, out: Output): Promise<number> {
  const action = args.sub ?? (args.positionals[0] === undefined ? 'status' : undefined)
  if (action !== 'status' && action !== 'enable' && action !== 'disable') {
    throw usageError('telemetry.unknown-action', `telemetry takes status, enable or disable, not ${JSON.stringify(args.positionals[0])}`, 'Run `watcher telemetry status`.')
  }
  if (action !== 'status' && !args.dryRun) {
    try {
      setTelemetryEnabled(action === 'enable')
    } catch (err) {
      const path = telemetryConfigPath()
      throw new CliError('telemetry.unwritable', `cannot write ${path}: ${(err as Error).message}`, {
        next: `Make ${path} writable, or set WATCHER_TELEMETRY_DISABLED=1 (or DO_NOT_TRACK=1) in your shell profile instead.`
      })
    }
  }
  const status = telemetryStatus()
  const preview = args.dryRun && action !== 'status'
  out.json({ ...status, action, ...(preview ? { dryRun: true } : {}) })

  const word = status.enabled ? out.ok('enabled') : out.warn('disabled')
  const optOut = envOptOut()
  if (action !== 'status') {
    const did = preview ? `would ${action} (dry run: nothing written)` : `${action}d`
    out.line(`${out.bold('telemetry')} ${did}`)
    if (action === 'enable' && optOut && !preview) out.line(`  stored as enabled, but ${optOut} is set in this environment and wins: nothing is sent while it is.`)
  }
  out.line(`${out.bold('telemetry')} ${word}  ${out.dim(REASONS[status.reason])}`)
  out.line(`  id        ${status.id ?? out.dim('(none yet: made on the first run that sends)')}`)
  out.line(`  config    ${status.path}`)
  out.line(`  endpoint  ${status.endpoint}`)
  out.line(`  sends     ${TELEMETRY_SENDS}`)
  out.line(`  never     ${TELEMETRY_NEVER}`)
  out.line(`  debug     WATCHER_TELEMETRY_DEBUG=1 prints each payload to stderr instead of sending it${status.debug ? ' (on now)' : ''}`)
  out.line(`  off       \`watcher telemetry disable\`, or DO_NOT_TRACK=1 / WATCHER_TELEMETRY_DISABLED=1`)
  out.line(`  docs      ${status.docs}`)
  out.md('# telemetry')
  out.md('')
  out.md(`- State: ${status.enabled ? 'enabled' : 'disabled'} (${REASONS[status.reason]})`)
  out.md(`- Anonymous id: ${status.id ? `\`${status.id}\`` : 'none yet'}`)
  out.md(`- Config: \`${status.path}\``)
  out.md(`- Endpoint: ${status.endpoint}`)
  out.md(`- Sends: ${TELEMETRY_SENDS}`)
  out.md(`- Never: ${TELEMETRY_NEVER}`)
  out.md(`- Docs: ${status.docs}`)
  return 0
}

// ---- what main() records for each run ------------------------------------------------------------------------------------

/** An Output that remembers the last JSON document its verb produced, in every format: the doctor result rides on it. */
export class RecordingOutput extends Output {
  lastJson: unknown = undefined

  override json(value: unknown): void {
    this.lastJson = value
    super.json(value)
  }
}

/** The flags every verb accepts, besides its own. */
const GLOBAL_FLAGS = ['dir', 'output', 'json', 'dry-run', 'show-secret', 'help', 'version', 'quiet', 'no-color', 'color']
const SHORT_FLAGS: Record<string, string> = { '-h': 'help', '-v': 'version', '-q': 'quiet' }

/** The names of the flags given, filtered to the ones the verb declares; values are never looked at. */
export function flagNames(argv: string[], declared: readonly string[]): string[] {
  const known = new Set([...GLOBAL_FLAGS, ...declared])
  const names = new Set<string>()
  for (const a of argv) {
    if (a === '--') break
    if (SHORT_FLAGS[a]) names.add(SHORT_FLAGS[a])
    if (!a.startsWith('--')) continue
    const name = a.slice(2).split('=')[0]
    if (known.has(name) || (name.startsWith('no-') && known.has(name.slice(3)))) names.add(name)
  }
  return [...names].sort()
}

export interface CommandOutcome {
  /** The verb as main() resolved it: a real verb, `help`, `version`, or `unknown`. */
  command: string
  sub: string | null
  declared: readonly string[]
  argv: string[]
  exitCode: number
  durationMs: number
  /** The CliError code the run ended with, if any. */
  errorCode: string | null
  now?: Date
}

export function commandEvent(o: CommandOutcome): CliCommandEvent {
  return {
    name: 'cli.command',
    at: (o.now ?? new Date()).toISOString(),
    command: o.command,
    sub: o.sub,
    flags: flagNames(o.argv, o.declared),
    exitCode: Math.max(0, Math.min(255, Math.trunc(o.exitCode))),
    durationMs: Math.max(0, Math.round(o.durationMs)),
    errorCode: o.errorCode === null ? null : sanitizeCode(o.errorCode)
  }
}

/** The doctor result's verdict and codes (never a message), or null when the value is not a doctor result. */
export function doctorEvent(result: unknown, now = new Date()): DoctorResultEvent | null {
  if (typeof result !== 'object' || result === null) return null
  const r = result as { ok?: unknown; live?: unknown; target?: unknown; checks?: unknown }
  if (typeof r.ok !== 'boolean' || !Array.isArray(r.checks)) return null
  const codes = (status: string): string[] =>
    (r.checks as Array<{ code?: unknown; status?: unknown }>).filter((c) => c && c.status === status).map((c) => sanitizeCode(c.code)).slice(0, 64)
  return {
    name: 'doctor.result',
    at: now.toISOString(),
    ok: r.ok,
    live: r.live === true,
    target: r.target === 'cloudflare' ? 'cloudflare' : 'local',
    checks: Math.min(r.checks.length, 1000),
    failing: codes('fail'),
    warning: codes('warn')
  }
}

/** Open telemetry for one CLI run. The notice prints here, on stderr, before the verb's own output. */
export function openCliTelemetry(): Telemetry {
  return Telemetry.open({ print: (text) => process.stderr.write(`${text}\n`) })
}

/** Record the run and send, within the send timeout. Never throws: a telemetry fault must not change the exit code. */
export async function finishCliTelemetry(telemetry: Telemetry, outcome: CommandOutcome, extra: { doctor?: unknown; thrown?: unknown }): Promise<void> {
  try {
    if (!telemetry.active) return
    telemetry.record(commandEvent(outcome))
    if (outcome.command === 'doctor' && extra.doctor !== undefined) {
      const doctor = doctorEvent(extra.doctor, outcome.now)
      if (doctor) telemetry.record(doctor)
    }
    if (extra.thrown !== undefined) telemetry.record(errorEvent(extra.thrown, 'cli', outcome.command, undefined, outcome.now))
    await telemetry.flush()
  } catch (err) {
    // flush() does not reject and the builders do not throw; reaching here is a bug in this module, and the user's command
    // already finished. It is reported where debug output goes, not to the user's stdout.
    if (telemetry.debug) process.stderr.write(`[telemetry] could not record this run: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

