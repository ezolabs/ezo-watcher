// The project this CLI runs against: its `.watcher/` state directory, its config, its env file,
// its data dir, and the few filesystem facts every verb needs. One module owns the layout so
// `init`, `add`, `doctor` and `run` can never disagree about where a file lives.
//
// The layout is the contract:
//   .watcher/config.json   the config, committed (monitoring as code)
//   .watcher/.env          secrets, mode 0600, gitignored
//   .watcher/.env.example  every variable name and no value, committed
//   .watcher/.gitignore    `.env` and `data/`
//   .watcher/data/         SQLite and the run pid/log, gitignored

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateConfig } from '../server/config.ts'
import type { WatchConfig } from '../server/config.ts'
import { runProcess, sleep } from './util.ts'

export interface Project {
  /** Absolute project directory (the user's project, not this package). */
  dir: string
  watcherDir: string
  configPath: string
  envPath: string
  envExamplePath: string
}

export interface ProjectWithData extends Project {
  dataDir: string
  pidPath: string
  logPath: string
}

/** Resolve the project from --dir (or cwd), honoring WATCHER_CONFIG for the config path. */
export function resolveProject(dirArg?: string): Project {
  const dir = resolve(dirArg ?? process.cwd())
  const watcherDir = join(dir, '.watcher')
  const envConfig = process.env.WATCHER_CONFIG
  const configPath = envConfig ? (isAbsolute(envConfig) ? envConfig : resolve(dir, envConfig)) : join(watcherDir, 'config.json')
  return {
    dir,
    watcherDir,
    configPath,
    envPath: join(watcherDir, '.env'),
    envExamplePath: join(watcherDir, '.env.example')
  }
}

/**
 * The data directory: WATCHER_DATA_DIR, else the config's dataDir, else `.watcher/data`, always
 * resolved against the project. It is never `/data` unless the config says so: a local run must not
 * try to write a root-owned path (the measured EPERM of the pre-Watcher template).
 */
export function withDataDir(project: Project, config: WatchConfig | null): ProjectWithData {
  const fromEnv = process.env.WATCHER_DATA_DIR
  const fromConfig = config?.dataDir
  const chosen = fromEnv && fromEnv.trim() !== '' ? fromEnv : fromConfig && fromConfig.trim() !== '' ? fromConfig : '.watcher/data'
  const dataDir = resolve(project.dir, chosen)
  return { ...project, dataDir, pidPath: join(dataDir, 'watcher.pid'), logPath: join(dataDir, 'watcher.log') }
}

export type ConfigRead =
  | { ok: true; raw: Record<string, unknown>; config: WatchConfig }
  | { ok: false; error: { code: string; message: string; next?: string } }

/** Read and validate `.watcher/config.json`. Every failure carries the fix. */
export function readConfig(project: Project): ConfigRead {
  if (!existsSync(project.configPath)) {
    return {
      ok: false,
      error: {
        code: 'config.missing',
        message: `${project.configPath} does not exist`,
        next: 'Run `watcher init` in the project directory.'
      }
    }
  }
  let text: string
  try {
    text = readFileSync(project.configPath, 'utf8')
  } catch (err) {
    return { ok: false, error: { code: 'config.unreadable', message: `${project.configPath}: ${(err as Error).message}`, next: `chmod +r ${project.configPath}` } }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'config.invalid',
        message: `${project.configPath} is not JSON: ${(err as Error).message}`,
        next: `Fix the JSON in ${project.configPath} (or restore it from git).`
      }
    }
  }
  const checked = validateConfig(raw)
  if (!checked.ok) {
    return {
      ok: false,
      error: {
        code: 'config.invalid',
        message: `${project.configPath}: ${checked.errors.join('; ')}`,
        next: `Edit ${project.configPath} so the server's validator accepts it, then run \`watcher doctor\`.`
      }
    }
  }
  return { ok: true, raw: raw as Record<string, unknown>, config: checked.config }
}

/** Validate, then write the config atomically. Returns the validator's refusal rather than a half write. */
export function writeConfig(project: Project, raw: Record<string, unknown>): { ok: true } | { ok: false; error: { code: string; message: string; next?: string } } {
  const checked = validateConfig(raw)
  if (!checked.ok) {
    return {
      ok: false,
      error: { code: 'config.invalid', message: checked.errors.join('; '), next: 'Fix the fields named above and run the command again.' }
    }
  }
  writeFileAtomic(project.configPath, `${JSON.stringify(raw, null, 2)}\n`, 0o644)
  return { ok: true }
}

/** Write through a temp file in the same directory, then rename: a crash never leaves a truncated file. */
export function writeFileAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, content, { mode: mode ?? 0o644 })
    if (mode !== undefined) chmodSync(tmp, mode)
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

// ---- the env file ------------------------------------------------------------------------------------

/** Parse a KEY=VALUE env file into a map. Comments and blank lines are ignored; no interpolation, no quoting rules beyond one pair of quotes. */
export function readEnvVars(path: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(path)) return out
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out.set(m[1], value)
  }
  return out
}

/** The env file's text with `updates` applied, keeping every other line where it was. */
export function mergeEnvText(existing: string, updates: Record<string, string>): string {
  const lines = existing === '' ? [] : existing.replace(/\n$/, '').split('\n')
  const done = new Set<string>()
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (!m || !(m[1] in updates)) return line
    done.add(m[1])
    return `${m[1]}=${updates[m[1]]}`
  })
  for (const [key, value] of Object.entries(updates)) if (!done.has(key)) out.push(`${key}=${value}`)
  return `${out.join('\n')}\n`
}

/** Write env updates at mode 0600 (the file holds every secret this project has). */
export function writeEnvVars(path: string, updates: Record<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  writeFileAtomic(path, mergeEnvText(existing, updates), 0o600)
}

/** `.env.example`: every name, no value. Sorted so two runs produce the same file. */
export function writeEnvExample(path: string, names: string[]): void {
  const unique = [...new Set(names)].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)).sort()
  writeFileAtomic(path, `${unique.map((n) => `${n}=`).join('\n')}\n`, 0o644)
}

/** A fresh secret: 32 random bytes in hex, the shape every WATCHER_* token uses. */
export function newSecret(): string {
  return randomBytes(32).toString('hex')
}

// ---- gitignore ---------------------------------------------------------------------------------------

export interface GitignoreResult {
  path: string
  added: string[]
  created: boolean
}

/** Ensure each entry is present in the project's `.gitignore`; create the file when absent. */
export function ensureGitignored(project: Project, entries: string[]): GitignoreResult {
  const path = join(project.dir, '.gitignore')
  const existed = existsSync(path)
  const existing = existed ? readFileSync(path, 'utf8') : ''
  const lines = existing === '' ? [] : existing.replace(/\n$/, '').split('\n')
  const present = new Set(lines.map((l) => l.trim()))
  const added = entries.filter((e) => !present.has(e))
  if (added.length > 0) {
    const prefix = existing === '' ? '' : existing.endsWith('\n') ? '' : '\n'
    writeFileAtomic(path, `${existing}${prefix}${added.join('\n')}\n`, 0o644)
  }
  return { path, added, created: !existed }
}

/** `git check-ignore -q -- <relative path>`; false outside a git work tree or when the path is not ignored. */
export function gitCheckIgnored(project: Project, relPath: string): boolean {
  const r = runProcess('git', ['-C', project.dir, 'check-ignore', '-q', '--', relPath], { timeoutMs: 5000 })
  return r.status === 0
}

/** Whether the project is inside a git work tree. */
export function isGitWorkTree(project: Project): boolean {
  const r = runProcess('git', ['-C', project.dir, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 5000 })
  return r.status === 0 && r.stdout.trim() === 'true'
}

// ---- the network side of a project --------------------------------------------------------------------

/** Whether `127.0.0.1:<port>` can be bound right now. */
export async function portIsFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', () => resolvePromise(false))
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => resolvePromise(true))
    })
  })
}

/** The first free port at or after `start`, trying `tries` numbers. */
export async function findFreePort(start: number, host = '127.0.0.1', tries = 50): Promise<{ port: number; moved: boolean }> {
  for (let p = start; p < start + tries && p <= 65535; p++) {
    if (await portIsFree(p, host)) return { port: p, moved: p !== start }
  }
  throw new Error(`no free port from ${start} to ${Math.min(start + tries - 1, 65535)}`)
}

export type PortState = { kind: 'free' } | { kind: 'watcher'; instance: unknown } | { kind: 'other'; status: number; body: string }

/**
 * What answers on a port: nothing (free), this Watcher (healthz 200 and /api/instance answers
 * with a brand), or something else. A port held by a dead process reads free; a port held by
 * another service reads other, and doctor names it `port.in-use`.
 */
export async function probePort(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<PortState> {
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`
  const get = async (path: string): Promise<{ status: number; text: string } | null> => {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
      const text = await res.text().catch(() => '')
      return { status: res.status, text: text.slice(0, 4096) }
    } catch {
      return null
    }
  }
  const health = await get('/healthz')
  if (health === null) return { kind: 'free' }
  if (health.status === 200) {
    const instance = await get('/api/instance')
    if (instance && instance.status === 200) {
      try {
        const parsed = JSON.parse(instance.text) as { brand?: { name?: unknown } }
        if (parsed && typeof parsed.brand?.name === 'string') return { kind: 'watcher', instance: parsed }
      } catch {
        // not this Watcher's JSON
      }
    }
  }
  return { kind: 'other', status: health.status, body: health.text.slice(0, 200) }
}

/** Wait until a URL answers 200 or the deadline passes; returns the last status (null when nothing answered). */
export async function waitForHttp(url: string, timeoutMs: number): Promise<number | null> {
  const started = Date.now()
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'manual' })
      if (res.status >= 200 && res.status < 500) return res.status
    } catch {
      // not up yet
    }
    if (Date.now() - started >= timeoutMs) return null
    await sleep(150)
  }
}

// ---- config helpers ------------------------------------------------------------------------------------

/** Every env-var NAME the config refers to (keys ending in `Env`), plus the three the CLI itself writes. */
export function configSecretNames(raw: unknown, extra: string[] = []): string[] {
  const names = new Set<string>(extra)
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v)
      return
    }
    if (typeof node !== 'object' || node === null) return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k.endsWith('Env') && typeof v === 'string' && v.trim() !== '') names.add(v.trim())
      else walk(v)
    }
  }
  walk(raw)
  return [...names].sort()
}

/** `{foundAt, read}` from a source's optional `discovered` block (#29), or null. */
export function discoveredOf(source: unknown): { foundAt?: string; read?: string } | null {
  if (typeof source !== 'object' || source === null) return null
  const d = (source as { discovered?: unknown }).discovered
  if (typeof d !== 'object' || d === null) return null
  const { foundAt, read } = d as { foundAt?: unknown; read?: unknown }
  return {
    ...(typeof foundAt === 'string' && foundAt.trim() !== '' ? { foundAt: foundAt.trim() } : {}),
    ...(typeof read === 'string' && read.trim() !== '' ? { read: read.trim() } : {})
  }
}

/** A source is required unless it says otherwise (the shape #36 may add is honoured when present). */
export function isRequiredSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return true
  const s = source as { required?: unknown; optional?: unknown }
  if (s.required === false) return false
  if (s.optional === true) return false
  return true
}

/** The hash `add` stamps into `_meta`: over the sources and channels as written, canonicalized. */
export function managedHash(raw: Record<string, unknown>): string {
  const managed = { sources: raw.sources ?? [], channels: raw.channels ?? [] }
  const stable = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`
  }
  return createHash('sha256').update(stable(managed)).digest('hex')
}

/** This package's root (the directory holding package.json and `src/`). */
export function packageRoot(): string {
  return resolve(fileURLToPath(new URL('../..', import.meta.url)))
}

/** The CLI's version, read from the package it ships in. */
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** The URL this Watcher is served on, from host and port. */
export function watcherUrl(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${h}:${port}`
}

/** True when the path exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
