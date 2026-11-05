// Shared plumbing for the acceptance transcripts: run a command, wait for a condition, read the project's env, and print
// PASS/FAIL lines. Node standard library only — the harness itself must never be the reason a run fails.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..', '..')
export const FIXTURE = join(HERE, 'fixture')

/** The CLI under test: `--cli <path>`, then `$WATCHER_CLI`, then this repo's bin. */
export function cliPath(explicit) {
  if (explicit) return resolve(explicit)
  if (process.env.WATCHER_CLI) return resolve(process.env.WATCHER_CLI)
  return join(ROOT, 'bin', 'watcher.mjs')
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Run a command to completion; never throws on a non-zero exit (the caller judges it). */
export function run(command, args, { cwd = ROOT, env = {}, timeoutMs = 120_000 } = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, WATCHER_TELEMETRY_DISABLED: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: code ?? 1, stdout, stderr, timedOut })
    })
  })
}

export function runCli(cli, args, opts = {}) {
  return run(process.execPath, [cli, ...args], opts)
}

/** A CLI read/report verb in JSON mode: `--json` is the contract's shorthand for `--output json`. */
export async function runCliJson(cli, args, opts = {}) {
  const r = await runCli(cli, [...args, '--json'], opts)
  let json = null
  try {
    json = JSON.parse(r.stdout)
  } catch {
    json = null
  }
  return { ...r, json }
}

/** A free TCP port, preferring this worker's allotted range so two acceptance runs on one machine do not collide. */
export async function freePort(from = 45940, to = 45949) {
  for (let port = from; port <= to; port++) {
    if (await canBind(port)) return port
  }
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => done(port))
    })
  })
}

function canBind(port) {
  return new Promise((done) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', () => done(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
  })
}

export async function waitFor(probe, { timeoutMs = 15_000, intervalMs = 250, label = 'the condition' } = {}) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await probe()
      if (value) return value
      last = value
    } catch (err) {
      last = err
    }
    await sleep(intervalMs)
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`)
}

export async function httpJson(url, { headers = {}, timeoutMs = 3000 } = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { status: res.status, json, text }
  } catch {
    return { status: 0, json: null, text: '' }
  }
}

/** The names and values in a project's `.watcher/.env`; the file is generated 0600 by `watcher init`. */
export function readEnvFile(path) {
  const out = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/**
 * A fresh work directory under `.tmp/`, which the repository already ignores. The base is created on demand: a fresh
 * clone or archive has no `.tmp/`, and `mkdtempSync` onto a missing parent dies with ENOENT before a run starts.
 */
export function workDir(prefix) {
  const base = join(ROOT, '.tmp')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, prefix))
}

/** Copy the fixture into a fresh project directory under `.tmp/`, which the repository already ignores. */
export function makeProject() {
  const work = workDir('acceptance-')
  const project = join(work, 'app')
  cpSync(FIXTURE, project, { recursive: true })
  return { work, project }
}

export function removeProject(work) {
  if (process.env.KEEP_ACCEPTANCE) {
    console.log(`kept  ${work}`)
    return
  }
  rmSync(work, { recursive: true, force: true })
}

/** `git status --porcelain` in the project: an empty answer means the install wrote nothing a person had to type. */
export async function gitStatus(project) {
  const r = await run('git', ['status', '--porcelain'], { cwd: project, timeoutMs: 20_000 })
  return r
}

/** True when the project has a real outage to prove: an open ProbeDown incident, or any firing incident. */
export function firingIncidents(state) {
  const incidents = Array.isArray(state?.incidents) ? state.incidents : []
  return incidents.filter((i) => i?.state?.firing !== false)
}

export class Checks {
  constructor() {
    this.passes = 0
    this.failures = 0
  }

  pass(what, detail = '') {
    this.passes++
    console.log(`PASS  ${what}${detail ? ` — ${detail}` : ''}`)
  }

  fail(what, detail = '') {
    this.failures++
    console.log(`FAIL  ${what}${detail ? ` — ${detail}` : ''}`)
  }

  skip(what, why = '') {
    console.log(`SKIP  ${what}${why ? ` — ${why}` : ''}`)
  }

  get ok() {
    return this.failures === 0
  }
}

/** The one line that matters at the end of a transcript. */
export function finishRun(checks) {
  console.log('')
  if (checks.ok) {
    console.log(`acceptance: ${checks.passes} passed, 0 failed`)
    return 0
  }
  console.log(`acceptance: ${checks.passes} passed, ${checks.failures} failed`)
  return 1
}

/** The tail of a log file, for a failure message that names what the process said. */
export function tail(path, lines = 20) {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n')
}

/** A scratch directory the transcripts can use without touching the project under test. */
export function scratch(work, name) {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** `os.tmpdir()` is shared by every worker on the machine: a transcript never writes a fixed name there. */
export const SHARED_TMP = tmpdir()
