// Anonymous usage telemetry for the CLI and the server: on by default after a one-time notice, off with one command or
// one env var, and never in the way of the command that triggered it.
//
// The shape follows the open-source CLIs that do this in the open (Next.js, Astro, Turborepo; retrieved 2026-11-05): a
// random id per machine in the user's config dir, a first-run notice on stderr, `watcher telemetry status|enable|disable`,
// DO_NOT_TRACK=1 and WATCHER_TELEMETRY_DISABLED=1, a debug switch (WATCHER_TELEMETRY_DEBUG=1) that prints the exact
// payload instead of sending it, and off under a test runner. What an event may carry is fixed by telemetry-schema.ts;
// docs/telemetry.md says it in prose.
//
// Sending is one POST per process (a batch), bounded by a short timeout, and it never throws: a failed send is counted
// (`sendFailures`, visible in debug mode) and the events are dropped. Node only (the CLI and the server); the browser never
// loads this module.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TELEMETRY_ENDPOINT, TELEMETRY_MAX_EVENTS, TELEMETRY_SCHEMA, isFrame, knownArch, knownChannelType, knownOs, knownSourceKind,
  parseEvent, sanitizeErrorCode, sanitizeErrorName, sanitizeWord, uptimeBucket
} from './telemetry-schema.ts'
import type { ErrorEvent, HeartbeatEvent, InstallMethod, TelemetryBatch, TelemetryContext, TelemetryEvent } from './telemetry-schema.ts'

export type Env = Record<string, string | undefined>

export const TELEMETRY_DOCS = 'https://github.com/ezolabs/ezo-watcher/blob/main/docs/telemetry.md'
/** The longest a send may hold up the CLI's exit. */
export const TELEMETRY_TIMEOUT_MS = 1500
const DAY_MS = 24 * 3_600_000
const MAX_PENDING = 5
/** After a send that got no answer, the next sends are skipped for this long. */
const BACKOFF_MS = 3_600_000

/** The one file telemetry keeps, at `$XDG_CONFIG_HOME/ezo-watcher/telemetry.json` (default `~/.config/...`). */
export interface TelemetryFile {
  /** A random v4 UUID; derived from nothing about the machine or the user. */
  id: string
  enabled: boolean
  /** When `watcher telemetry enable|disable` last set `enabled`; null while it is the default. */
  chosenAt: string | null
  /** When the first-run notice was shown (or telemetry was enabled by hand). Null: never told, so nothing is sent yet. */
  notifiedAt: string | null
  /** The last daily server heartbeat, so restarts do not send more than one a day. */
  lastHeartbeatAt: string | null
  /** Until when sends are skipped, after one got no answer (offline, firewalled); null normally. */
  backoffUntil: string | null
  /** Error events a crashing process wrote as it went down; the next process sends them. */
  pending: TelemetryEvent[]
}

export type TelemetryReason =
  | 'DO_NOT_TRACK'
  | 'WATCHER_TELEMETRY_DISABLED'
  | 'test-runner'
  | 'disabled-by-command'
  | 'config-unreadable'
  | 'config-unwritable'
  | 'enabled-by-command'
  | 'default'

export interface TelemetryDecision {
  enabled: boolean
  reason: TelemetryReason
}

/** Set and not a spelled-out "no": `DO_NOT_TRACK=1`, `=true`, `=yes` all count; `=0`, `=false` and empty do not. */
function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off'
}

export function telemetryConfigPath(env: Env = process.env): string {
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME || homedir(), '.config')
  return join(base, 'ezo-watcher', 'telemetry.json')
}

/** An env var that turns telemetry off whatever the config file says; null when none is set. Env can only turn it off. */
export function envOptOut(env: Env = process.env): 'DO_NOT_TRACK' | 'WATCHER_TELEMETRY_DISABLED' | 'test-runner' | null {
  if (envFlag(env.DO_NOT_TRACK)) return 'DO_NOT_TRACK'
  if (envFlag(env.WATCHER_TELEMETRY_DISABLED)) return 'WATCHER_TELEMETRY_DISABLED'
  if (envFlag(env.VITEST) || env.NODE_ENV === 'test' || env.JEST_WORKER_ID !== undefined) return 'test-runner'
  return null
}

export function telemetryDebug(env: Env = process.env): boolean {
  return envFlag(env.WATCHER_TELEMETRY_DEBUG)
}

const CI_VARS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TRAVIS', 'JENKINS_URL', 'TF_BUILD', 'CODEBUILD_BUILD_ID', 'BITBUCKET_BUILD_NUMBER', 'TEAMCITY_VERSION']

export function isCI(env: Env = process.env): boolean {
  return CI_VARS.some((name) => envFlag(env[name]))
}

/** The package this module ships in: src/shared/ in a checkout, dist/cli/ or dist/server/ in a bundle; both are two levels down. */
export function telemetryPackageRoot(): string {
  return resolve(fileURLToPath(new URL('../..', import.meta.url)))
}

export function packageVersion(root = telemetryPackageRoot()): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** How this copy was installed, from where it sits; `unknown` when nothing cheap says. */
export function installMethod(root = telemetryPackageRoot(), exists: (path: string) => boolean = existsSync): InstallMethod {
  if (exists('/.dockerenv')) return 'docker'
  if (root.split(sep).includes('node_modules')) return 'npm'
  if (exists(join(root, '.git'))) return 'checkout'
  return 'unknown'
}

export function telemetryContext(id: string, version: string, env: Env = process.env, root = telemetryPackageRoot()): TelemetryContext {
  return {
    id,
    version,
    node: process.versions.node,
    os: knownOs(process.platform),
    arch: knownArch(process.arch),
    ci: isCI(env),
    install: installMethod(root)
  }
}

// ---- the config file ---------------------------------------------------------------------------------------------------

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * The file, or null when there is none. A file that exists but does not parse throws: whoever wrote it (the user by hand,
 * most likely) may have meant `enabled: false`, so it is not quietly replaced.
 */
export function readTelemetryFile(path: string): TelemetryFile | null {
  if (!existsSync(path)) return null
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${path} is not a JSON object`)
  const pending = Array.isArray(raw.pending) ? raw.pending.map(parseEvent).filter((e): e is TelemetryEvent => e !== null) : []
  return {
    id: typeof raw.id === 'string' && UUID_V4.test(raw.id) ? raw.id : randomUUID(),
    enabled: raw.enabled !== false,
    chosenAt: typeof raw.chosenAt === 'string' ? raw.chosenAt : null,
    notifiedAt: typeof raw.notifiedAt === 'string' ? raw.notifiedAt : null,
    lastHeartbeatAt: typeof raw.lastHeartbeatAt === 'string' ? raw.lastHeartbeatAt : null,
    backoffUntil: typeof raw.backoffUntil === 'string' ? raw.backoffUntil : null,
    pending: pending.slice(-MAX_PENDING)
  }
}

/** Write the file whole (temp file + rename, 0600 in a 0700 dir). Throws when it cannot: each caller decides what that means. */
export function writeTelemetryFile(path: string, file: TelemetryFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * The fields a running process keeps up to date. The rest are set once (the id and the notice, at first run) or are the
 * user's choice (`enabled`, `chosenAt`), which only `setTelemetryEnabled` writes.
 */
export type TelemetryPatch = Partial<Omit<TelemetryFile, 'id' | 'enabled' | 'chosenAt' | 'notifiedAt'>>

/**
 * Change some fields of the file and keep the rest as they are on disk now, not as this process read them: another process
 * may have written it since (`watcher telemetry disable` while a server runs, another command's backoff). Writes nothing when
 * the file is gone, does not parse or says `enabled: false`, so a stored disable is never written over. Returns what is on
 * disk afterwards (null when there is no readable file); throws only when the write itself fails.
 */
export function updateTelemetryFile(path: string, patch: TelemetryPatch | ((file: TelemetryFile) => TelemetryPatch)): TelemetryFile | null {
  let disk: TelemetryFile | null
  try {
    disk = readTelemetryFile(path)
  } catch {
    return null
  }
  if (disk === null || !disk.enabled) return disk
  const file: TelemetryFile = { ...disk, ...(typeof patch === 'function' ? patch(disk) : patch) }
  writeTelemetryFile(path, file)
  return file
}

/** `watcher telemetry enable|disable`: the stored choice. Enabling by hand counts as having seen the notice. */
export function setTelemetryEnabled(enabled: boolean, env: Env = process.env, now = new Date()): { path: string; file: TelemetryFile } {
  const path = telemetryConfigPath(env)
  let current: TelemetryFile | null
  try {
    current = readTelemetryFile(path)
  } catch {
    current = null // an unreadable file is replaced by the explicit choice the user just made
  }
  const file: TelemetryFile = {
    id: current?.id ?? randomUUID(),
    enabled,
    chosenAt: now.toISOString(),
    notifiedAt: enabled ? (current?.notifiedAt ?? now.toISOString()) : (current?.notifiedAt ?? null),
    lastHeartbeatAt: current?.lastHeartbeatAt ?? null,
    backoffUntil: null,
    pending: enabled ? (current?.pending ?? []) : []
  }
  writeTelemetryFile(path, file)
  return { path, file }
}

/** Precedence: an opt-out env var, then the stored choice, then the default (on). */
export function decideTelemetry(env: Env, file: TelemetryFile | null, unreadable = false): TelemetryDecision {
  const optOut = envOptOut(env)
  if (optOut) return { enabled: false, reason: optOut }
  if (unreadable) return { enabled: false, reason: 'config-unreadable' }
  if (file && !file.enabled) return { enabled: false, reason: 'disabled-by-command' }
  if (file && file.chosenAt !== null) return { enabled: true, reason: 'enabled-by-command' }
  return { enabled: true, reason: 'default' }
}

export function telemetryNotice(): string {
  return [
    'EZO Watcher collects anonymous telemetry to find failures and improve the tool: the command run (flag names only),',
    'its exit code and duration, doctor check codes, internal error types with package stack frames, and a daily server',
    'heartbeat of counts. Never paths, hostnames, URLs, config or env values, incident text or error messages.',
    `Opt out: \`watcher telemetry disable\`, or DO_NOT_TRACK=1. Details: ${TELEMETRY_DOCS}`
  ].join('\n')
}

// ---- events built from runtime values ----------------------------------------------------------------------------------

/**
 * The stack frames of `stack` that point into the package at `root`, as `src/x.ts:12:3`. A frame outside the package (Node
 * internals, a dependency under node_modules, the user's own files) is dropped, not shortened: its path is theirs. Function
 * names are dropped too (see the FRAME pattern in telemetry-schema.ts).
 */
export function packageFrames(stack: string | undefined, root: string, max = 12): string[] {
  if (!stack) return []
  const frames: string[] = []
  for (const line of stack.split('\n')) {
    const m = /^\s+at (?:.+? \((.+)\)|(.+))$/.exec(line)
    if (!m) continue
    const location = m[1] ?? m[2] ?? ''
    const loc = /^(.*):(\d+):(\d+)$/.exec(location)
    if (!loc) continue
    let file = loc[1]
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file)
      } catch {
        continue
      }
    }
    if (!isAbsolute(file)) continue
    const rel = relative(root, file)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
    const path = rel.split(sep).join('/')
    if (path.split('/').includes('node_modules')) continue
    const frame = `${path}:${loc[2]}:${loc[3]}`
    if (isFrame(frame)) frames.push(frame)
    if (frames.length >= max) break
  }
  return frames
}

export function errorEvent(err: unknown, where: 'cli' | 'server', command: string | null, root = telemetryPackageRoot(), now = new Date()): ErrorEvent {
  const e = err instanceof Error ? err : null
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : undefined
  return {
    name: 'error',
    at: now.toISOString(),
    where,
    command: sanitizeWord(command),
    errorName: sanitizeErrorName(e?.name),
    code: sanitizeErrorCode(code),
    frames: packageFrames(e?.stack, root)
  }
}

function countBy(words: string[], known: (word: string) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const w of words) {
    const key = known(w)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export interface HeartbeatInput {
  uptimeMs: number
  sourceKinds: string[]
  channelKinds: string[]
  severities: string[]
  mcp: boolean
}

export function heartbeatEvent(input: HeartbeatInput, now = new Date()): HeartbeatEvent {
  const incidents = { page: 0, warning: 0, info: 0 }
  for (const s of input.severities) if (s === 'page' || s === 'warning' || s === 'info') incidents[s]++
  return {
    name: 'server.heartbeat',
    at: now.toISOString(),
    uptime: uptimeBucket(input.uptimeMs),
    sources: countBy(input.sourceKinds, knownSourceKind),
    channels: countBy(input.channelKinds, knownChannelType),
    incidents,
    mcp: input.mcp
  }
}

// ---- the client ----------------------------------------------------------------------------------------------------------

export interface TelemetryOptions {
  env?: Env
  /** The package root (frames are made relative to it, the version is read from it). */
  root?: string
  version?: string
  /** Where the notice and debug output go. The CLI writes stderr; the server writes its log. */
  print?: (text: string) => void
  fetch?: typeof fetch
  now?: () => Date
  timeoutMs?: number
}

export class Telemetry {
  readonly debug: boolean
  readonly path: string
  /** Sends in this process that failed or timed out. Expected (offline, firewalled), and never shown to the user. */
  sendFailures = 0
  private decided: TelemetryDecision
  /** The file as last read from disk; re-read before every send and every write (see `recheck`). */
  private file: TelemetryFile | null
  private context: TelemetryContext | null
  private readonly queue: TelemetryEvent[] = []
  private readonly env: Env
  private readonly print: (text: string) => void
  private readonly doFetch: typeof fetch
  private readonly now: () => Date
  private readonly timeoutMs: number
  private lastHeartbeatMs: number | null
  /** This process's own backoff after a send that got no answer, which holds even when the file cannot be written. */
  private pausedUntil = 0
  private readonly root: string
  /** Error signatures already reported by this process: a failure that repeats every tick is one event, not thousands. */
  private readonly reported = new Set<string>()

  /**
   * Read the stored choice and decide. When telemetry is on and the user has not been told yet, write the file (id +
   * notice time) and print the notice; when that write fails, telemetry stays off for this process, because nothing would
   * record that the notice was shown.
   */
  static open(opts: TelemetryOptions = {}): Telemetry {
    return new Telemetry(opts)
  }

  private constructor(opts: TelemetryOptions) {
    this.env = opts.env ?? process.env
    this.print = opts.print ?? ((text) => process.stderr.write(`${text}\n`))
    this.doFetch = opts.fetch ?? fetch
    this.now = opts.now ?? (() => new Date())
    this.timeoutMs = opts.timeoutMs ?? TELEMETRY_TIMEOUT_MS
    this.debug = telemetryDebug(this.env)
    this.path = telemetryConfigPath(this.env)
    const root = opts.root ?? telemetryPackageRoot()
    this.root = root
    const version = opts.version ?? packageVersion(root)

    let file: TelemetryFile | null = null
    let unreadable = false
    try {
      file = readTelemetryFile(this.path)
    } catch {
      unreadable = true
    }
    let decision = decideTelemetry(this.env, file, unreadable)
    if (decision.enabled && !this.debug && (file === null || file.notifiedAt === null)) {
      const told: TelemetryFile = {
        id: file?.id ?? randomUUID(),
        enabled: true,
        chosenAt: file?.chosenAt ?? null,
        notifiedAt: this.now().toISOString(),
        lastHeartbeatAt: file?.lastHeartbeatAt ?? null,
        backoffUntil: file?.backoffUntil ?? null,
        pending: file?.pending ?? []
      }
      try {
        writeTelemetryFile(this.path, told)
        file = told
        this.print(telemetryNotice())
      } catch {
        decision = { enabled: false, reason: 'config-unwritable' }
      }
    }
    this.decided = decision
    this.file = file
    this.lastHeartbeatMs = file?.lastHeartbeatAt ? Date.parse(file.lastHeartbeatAt) : null
    // Debug mode builds the payload even when telemetry is off, so a user can read what would go before turning it on. It
    // never sends, and it does not write the file: an id that is not stored yet is made up for the printout.
    this.context = decision.enabled || this.debug ? telemetryContext(file?.id ?? randomUUID(), version, this.env, root) : null
    if (decision.enabled && file && file.pending.length > 0) {
      this.queue.push(...file.pending)
      if (!this.debug) {
        try {
          this.file = updateTelemetryFile(this.path, { pending: [] })
        } catch {
          // Left in the file, the crash events would be sent again next time; dropping them here keeps one copy in flight.
          this.queue.length = 0
        }
      }
    }
  }

  /** On or off, and why. Decided at start; a later opt-out (see `recheck`) turns it off, and nothing turns it back on. */
  get decision(): TelemetryDecision {
    return this.decided
  }

  /** Whether events are recorded at all (sent, or printed in debug mode). */
  get active(): boolean {
    return this.context !== null
  }

  /**
   * Re-read the file before a send or a write: the user may have run `watcher telemetry disable` (or set DO_NOT_TRACK) since
   * this process started, and a server runs for weeks. An opt-out found here turns telemetry off for the rest of the process
   * and drops what is queued (debug mode keeps both, to print what would have gone). A tiny sync read; it never throws.
   * Returns whether telemetry is still on.
   */
  private recheck(): boolean {
    if (!this.decided.enabled) return false
    let file: TelemetryFile | null = null
    let unreadable = false
    try {
      file = readTelemetryFile(this.path)
    } catch {
      unreadable = true
    }
    const decision = decideTelemetry(this.env, file, unreadable)
    this.file = file
    if (decision.enabled) return true
    this.decided = decision
    if (!this.debug) {
      this.queue.length = 0
      this.context = null
    }
    return false
  }

  record(event: TelemetryEvent): void {
    if (!this.active || this.queue.length >= TELEMETRY_MAX_EVENTS) return
    this.queue.push(event)
  }

  /** The batch the next flush would send, or null when there is nothing to send. */
  batch(): TelemetryBatch | null {
    if (!this.context || this.queue.length === 0) return null
    return { schema: TELEMETRY_SCHEMA, context: this.context, events: [...this.queue] }
  }

  /** Send what is queued, once. Resolves within the timeout and never rejects. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return
    this.recheck()
    const batch = this.batch()
    if (!batch) return
    this.queue.length = 0
    if (this.debug) {
      const state = this.decision.enabled ? 'not sent (debug)' : `not sent (telemetry is off: ${this.decision.reason})`
      const paused = this.file?.backoffUntil && Date.parse(this.file.backoffUntil) > this.now().getTime() ? `; sends paused until ${this.file.backoffUntil}: an earlier send got no answer` : ''
      this.print(`[telemetry] ${state}${paused}: ${JSON.stringify(batch)}`)
      return
    }
    if (!this.decision.enabled) return
    const now = this.now().getTime()
    const storedUntil = this.file?.backoffUntil ? Date.parse(this.file.backoffUntil) : Number.NaN
    if (now < storedUntil || now < this.pausedUntil) return
    try {
      const res = await this.doFetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': `ezo-watcher/${batch.context.version}` },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      if (!res.ok) this.sendFailures++
      await res.body?.cancel()
    } catch {
      // No answer at all (offline, or a firewall that drops the packets): stop trying for an hour, so a machine that cannot
      // reach the collector does not wait out the timeout on every command.
      this.sendFailures++
      this.pausedUntil = this.now().getTime() + BACKOFF_MS
      if (!this.recheck()) return
      try {
        this.file = updateTelemetryFile(this.path, { backoffUntil: new Date(this.pausedUntil).toISOString() })
      } catch {
        // Without the file the backoff holds for this process only (`pausedUntil`), which is still one timeout per process.
      }
    }
  }

  /**
   * Report an internal error and send it now (not awaited). Each signature (type, code, top frame) goes once per process,
   * and at most 20 do: a server whose tick fails every five seconds reports the failure, not its rate.
   */
  captureError(err: unknown, where: 'cli' | 'server', command: string | null = null): void {
    if (!this.active) return
    const event = errorEvent(err, where, command, this.root, this.now())
    const signature = `${event.errorName}|${event.code ?? ''}|${event.frames[0] ?? ''}`
    if (this.reported.has(signature) || this.reported.size >= 20) return
    this.reported.add(signature)
    this.record(event)
    void this.flush()
  }

  /** An uncaught exception, kept for the next process (see `persist`). */
  captureCrash(err: unknown, where: 'cli' | 'server'): void {
    if (!this.active) return
    this.persist(errorEvent(err, where, null, this.root, this.now()))
  }

  /**
   * Keep an error event for the next process, synchronously: for an uncaught exception, where the process is about to exit
   * and an async send would never finish.
   */
  persist(event: TelemetryEvent): void {
    if (!this.active) return
    if (this.debug) {
      this.print(`[telemetry] kept for the next run (debug: not stored): ${JSON.stringify(event)}`)
      return
    }
    if (!this.recheck()) return
    try {
      this.file = updateTelemetryFile(this.path, (disk) => ({ pending: [...disk.pending, event].slice(-MAX_PENDING) }))
    } catch {
      // The process is crashing and the file cannot be written: the event is lost, which costs nothing but the event.
    }
  }

  /** Whether a day has passed since the last heartbeat any process on this machine sent. */
  heartbeatDue(): boolean {
    if (!this.active) return false
    return this.lastHeartbeatMs === null || this.now().getTime() - this.lastHeartbeatMs >= DAY_MS
  }

  /** Record that a heartbeat went (in memory always; in the file when it can be written). */
  markHeartbeat(): void {
    const at = this.now()
    this.lastHeartbeatMs = at.getTime()
    if (this.debug || !this.recheck()) return
    try {
      this.file = updateTelemetryFile(this.path, { lastHeartbeatAt: at.toISOString() })
    } catch {
      // In-memory state still holds this process to one heartbeat a day.
    }
  }
}

/**
 * Check every `everyMs` (first after `firstMs`) whether the daily heartbeat is due, and send it. The timers are unref'd:
 * they never keep a stopping server alive. Returns a stop function.
 */
export function scheduleHeartbeat(telemetry: Telemetry, collect: () => HeartbeatInput, opts: { firstMs?: number; everyMs?: number } = {}): () => void {
  if (!telemetry.active) return () => {}
  const beat = (): void => {
    if (!telemetry.heartbeatDue()) return
    let input: HeartbeatInput
    try {
      input = collect()
    } catch (err) {
      // A timer callback that threw would take the server down; the failure is the server's own, so it is reported as one.
      telemetry.captureError(err, 'server')
      return
    }
    telemetry.record(heartbeatEvent(input))
    telemetry.markHeartbeat()
    void telemetry.flush()
  }
  let interval: ReturnType<typeof setInterval> | null = null
  const first = setTimeout(() => {
    beat()
    interval = setInterval(beat, opts.everyMs ?? 3_600_000)
    interval.unref()
  }, opts.firstMs ?? 60_000)
  first.unref()
  return () => {
    clearTimeout(first)
    if (interval) clearInterval(interval)
  }
}
