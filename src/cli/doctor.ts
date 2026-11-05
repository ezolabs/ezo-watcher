// `watcher doctor`: every check that decides whether this Watcher is actually watching, in the order
// an operator needs them. Two modes:
//
//   static (default)   node, .watcher, config validity, secrets present, the env file git-ignored,
//                      the data dir writable, the port free or this Watcher up, channels configured,
//                      the config untouched since `add` wrote it, no self-probe, no config leak in a
//                      built web bundle, and each source's provenance (#29's foundAt) intact.
//   --live             additionally reads the running server's /api/doctor and /api/state (never
//                      instantiating a source, never polling twice): /healthz, every polled source
//                      reached at least once, every source that can assert something did, no source
//                      in error/stale.
//   --prove            the gate that matters: for each source, take the reading the running server recorded (an http-probe
//                      answer, a heartbeat's schedule state, a host's figures, a tcp connect, an RDAP expiry), move it past
//                      the rule's own threshold and require the same evaluator the poll uses to go red. A check that cannot
//                      be turned red is a vacuous assertion. Kinds with no evaluator (a sender's alerts) are a named skip.
//
// Exit 0 when no check fails (warnings and skips are fine, except a skipped *required* source), 1
// when one does. Every failure carries `next`: the command or edit that fixes it.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { brandOf } from '../server/config.ts'
import type { DomainExpirySourceConfig, HeartbeatSourceConfig, HostSourceConfig, HttpProbeTargetConfig, TcpProbeSourceConfig, WatchConfig } from '../server/config.ts'
import { isSelfProbe, proveProbe, valueAt } from '../server/sources/http-probe.ts'
import { PROBE_RULES } from '../server/sources/http-probe.ts'
import { proveHeartbeat } from '../server/sources/heartbeat.ts'
import { proveHost } from '../server/sources/host.ts'
import { DOMAIN_EXPIRY_DEFAULTS, DOMAIN_RULES, normalizeDomainExpiry } from '../server/sources/domain-expiry.ts'
import type { DomainReading } from '../server/sources/domain-expiry.ts'
import { TCP_PROBE_DEFAULTS, normalizeTcpProbe } from '../server/sources/tcp-probe.ts'
import type { TcpTargetReading } from '../server/sources/tcp-probe.ts'
import type { ParsedArgs } from './util.ts'
import { CliError, hostPortOf, oneLine } from './util.ts'
import type { Output } from './output.ts'
import type { Project } from './project.ts'
import {
  configSecretNames,
  discoveredOf,
  gitCheckIgnored,
  isGitWorkTree,
  isRequiredSource,
  managedHash,
  packageRoot,
  probePort,
  readConfig,
  readEnvVars,
  resolveProject,
  withDataDir
} from './project.ts'
import { scanProject } from './signals/detect.ts'

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip'

export interface Check {
  code: string
  status: CheckStatus
  message: string
  /** The exact command or edit that fixes it. Always present on fail and warn. */
  next?: string
}

export interface DoctorResult {
  ok: boolean
  target: 'local' | 'cloudflare'
  checks: Check[]
  live: boolean
  /** Set only for the documented third verdict: a project with nothing to run. */
  reason?: string
}

export interface DoctorOptions {
  project: Project
  live: boolean
  prove: boolean
  noRuntimeSurface: boolean
  target: 'local' | 'cloudflare'
  /** For doctor --target cloudflare: the hostname to verify. Absent = read it from the tunnel's ingress. */
  hostname?: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** The project scan `--no-runtime-surface` reads. Injected by tests so a scan that throws can be proven to warn. */
  scanImpl?: typeof scanProject
}

export const DOCTOR_SPEC = {
  valueFlags: ['dir', 'output', 'target', 'hostname'],
  switchFlags: ['live', 'prove', 'no-runtime-surface', 'help', 'dry-run']
} as const

const MANDATORY_SECRETS = ['WATCHER_ACK_SECRET', 'WATCHER_ADMIN_TOKEN']

/** The kinds whose cells carry assertions (a probe, a heartbeat, an expiry, this machine's thresholds): only they can read as bare. */
const ASSERTION_KINDS = new Set<string>(['http-probe', 'tcp-probe', 'heartbeat', 'domain-expiry', 'host'])

/** The scan signals that mean something runs: an HTTP route, a schedule, an inbound webhook or an open port. */
const SURFACE_SIGNAL_KINDS = new Set<string>(['http-probe', 'heartbeat', 'webhook', 'tcp-probe'])

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const { project } = opts
  const fetchImpl = opts.fetchImpl ?? fetch
  const checks: Check[] = []
  const add = (check: Check): void => {
    checks.push(check)
  }
  const configRead = readConfig(project)
  const config = configRead.ok ? configRead.config : null
  const raw = configRead.ok ? configRead.raw : null
  let skippedRequired = false

  // 1. node version: type stripping went unflagged in 22.18 and 23.6; 24 is the supported line.
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
  const stripsTypes = nodeMajor > 24 || nodeMajor === 24 || (nodeMajor === 22 && nodeMinor >= 18) || (nodeMajor === 23 && nodeMinor >= 6)
  add(
    stripsTypes
      ? { code: 'node.version', status: 'pass', message: `Node ${process.versions.node} runs TypeScript sources natively${nodeMajor < 24 ? ' (supported from Node 24; this build still strips types)' : ''}` }
      : {
          code: 'node.version',
          status: 'fail',
          message: `Node ${process.versions.node} is too old: the Watcher's sources are TypeScript and need native type stripping (unflagged in 22.18; supported from Node 24)`,
          next: 'Install Node 24: https://nodejs.org/en/download (or `nvm install 24 && nvm use 24`).'
        }
  )

  // 2. .watcher exists
  if (existsSync(project.watcherDir)) {
    add({ code: 'watcher.dir', status: 'pass', message: `${project.watcherDir} exists` })
  } else {
    add({ code: 'watcher.dir', status: 'fail', message: `${project.watcherDir} does not exist`, next: 'Run `watcher init` in the project directory.' })
    return finish({ checks, target: opts.target, live: false })
  }

  // 3. config valid
  if (configRead.ok) {
    add({ code: 'config.valid', status: 'pass', message: `${project.configPath} passes the server's validator` })
  } else {
    add({ code: configRead.error.code, status: 'fail', message: configRead.error.message, next: configRead.error.next })
  }

  // 4. every referenced secret present (a missing credential-bound source is a named skip below).
  //    An OPTIONAL source's missing secret is that named skip, never this failure: it must not make `ok` false.
  const envNames = configRead.ok && config ? requiredSecretNames(config, raw ?? {}) : MANDATORY_SECRETS
  const missing = envNames.filter((name) => !process.env[name])
  if (missing.length === 0) {
    add({ code: 'env.present', status: 'pass', message: `all ${envNames.length} required environment variables are set` })
  } else {
    for (const name of missing) {
      const fatal = name !== 'WATCHER_MCP_TOKEN'
      add({
        code: name === 'WATCHER_MCP_TOKEN' ? 'env.mcp-token-missing' : 'env.missing',
        status: fatal ? 'fail' : 'warn',
        message: `${name} is not set`,
        next: fatal
          ? `Add it to .watcher/.env: printf '${name}=%s\\n' "$(openssl rand -hex 32)" >> .watcher/.env (or run \`watcher init\` to generate the three Watcher secrets).${mintedOnAdd(name, config) ? ' A heartbeat or webhook token is minted by `watcher add` when .watcher/.env has no value; `--replace` keeps that value and `--secret-value` sets your own.' : ''}`
          : `Add it to .watcher/.env: printf '${name}=%s\\n' "$(openssl rand -hex 32)" >> .watcher/.env (without it /mcp answers 401).`
      })
    }
  }

  // 5. the env file itself is git-ignored (a committed secret is a leaked secret)
  if (isGitWorkTree(project)) {
    if (gitCheckIgnored(project, '.watcher/.env')) {
      add({ code: 'env.not-ignored', status: 'pass', message: '.watcher/.env is git-ignored' })
    } else {
      add({
        code: 'env.not-ignored',
        status: 'fail',
        message: '.watcher/.env is not git-ignored, so a commit would publish every secret in it',
        next: `printf '.watcher/.env\\n.watcher/data/\\n' >> .gitignore && git check-ignore -v .watcher/.env`
      })
    }
  } else {
    add({ code: 'env.not-ignored', status: 'skip', message: 'not a git work tree, so there is nothing to ignore' })
  }

  // 6. data dir writable, at the resolved path (never a bare "/data")
  const data = withDataDir(project, config)
  try {
    mkdirSync(data.dataDir, { recursive: true })
    const probe = join(data.dataDir, `.write-test-${process.pid}`)
    writeFileSync(probe, 'ok', { mode: 0o600 })
    rmSync(probe, { force: true })
    add({ code: 'data.writable', status: 'pass', message: `${data.dataDir} is writable` })
  } catch (err) {
    add({
      code: 'data.unwritable',
      status: 'fail',
      message: `cannot write ${data.dataDir}: ${(err as Error).message}`,
      next: `mkdir -p "${data.dataDir}" && chmod u+rwx "${data.dataDir}" (or set WATCHER_DATA_DIR to a writable directory in .watcher/.env).`
    })
  }

  // 7. the port: free, or held by this Watcher, or held by something else
  const port = Number(process.env.WATCHER_PORT ?? config?.port ?? 7717)
  const host = process.env.WATCHER_HOST ?? config?.host ?? '127.0.0.1'
  const brand = config ? brandOf(config) : { name: 'EZO Watcher', shortName: 'Watcher' }
  const portState = await probePort(port, host === '0.0.0.0' ? '127.0.0.1' : host)
  if (portState.kind === 'free') {
    add({ code: 'port.free', status: 'pass', message: `${host}:${port} is free` })
  } else if (portState.kind === 'watcher' && (portState.instance as { brand?: { name?: string } })?.brand?.name === brand.name) {
    add({ code: 'server.up', status: 'pass', message: `${brand.name} is already answering on ${host}:${port}` })
  } else {
    add({
      code: 'port.in-use',
      status: 'fail',
      message: `${host}:${port} is taken by something that is not this ${brand.name}`,
      next: `Change WATCHER_PORT in .watcher/.env to a free port (and baseUrl in .watcher/config.json to match), or stop the process holding it: lsof -nP -iTCP:${port} -sTCP:LISTEN`
    })
  }

  // 8. channels
  if (!config || config.channels.length === 0) {
    add({
      code: 'channel.missing',
      status: 'warn',
      message: 'no channel is configured, so an incident reaches the wall and nobody else',
      next: 'watcher add channel ntfy --id ntfy --topic-env WATCHER_NTFY_TOPIC   (or webhook/email/sms/webpush/file)'
    })
  } else {
    add({ code: 'channels.configured', status: 'pass', message: `${config.channels.length} channel${config.channels.length === 1 ? '' : 's'} configured` })
  }

  // 9. a config hand-edited after `watcher add` wrote it: allowed, reported
  if (raw) {
    const meta = raw._meta as { writer?: unknown; sha256?: unknown } | undefined
    if (meta && meta.writer === 'watcher' && typeof meta.sha256 === 'string') {
      const actual = managedHash(raw)
      if (actual === meta.sha256) {
        add({ code: 'config.hand-edited', status: 'pass', message: 'the config still matches the sources and channels `watcher add` wrote' })
      } else {
        add({
          code: 'config.hand-edited',
          status: 'warn',
          message: 'the sources or channels changed since `watcher add` wrote them (hand edits are allowed, and this is only a report)',
          next: 'Nothing is broken; run `watcher doctor --live` to judge the edited config. `watcher add` will re-stamp _meta the next time it writes.'
        })
      }
    }
  }

  // 10. sources: self-probe, credential skips, provenance
  if (config) {
    const self = `${host}:${port}`
    for (const source of config.sources) {
      const s = source as unknown as Record<string, unknown>
      const urls: string[] = []
      if (typeof s.url === 'string') urls.push(s.url)
      if (Array.isArray(s.targets)) {
        for (const t of s.targets as Array<Record<string, unknown>>) if (typeof t.url === 'string') urls.push(t.url)
      }
      // The server's isSelfProbe knows about baseUrl and a tunnel name: it is the same judgement the
      // doctor report makes, so the two cannot disagree.
      const isSelf = (u: string): boolean => isSelfProbe(u, { port, host, ...(typeof config.baseUrl === 'string' ? { baseUrl: config.baseUrl } : {}) })
      const selfURL = urls.find(isSelf)
      if (selfURL) {
        add({
          code: 'source.self-probe',
          status: 'fail',
          message: `source ${source.id} probes the Watcher itself (${selfURL}), so its health is the Watcher's own`,
          next: `Point source ${source.id} at the app it should watch (watcher add http-probe --id ${source.id} --url <app-url> ...), not at ${self}.`
        })
      }
      const needed = Object.entries(s)
        .filter(([k, v]) => k.endsWith('Env') && typeof v === 'string' && v !== '' && k !== 'primaryEnv')
        .map(([k, v]) => ({ name: v as string, flag: k }))
        .filter(({ name }) => !process.env[name])
      for (const { name, flag } of needed) {
        const required = isRequiredSource(source)
        if (required) skippedRequired = true
        add({
          code: 'source.credential-skip',
          status: 'skip',
          message: `source ${source.id} needs ${name}, so the server will not poll it${required ? ' (required)' : ' (optional)'}`,
          next: required
            ? `printf '${name}=<value>\\n' >> .watcher/.env, then restart the server (watcher stop && watcher run --detach).`
            : `Add the line \`${name}=<value>\` to .watcher/.env and restart (watcher stop && watcher run --detach), or add it in one step: watcher add ${source.type} --id ${source.id} --optional --${kebabFlag(flag)} ${name} --secret-value <value>`
        })
      }
      const discovered = discoveredOf(source)
      if (isRequiredSource(source) && !discovered?.foundAt) {
        add({
          code: 'source.untraced',
          status: 'warn',
          message: `source ${source.id} does not say where it was found (discovered.foundAt)`,
          next: `In ${project.configPath}, add "discovered": {"foundAt": "<file:line>", "read": "<what the probe proves>"} to source ${source.id} (or re-add it with: watcher add ... --found-at <file:line> --read "<what the route proves>").`
        })
      } else if (discovered?.foundAt) {
        add({ code: 'source.untraced', status: 'pass', message: `source ${source.id} traces to ${discovered.foundAt}` })
        const [file] = discovered.foundAt.split(':')
        const path = urls.map((u) => {
          try {
            return new URL(u).pathname
          } catch {
            return ''
          }
        }).find((p) => p !== '' && p !== '/')
        const abs = file ? resolve(project.dir, file) : ''
        const fileText = abs && existsSync(abs) ? readFileSync(abs, 'utf8').slice(0, 512 * 1024) : null
        if (fileText === null || (path !== undefined && !fileText.includes(path))) {
          add({
            code: 'source.provenance-weak',
            status: 'warn',
            message: `source ${source.id}: ${discovered.foundAt} ${fileText === null ? 'does not exist' : `does not mention ${path}`}`,
            next: `Point discovered.foundAt at the file and line that shows this source really exists, or drop the claim.`
          })
        }
      }
    }
  }

  // 11. a built web bundle must not carry a source's host:port or a secret's NAME
  for (const leakCheck of await bundleLeakCheck(project, config, raw)) add(leakCheck)

  // 12. --live: read the running server, never start a source. --prove mutates the answers it recorded,
  // so --prove reads the server too: there is no second poll of a target to fall back on.
  const observations: LiveProbeObservation[] = []
  let sourcesLive = 0
  if (opts.live || opts.prove) {
    sourcesLive = await liveChecks({ project, config, raw, port, host, fetchImpl, add, observations })
  }

  // 13. --prove: mutate the last good answer (or the source's own reading) and require the evaluator to go red
  let proven = 0
  let proveFailed = 0
  if (opts.prove && config) {
    const proof = await proveChecks({ config, project, add, observations, nowMs: opts.now ? opts.now() : Date.now() })
    proven = proof.proven
    proveFailed = proof.failed
  }

  // 14. cloudflare's own checks, when asked for
  if (opts.target === 'cloudflare') {
    const { cloudflareDoctorChecks } = await import('./cloudflare.ts')
    checks.push(...(await cloudflareDoctorChecks({ project, hostname: opts.hostname, fetchImpl })))
  }

  // `live` means a SOURCE is live, not that the flag was passed: at least one source in state ok
  // with an evaluated assertion, and (with --prove) at least one assertion actually shown to go red.
  const live = opts.live && sourcesLive > 0 && (!opts.prove || (proven > 0 && proveFailed === 0))
  const result = finish({ checks, target: opts.target, live })
  if (skippedRequired) result.ok = false

  // The documented third verdict: a project with no server, no scheduled job and no host to watch. Only
  // the explicit flag confirms it (the scan proposes, the agent confirms), and only when the port is free.
  // A CONFIGURED source is never overridden: every kind can raise an incident, and a `host` reads this
  // very machine, which the scan cannot see. The flag then leaves a warn row naming what is watchable and
  // the report is judged like any other.
  const configured = config?.sources ?? []
  const scanSurface = opts.noRuntimeSurface ? scanSurfaceOf(project, opts.scanImpl) : null
  if (opts.noRuntimeSurface) {
    // A scan that throws is not a project with nothing to watch: name the failure, so "nothing found" and "not scanned"
    // never read the same (the verdict below still refuses to stand on an unknown).
    if (scanSurface !== null && !scanSurface.found) {
      add({
        code: 'doctor.scan-failed',
        status: 'warn',
        message: `the scan for a runtime surface failed (${scanSurface.error}), so --no-runtime-surface cannot tell "nothing found" from "not scanned"`,
        next: 'Run `watcher scan --json` to see the error; the no-runtime-surface verdict stays off until a scan runs.'
      })
    }
    if (configured.length > 0) {
      const listed = configured.slice(0, 3).map((s) => `${s.id} (${s.type})`)
      const named = `${listed.join(', ')}${configured.length > listed.length ? ` and ${configured.length - listed.length} more` : ''}`
      add({
        code: 'doctor.no-runtime-surface-ignored',
        status: 'warn',
        message: `${configured.length === 1 ? `source ${named} is` : `sources ${named} are`} configured and can go red, so --no-runtime-surface does not apply`,
        next: `Run \`watcher doctor --live --prove\` to prove ${configured.length === 1 ? `source ${configured[0].id}` : 'those sources'}, or drop --no-runtime-surface.`
      })
    } else if (scanSurface !== null && scanSurface.found) {
      const where = scanSurface.file === '' ? '' : ` at ${scanSurface.file}:${scanSurface.line}`
      add({
        code: 'doctor.no-runtime-surface-ignored',
        status: 'warn',
        message: `the scan finds evidence of a runtime surface (${scanSurface.kind})${where}, so --no-runtime-surface does not apply`,
        next: 'Add it as a source (`watcher scan --json` prints the `watcher add` command), or drop --no-runtime-surface.'
      })
    }
  }
  // The verdict stands only when the flag found nothing to watch: nothing configured, nothing the scan can
  // see, nothing on the port and no failing check.
  if (opts.noRuntimeSurface && configured.length === 0 && scanSurface === null && portState.kind === 'free' && !result.checks.some((c) => c.status === 'fail')) {
    return { ok: true, target: opts.target, checks, live: false, reason: 'no-runtime-surface' }
  }
  return result
}

function finish(input: { checks: Check[]; target: 'local' | 'cloudflare'; live: boolean }): DoctorResult {
  const ok = !input.checks.some((c) => c.status === 'fail')
  return { ok, target: input.target, checks: input.checks, live: input.live }
}

/**
 * The env-var names whose absence fails the report: the server's own secrets, every channel's, and every
 * REQUIRED source's. An optional source's missing secret is a `source.credential-skip` row instead, so an
 * optional, credential-bound source never turns `ok` false.
 */
function requiredSecretNames(config: WatchConfig, raw: Record<string, unknown>): string[] {
  const names = new Set<string>(MANDATORY_SECRETS)
  for (const name of configSecretNames(raw.channels ?? [], [])) names.add(name)
  for (const source of config.sources) {
    if (!isRequiredSource(source)) continue
    for (const name of configSecretNames(source, [])) names.add(name)
  }
  return [...names].sort()
}

/**
 * True when `name` is the token a heartbeat or webhook source reads. Only those are minted by `watcher add` when
 * .watcher/.env has no value, so only their `env.missing` row repeats the mint and its two flags.
 */
function mintedOnAdd(name: string, config: WatchConfig | null): boolean {
  if (!config) return false
  return config.sources.some((s) => {
    if (s.type === 'heartbeat') return s.tokenEnv === name
    if (s.type === 'webhook') return s.tokenEnv === name || s.verify?.secretEnv === name
    return false
  })
}

/** `tokenEnv` -> `token-env`: the `watcher add` flag that names the same config key. */
function kebabFlag(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** A scan signal that proves something runs (`found: true`, with where it was seen), a scan that threw (`found: false`), or nothing seen. */
type ScanSurface = { found: true; kind: string; file: string; line: number } | { found: false; error: string } | null

/**
 * What the scan sees running: an HTTP route, a schedule, an inbound webhook or an open port. A configured
 * source is checked by the caller first; this is the evidence that remains when the config names none.
 */
function scanSurfaceOf(project: Project, scan: typeof scanProject = scanProject): ScanSurface {
  try {
    const result = scan(project.dir, { maxFiles: 2000 })
    const signal = result.signals.find((s) => SURFACE_SIGNAL_KINDS.has(s.kind))
    if (!signal) return null
    const evidence = signal.evidence[0]
    return { found: true, kind: signal.kind, file: evidence ? evidence.file : '', line: evidence ? evidence.line : 0 }
  } catch (err) {
    // A scan that cannot run must not confirm there is nothing to watch, and must not read as "nothing found" either.
    return { found: false, error: (err as Error).message }
  }
}

// ---- live checks -------------------------------------------------------------------------------------

/** The shape GET /api/doctor answers (#49/#50): the server's own provenance checks and its last good probe answers. */
interface ServerDoctorReport {
  ok?: unknown
  checks?: unknown
  observations?: unknown
}

interface LiveProbeObservation {
  source: string
  target: string
  status: number
  headers: Record<string, string>
  bodyText: string | null
}

function parseDoctorReport(raw: unknown): { checks: Check[]; observations: LiveProbeObservation[] } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const report = raw as ServerDoctorReport
  if (!Array.isArray(report.checks)) return null
  const checks: Check[] = []
  for (const row of report.checks) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as { code?: unknown; status?: unknown; message?: unknown; next?: unknown }
    if (typeof r.code !== 'string' || typeof r.message !== 'string') continue
    if (r.status !== 'pass' && r.status !== 'fail' && r.status !== 'warn' && r.status !== 'skip') continue
    checks.push({ code: r.code, status: r.status, message: oneLine(r.message), ...(typeof r.next === 'string' ? { next: r.next } : {}) })
  }
  const observations: LiveProbeObservation[] = []
  if (Array.isArray(report.observations)) {
    for (const o of report.observations) {
      if (typeof o !== 'object' || o === null) continue
      const obs = o as { source?: unknown; target?: unknown; status?: unknown; headers?: unknown; bodyText?: unknown }
      if (typeof obs.source !== 'string' || typeof obs.target !== 'string' || typeof obs.status !== 'number') continue
      observations.push({
        source: obs.source,
        target: obs.target,
        status: obs.status,
        headers: typeof obs.headers === 'object' && obs.headers !== null ? (obs.headers as Record<string, string>) : {},
        bodyText: typeof obs.bodyText === 'string' ? obs.bodyText : null
      })
    }
  }
  return { checks, observations }
}

async function liveChecks(input: {
  project: Project
  config: WatchConfig | null
  raw: Record<string, unknown> | null
  port: number
  host: string
  fetchImpl: typeof fetch
  add: (c: Check) => void
  observations: LiveProbeObservation[]
}): Promise<number> {
  let sourcesLive = 0
  const { add, config, port, host, fetchImpl, observations } = input
  const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
  const token = process.env.WATCHER_ADMIN_TOKEN ?? ''
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}

  const health = await get(fetchImpl, `${base}/healthz`, headers)
  if (!health) {
    add({
      code: 'server.down',
      status: 'fail',
      message: `nothing answers on ${base}/healthz`,
      next: 'Start it: `watcher run --detach`, then `watcher status`.'
    })
    return 0
  }
  if (health.status !== 200) {
    add({ code: 'server.down', status: 'fail', message: `${base}/healthz answered HTTP ${health.status}`, next: 'Read .watcher/data/watcher.log: `tail -n 80 .watcher/data/watcher.log`.' })
    return 0
  }
  add({ code: 'server.healthz', status: 'pass', message: `${base}/healthz answered 200` })

  // The server's own provenance checks (GET /api/doctor): it knows the last good answers and the
  // source state, so the CLI must not start a second poller to find out. This CLI and that server ship
  // together and the route is always there: one that does not answer it is a server to restart, never
  // a server to work around with a weaker check from /api/state.
  const doctorAnswer = await get(fetchImpl, `${base}/api/doctor`, headers)
  if (!doctorAnswer || doctorAnswer.status === 401) {
    add({
      code: 'server.auth',
      status: 'fail',
      message: doctorAnswer ? `${base}/api/doctor answered 401` : `could not read ${base}/api/doctor`,
      next: "Set WATCHER_ADMIN_TOKEN in .watcher/.env to the server's value (watcher stop && watcher run --detach)."
    })
    return 0
  }
  if (doctorAnswer.status !== 200) {
    add({
      code: 'server.api',
      status: 'fail',
      message: `${base}/api/doctor answered HTTP ${doctorAnswer.status}`,
      next: 'Restart the server (watcher stop && watcher run --detach): this CLI and that server ship together and it must answer /api/doctor.'
    })
    return 0
  }
  let parsed: { checks: Check[]; observations: LiveProbeObservation[] } | null = null
  try {
    parsed = parseDoctorReport(JSON.parse(doctorAnswer.text) as unknown)
  } catch {
    parsed = null
  }
  if (!parsed) {
    add({ code: 'server.api', status: 'fail', message: `${base}/api/doctor did not answer the report shape`, next: 'Check .watcher/data/watcher.log.' })
    return 0
  }
  observations.push(...parsed.observations)
  for (const serverCheck of parsed.checks) add(serverCheck)

  const state = await get(fetchImpl, `${base}/api/state`, headers)
  if (!state || state.status === 401) {
    add({
      code: 'server.auth',
      status: 'fail',
      message: state ? `${base}/api/state answered 401` : `could not read ${base}/api/state`,
      next: "Set WATCHER_ADMIN_TOKEN in .watcher/.env to the server's value (watcher stop && watcher run --detach)."
    })
    return sourcesLive
  }
  if (state.status !== 200) {
    add({ code: 'server.api', status: 'fail', message: `${base}/api/state answered HTTP ${state.status}`, next: 'Check .watcher/data/watcher.log.' })
    return sourcesLive
  }
  let wall: { sources?: Array<Record<string, unknown>> } | null = null
  try {
    wall = JSON.parse(state.text) as { sources?: Array<Record<string, unknown>> }
  } catch {
    add({ code: 'server.api', status: 'fail', message: `${base}/api/state did not answer JSON`, next: 'Check .watcher/data/watcher.log.' })
    return sourcesLive
  }
  const byId = new Map((wall.sources ?? []).map((s) => [String(s.id), s]))
  for (const source of config?.sources ?? []) {
    // An optional source whose credential is absent is the static loop's named skip, not a live failure: the
    // server reports it as an error because it cannot poll it, and that is exactly the state the skip describes.
    const skipped = !isRequiredSource(source) && Object.entries(source as unknown as Record<string, unknown>).some(([k, v]) => k.endsWith('Env') && k !== 'primaryEnv' && typeof v === 'string' && v !== '' && !process.env[v])
    if (skipped) continue
    const status = byId.get(source.id)
    if (!status) {
      add({ code: 'source.unverified', status: 'fail', message: `source ${source.id} is in the config but the server does not report it`, next: 'Restart the server (watcher stop && watcher run --detach) and check its log.' })
      continue
    }
    const stateName = String(status.state ?? '')
    if (stateName === 'idle' || !status.lastAttempt) {
      add({ code: 'source.unverified', status: 'fail', message: `source ${source.id} has not been polled yet`, next: 'Wait one poll interval, then run `watcher doctor --live --prove` again (watch the log: tail -f .watcher/data/watcher.log).' })
      continue
    }
    if (stateName === 'error') {
      add({ code: 'source.error', status: 'fail', message: `source ${source.id} is erroring: ${oneLine(String(status.error ?? 'no detail'))}`, next: 'Fix what the error names (usually the URL or the credential), then `watcher doctor --live`.' })
      continue
    }
    if (stateName === 'stale') {
      add({ code: 'source.stale', status: 'fail', message: `source ${source.id} is stale: ${oneLine(String(status.error ?? `${status.misses} polls missed`))}`, next: 'Check the source itself first; if it is fine, raise staleAfterMisses in .watcher/config.json.' })
      continue
    }
    // SourceStatus.asserted counts the cells whose checks assert more than a nominal 200. A kind whose
    // cells carry no assertion (a Grafana rule, a webhook) has nothing to prove and is never bare; the
    // server's own /api/doctor rows name the bare ones, so the CLI does not repeat the finding.
    const asserted = !ASSERTION_KINDS.has(source.type) || Number(status.asserted ?? 0) > 0
    if (!asserted) continue
    add({ code: 'source.live', status: 'pass', message: `source ${source.id} is ${stateName} and has an evaluated assertion` })
    sourcesLive += 1
  }
  return sourcesLive
}

async function get(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<{ status: number; text: string } | null> {
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(2500), redirect: 'manual' })
    return { status: res.status, text: await res.text().catch(() => '') }
  } catch {
    return null
  }
}

// ---- the proof ---------------------------------------------------------------------------------------

async function proveChecks(input: {
  config: WatchConfig
  project: Project
  add: (c: Check) => void
  observations: LiveProbeObservation[]
  nowMs: number
}): Promise<{ proven: number; failed: number }> {
  const { config, add, observations, nowMs } = input
  const nowIso = new Date(nowMs).toISOString()
  let proven = 0
  let failed = 0
  const record = (source: { id: string; type: string }, outcome: { red: boolean; runs: Array<{ mutation?: unknown; ok?: unknown }> }, next: string): void => {
    if (outcome.red) {
      const run = Array.isArray(outcome.runs) ? outcome.runs.find((r) => r.ok === false) : undefined
      add({
        code: 'source.proven',
        status: 'pass',
        message: `source ${source.id} (${source.type}): ${typeof run?.mutation === 'string' ? run.mutation : 'a mutation'} turned its rule red`
      })
      proven += 1
      return
    }
    failed += 1
    add({
      code: 'source.assertion-not-red',
      status: 'fail',
      message: `source ${source.id} (${source.type}): its rule stayed green when its own reading was moved past the threshold`,
      next
    })
  }
  for (const source of config.sources) {
    switch (source.type) {
      case 'http-probe': {
        const s = source as unknown as Record<string, unknown>
        const targets = Array.isArray(s.targets) ? (s.targets as Array<Record<string, unknown>>) : []
        for (const target of targets) {
          const id = String(target.id ?? source.id)
          const expectJson = (target.expectJson ?? {}) as Record<string, unknown>
          // The last good answer the server recorded: the proof mutates it and never asks the target again.
          const observation = observations.find((o) => o.source === source.id && o.target === id) ?? null
          if (observation === null) {
            add({
              code: 'source.unverified',
              status: 'fail',
              message: `target ${id}: no good answer has been recorded yet, so nothing can be proved`,
              next: `Wait for one good poll of ${source.id} (it must answer HTTP ${Number(target.expectStatus ?? 200)}), then run \`watcher doctor --live --prove\` again.`
            })
            failed += 1
            continue
          }

          // A proof needs a body path to judge. A target that asserts only the status, or whose asserted
          // path the last good answer does not carry, proves that the endpoint answers, not that the app
          // works: that is vacuous (source.assertion-vacuous), and the server's own prover would otherwise
          // report a bare 200 as proven.
          let body: unknown
          try {
            body = JSON.parse(observation.bodyText ?? 'null') as unknown
          } catch {
            body = null
          }
          const predicates = Object.entries(expectJson).filter(([path]) => {
            const held = valueAt(body, path)
            return held !== undefined && held !== null
          })
          if (predicates.length === 0) {
            add({
              code: 'source.assertion-vacuous',
              status: 'fail',
              message:
                Object.keys(expectJson).length === 0
                  ? `target ${id}: the probe asserts only the HTTP status, so a mutation of the answer proves the endpoint answers, not that the app works`
                  : `target ${id}: no expected JSON path is present in the last good answer, so nothing the probe asserts can fail`,
              next: `Add a dependency-gated assertion: watcher add http-probe --id ${source.id} --url ${String(target.url)} --expect-json '{"<path>":"<value the app only reports when it works>"}'`
            })
            failed += 1
            continue
          }

          // The server's own proof: it mutates the recorded answer and judges with the same evaluateProbe
          // the poll uses, so the decision that turns a probe red is never a copy here.
          const outcome = proveProbe(target as unknown as HttpProbeTargetConfig, observation) as { red?: unknown; runs?: Array<{ mutation?: unknown; ok?: unknown }> }
          if (outcome.red === true) {
            const run = Array.isArray(outcome.runs) ? outcome.runs.find((r) => r.ok === false) : undefined
            add({ code: 'source.proven', status: 'pass', message: `target ${id}: ${typeof run?.mutation === 'string' ? run.mutation : 'a mutation'} turned an assertion red` })
            proven += 1
          } else {
            failed += 1
            add({
              code: 'source.assertion-not-red',
              status: 'fail',
              message: `target ${id}: a mutation of its last good answer left every assertion green`,
              next: `Assert a value the app computes when it works (a dependency's status, a queue depth), not a constant: watcher add http-probe --id ${source.id} --url ${String(target.url)} --expect-json '{"<path>":"<value>"}'`
            })
          }
        }
        continue
      }
      case 'heartbeat':
        record(source, proveHeartbeat(source as HeartbeatSourceConfig, nowMs), `Give the job a schedule and grace it can miss: watcher add heartbeat --id ${source.id} --every 5m --grace 2m (or --schedule "<cron>" --timezone <zone>).`)
        continue
      case 'host':
        record(source, proveHost(source as HostSourceConfig, nowIso), `Switch on at least one threshold: thresholds.diskFreePagePct above 0 (and under diskFreeWarnPct), or thresholds.memAvailableWarnPct above 0, or a --pid-file: watcher add host --id ${source.id}.`)
        continue
      case 'tcp-probe':
        record(source, proveTcpProbeSource(source as TcpProbeSourceConfig, nowIso), `Give the target a failure threshold it can reach: watcher add tcp-probe --id ${source.id} --host <host> --port <port> --fail-after 1.`)
        continue
      case 'domain-expiry':
        record(source, proveDomainExpirySource(source as DomainExpirySourceConfig, nowIso), `Give the source a page threshold and a domain: watcher add domain-expiry --id ${source.id} --domain <name> (pageDays defaults to 7).`)
        continue
      default: {
        const webhookStale = source.type === 'webhook' && typeof (source as unknown as Record<string, unknown>).staleAfterSec === 'number'
        add({
          code: 'source.prove-unsupported',
          status: 'skip',
          message: webhookStale
            ? `source ${source.id} (webhook): its alerts are pushed by the sender, and its stale window is the engine's own clock rule, not a pure evaluator --prove can mutate`
            : `source ${source.id} (${source.type}) has no evaluator here to mutate: its alerts are what its sender or its own service reports, so --prove cannot turn it red`,
          next: 'Nothing to do; --prove covers http-probe, heartbeat, host, tcp-probe and domain-expiry sources.'
        })
      }
    }
  }
  return { proven, failed }
}

/**
 * Prove a tcp-probe's ProbeDown by handing the same `normalizeTcpProbe` the poll uses a reading whose
 * connect failed `failAfter` times in a row. No socket is opened: the proof is the rule, not a second poll.
 */
function proveTcpProbeSource(cfg: TcpProbeSourceConfig, nowIso: string): { red: boolean; runs: Array<{ mutation: string; ok: boolean; failed: string[] }> } {
  const runs: Array<{ mutation: string; ok: boolean; failed: string[] }> = []
  for (const target of cfg.targets) {
    const fails = target.failAfter ?? TCP_PROBE_DEFAULTS.failAfter
    const reading: TcpTargetReading = {
      target,
      probe: {
        ok: false,
        ms: 0,
        detail: 'no connection: the proof refuses the connect',
        cert: target.tls === true ? { ok: false, detail: 'the proof refuses the connect' } : null
      },
      fails,
      slows: null
    }
    const obs = normalizeTcpProbe([reading], cfg, { nowIso, serviceMap: [] })
    const fired = obs.firing.some((a) => a.rule === PROBE_RULES.down && a.labels.instance === target.id)
    runs.push({ mutation: `${fails} failed connect${fails === 1 ? '' : 's'} in a row to ${target.host}:${target.port}`, ok: !fired, failed: [] })
  }
  return { red: runs.length > 0 && runs.every((run) => !run.ok), runs }
}

/**
 * Prove a domain-expiry's DomainExpiring by handing the same `normalizeDomainExpiry` the poll uses a
 * reading whose expiration falls inside `pageDays`. A page-threshold of 0 still pages on an expiry that
 * has already happened, so the proof uses an instant just past now in that case.
 */
function proveDomainExpirySource(cfg: DomainExpirySourceConfig, nowIso: string): { red: boolean; runs: Array<{ mutation: string; ok: boolean; failed: string[] }> } {
  const nowMs = Date.parse(nowIso)
  const pageDays = cfg.pageDays ?? DOMAIN_EXPIRY_DEFAULTS.pageDays
  const expiresAtMs = pageDays > 0 ? nowMs + pageDays * 86_400_000 - 1 : nowMs - 1
  const readings: DomainReading[] = cfg.domains.map((domain) => ({ domain, expiry: { ok: true, expiresAtMs } }))
  const obs = normalizeDomainExpiry(readings, cfg, { nowIso, serviceMap: [] })
  const fired = obs.firing.some((a) => a.rule === DOMAIN_RULES.expiring)
  const when = new Date(expiresAtMs).toISOString()
  const runs = [{ mutation: `${cfg.domains.length === 1 ? 'the domain' : 'every domain'} expires at ${when} (inside ${pageDays} days)`, ok: !fired, failed: [] }]
  return { red: fired, runs }
}

// ---- config leak in a built web bundle ---------------------------------------------------------------

async function bundleLeakCheck(project: Project, config: WatchConfig | null, raw: Record<string, unknown> | null): Promise<[Check]> {
  const webDir = process.env.WATCHER_WEB_DIR ?? join(packageRoot(), 'dist/web')
  if (!existsSync(webDir) || !config) {
    return [{ code: 'bundle.absent', status: 'skip', message: `no built web bundle at ${webDir}`, next: 'Build one when you need the wall: `npm run build` in the Watcher package.' }]
  }
  const needles = new Set<string>()
  for (const source of config.sources) {
    const s = source as unknown as Record<string, unknown>
    const urls = [s.url, ...(Array.isArray(s.targets) ? (s.targets as Array<Record<string, unknown>>).map((t) => t.url) : [])].filter((u): u is string => typeof u === 'string')
    for (const u of urls) {
      const hp = hostPortOf(u)
      if (hp !== null) needles.add(hp)
    }
  }
  for (const name of configSecretNames(raw ?? {}, [])) needles.add(name)
  if (needles.size === 0) return [{ code: 'bundle.clean', status: 'pass', message: 'the built web bundle is present and the config names nothing to leak' }]
  const hits: string[] = []
  for (const file of walkFiles(webDir, 300)) {
    if (!/\.(js|mjs|css|html|map|webmanifest|json|txt)$/.test(file)) continue
    let text: string
    try {
      if (statSync(file).size > 8 * 1024 * 1024) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const needle of needles) {
      if (text.includes(needle)) hits.push(`${relative(webDir, file)} carries ${needle}`)
    }
  }
  if (hits.length > 0) {
    return [{
      code: 'bundle.config-leak',
      status: 'fail',
      message: hits.slice(0, 5).join('; '),
      next: 'The web bundle must be config-free: rebuild it from a clean tree (`rm -rf dist/web && npm run build`), and check nothing imports the config into src/web.'
    }]
  }
  return [{ code: 'bundle.clean', status: 'pass', message: `checked the built web bundle for ${needles.size} config value${needles.size === 1 ? '' : 's'}: none appear` }]
}

function walkFiles(dir: string, limit: number): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    if (out.length >= limit) return
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      if (out.length >= limit) return
      const p = join(d, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p)
      else if (st.isFile()) out.push(p)
    }
  }
  walk(dir)
  return out
}

// ---- the verb ----------------------------------------------------------------------------------------

export async function runDoctorCommand(args: ParsedArgs, out: Output): Promise<number> {
  const project = resolveProject(args.dir)
  const target = (args.values.get('target')?.[0] ?? 'local') as 'local' | 'cloudflare'
  if (target !== 'local' && target !== 'cloudflare') {
    throw new CliError('usage.bad-target', `--target must be local or cloudflare, not ${JSON.stringify(target)}`, { exitCode: 64, next: 'Run `watcher doctor --target cloudflare` to verify the tunnel.' })
  }
  if (args.dryRun) {
    // doctor only reads; --dry-run is accepted and means "do not touch the network for --prove"
    out.note('doctor is read-only; --dry-run takes no proof.')
  }
  const result = await runDoctor({
    project,
    live: args.switches.get('live') === true,
    prove: args.switches.get('prove') === true && args.dryRun !== true,
    noRuntimeSurface: args.switches.get('no-runtime-surface') === true,
    target,
    hostname: args.values.get('hostname')?.[0]
  })
  out.json(result)
  if (result.reason === 'no-runtime-surface') {
    out.line(out.warn('no runtime surface: this project has no server, no scheduled job and no host to watch'))
    out.line('  live: false, reason: no-runtime-surface (documented third verdict; exit 0)')
    return 0
  }
  const failed = result.checks.filter((c) => c.status === 'fail')
  const warned = result.checks.filter((c) => c.status === 'warn')
  const skipped = result.checks.filter((c) => c.status === 'skip')
  out.md(`# doctor: ${target} (${result.ok ? 'ok' : 'not ok'}, live=${String(result.live)})`)
  out.md('')
  for (const c of result.checks) {
    out.md(`- **${c.status.toUpperCase()}** \`${c.code}\`: ${c.message}${c.next && c.status !== 'pass' ? `  \n  next: ${c.next}` : ''}`)
  }
  out.line(`${out.bold('doctor')} target=${target} ${result.ok ? out.ok('ok') : out.bad('not ok')} live=${String(result.live)}`)
  out.line(`${result.checks.length} checks, ${failed.length} failed, ${warned.length} warnings, ${skipped.length} skipped`)
  out.line('')
  for (const c of result.checks) {
    const mark = c.status === 'pass' ? out.ok('PASS') : c.status === 'fail' ? out.bad('FAIL') : c.status === 'warn' ? out.warn('WARN') : out.dim('SKIP')
    out.line(`${mark}  ${c.code}`)
    out.line(`      ${c.message}`)
    if (c.next && c.status !== 'pass') out.line(`      next: ${c.next}`)
  }
  return result.ok ? 0 : 1
}
