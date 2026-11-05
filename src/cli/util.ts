// Argument parsing and the small pieces every verb shares: an error type that main.ts turns into
// an exit code and an error document, file/JSON helpers, a PATH lookup, and the spawn helper.
//
// The parser is strict on purpose. An agent that mistypes `--intervl` must be told, not silently
// served a 60 s default: a flag a command did not declare is a usage error (exit 64).

import { spawnSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import type { OutputFormat } from './output.ts'

export class CliError extends Error {
  readonly code: string
  readonly exitCode: number
  readonly next?: string

  constructor(code: string, message: string, opts: { exitCode?: number; next?: string } = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = opts.exitCode ?? 1
    this.next = opts.next
  }
}

/** A usage mistake: exit 64, and the message is the fix. */
export function usageError(code: string, message: string, next?: string): CliError {
  return new CliError(code, message, { exitCode: 64, next })
}

export interface ParsedArgs {
  /** The first positional: the verb. */
  command: string
  /** The second positional, when the verb has sub-verbs (add channel, service install, cloudflare tunnel). */
  sub: string | undefined
  /** Every positional after the verb (and the sub-verb when the command declares one). */
  positionals: string[]
  /** Value flags by name, each with every occurrence. */
  values: Map<string, string[]>
  /** Boolean flags that were given (or `--no-x`: false). */
  switches: Map<string, boolean>
  /** The project directory from --dir, resolved by the caller. */
  dir: string | undefined
  format: OutputFormat
  json: boolean
  dryRun: boolean
  showSecret: boolean
  help: boolean
  version: boolean
}

const GLOBAL_SWITCHES = new Set(['help', 'version', 'json', 'dry-run', 'show-secret', 'quiet', 'no-color', 'color'])

/**
 * Parse argv. `valueFlags` names every flag that takes a value; `switchFlags` every boolean one
 * this command knows. `subVerbs` are the second positionals the command understands (used only to
 * peel the sub-verb off; commands with no sub-verbs leave it undefined).
 */
export function parseArgs(argv: string[], spec: { valueFlags: string[]; switchFlags?: string[]; subVerbs?: string[] }): ParsedArgs {
  const values = new Map<string, string[]>()
  const switches = new Map<string, boolean>()
  const positionals: string[] = []
  const knownValues = new Set(spec.valueFlags)
  const knownSwitches = new Set([...GLOBAL_SWITCHES, ...(spec.switchFlags ?? [])])

  const addValue = (name: string, value: string): void => {
    const list = values.get(name) ?? []
    list.push(value)
    values.set(name, list)
  }

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (raw === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (raw.startsWith('--')) {
      const body = raw.slice(2)
      const eq = body.indexOf('=')
      const name = eq >= 0 ? body.slice(0, eq) : body
      const inline = eq >= 0 ? body.slice(eq + 1) : undefined
      if (name.startsWith('no-')) {
        // A declared switch named `no-...` (--no-load, --no-runtime-surface) wins over reading the
        // name as the negation of a `load`/`runtime-surface` switch.
        if (knownSwitches.has(name)) {
          switches.set(name, true)
          continue
        }
        const base = name.slice(3)
        if (!knownSwitches.has(base)) throw usageError('usage.unknown-flag', `unknown flag --${name}`, 'Run `watcher help` for the flags of each verb.')
        switches.set(base, false)
        continue
      }
      if (inline !== undefined) {
        if (knownSwitches.has(name) && !knownValues.has(name)) {
          switches.set(name, inline !== 'false' && inline !== '0')
          continue
        }
        if (!knownValues.has(name)) throw unknownFlag(name)
        addValue(name, inline)
        continue
      }
      if (knownSwitches.has(name) && !knownValues.has(name)) {
        switches.set(name, true)
        continue
      }
      if (!knownValues.has(name)) throw unknownFlag(name)
      const next = argv[i + 1]
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        throw usageError('usage.missing-value', `--${name} needs a value`, `Example: --${name} <value>`)
      }
      addValue(name, next)
      i++
      continue
    }
    if (raw.startsWith('-') && raw !== '-') {
      if (raw === '-h') switches.set('help', true)
      else if (raw === '-v') switches.set('version', true)
      else if (raw === '-q') switches.set('quiet', true)
      else throw usageError('usage.unknown-flag', `unknown flag ${raw}`, 'Flags are the long form (--help); short flags are -h, -v, -q only.')
      continue
    }
    positionals.push(raw)
  }

  const outputRaw = values.get('output')?.[0]
  const format: OutputFormat = outputRaw === 'json' || outputRaw === 'md' || outputRaw === 'table'
    ? outputRaw
    : switches.get('json') === true
      ? 'json'
      : switches.get('quiet') === true
        ? 'json'
        : 'table'
  if (outputRaw !== undefined && outputRaw !== 'json' && outputRaw !== 'md' && outputRaw !== 'table') {
    throw usageError('usage.bad-output', `--output must be json, md or table, not ${JSON.stringify(outputRaw)}`, 'Run `watcher status --output md` for a report.')
  }

  let command = ''
  let sub: string | undefined
  let rest = positionals
  if (positionals.length > 0) {
    command = positionals[0]
    rest = positionals.slice(1)
    if (spec.subVerbs?.includes(rest[0] ?? '')) {
      sub = rest[0]
      rest = rest.slice(1)
    }
  }

  return {
    command,
    sub,
    positionals: rest,
    values,
    switches,
    dir: values.get('dir')?.[0],
    format,
    json: format === 'json',
    dryRun: switches.get('dry-run') === true,
    showSecret: switches.get('show-secret') === true,
    help: switches.get('help') === true,
    version: switches.get('version') === true
  }
}

function unknownFlag(name: string): CliError {
  return usageError('usage.unknown-flag', `unknown flag --${name}`, 'Run `watcher help` for the flags of each verb.')
}

/** The first value of a flag, or undefined. */
export function flagValue(args: ParsedArgs, name: string): string | undefined {
  return args.values.get(name)?.[0]
}

/** Every value of a repeatable flag. */
export function flagValues(args: ParsedArgs, name: string): string[] {
  return args.values.get(name) ?? []
}

/** A required value flag, with a usage error when it is absent. */
export function requireFlag(args: ParsedArgs, name: string, why: string): string {
  const v = flagValue(args, name)
  if (v === undefined || v.trim() === '') throw usageError('usage.missing-flag', `--${name} is required: ${why}`, `Add --${name} <value>.`)
  return v
}

/** A flag parsed as a whole number in [lo, hi]. */
export function numberFlag(args: ParsedArgs, name: string, opts: { min?: number; max?: number; fallback?: number } = {}): number | undefined {
  const raw = flagValue(args, name)
  if (raw === undefined) return opts.fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || !Number.isFinite(n)) throw usageError('usage.bad-number', `--${name} must be a whole number, not ${JSON.stringify(raw)}`)
  if (opts.min !== undefined && n < opts.min) throw usageError('usage.bad-number', `--${name} must be at least ${opts.min}`)
  if (opts.max !== undefined && n > opts.max) throw usageError('usage.bad-number', `--${name} must be at most ${opts.max}`)
  return n
}

/** Parse a JSON object passed on the command line (for --expect-json). */
export function jsonFlag(args: ParsedArgs, name: string): Record<string, unknown> | undefined {
  const raw = flagValue(args, name)
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw usageError('usage.bad-json', `--${name} is not JSON: ${raw.slice(0, 120)}`, `Example: --${name} '{"ok":true}'`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw usageError('usage.bad-json', `--${name} must be a JSON object`, `Example: --${name} '{"ok":true}'`)
  }
  return parsed as Record<string, unknown>
}

/** Run a command, capture stdout/stderr, never shell out through a string. */
export function runProcess(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 16 * 1024 * 1024
  })
  return { status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') }
}

/** Whether an executable is on PATH (no shell, no `which` subprocess: the same lookup a shell does). */
export function commandOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.PATH ?? ''
  for (const dir of path.split(':')) {
    if (!dir) continue
    const candidate = `${dir.replace(/\/+$/, '')}/${name}`
    try {
      const st = statSync(candidate)
      if (!st.isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return null
}

/** "127.0.0.1:7717" for a URL's host and port (the port filled from the scheme), or null. */
export function hostPortOf(raw: string): string | null {
  try {
    const u = new URL(raw)
    const port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '')
    return port ? `${u.hostname.replace(/^\[|\]$/g, '')}:${port}` : u.hostname
  } catch {
    return null
  }
}

/** True for a loopback hostname or address. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0:0:0:0:0:0:0:1'
}

/** Sleep without a busy loop. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One line safe for a table: no newlines, no tabs. */
export function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').trim()
}

/** A slug for a proposed id: lower-case letters, digits and dashes, at most 40. */
export function slugify(text: string, fallback = 'source'): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s === '' ? fallback : s
}

/** A stable JSON string: object keys sorted, so a hash over it does not move when a writer reorders fields. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
