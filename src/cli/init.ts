// `watcher init`: make a project watchable. Idempotent by construction: every write is checked
// first, so a second run keeps the secrets, the config and the port it finds and says what already
// existed. There is no prompt and no TTY check: an agent runs this, and so does a person.
//
// What it writes (and what it deliberately does not):
//   .watcher/config.json  brand + zero sources + no channel (the notes allow a self channel or none;
//                         none is honest: init has no URL to notify, `watcher add channel` supplies one)
//   .watcher/.env         generated secrets + host/port/config/data paths, mode 0600
//   .watcher/.env.example every name, no value, committed
//   .watcher/.gitignore   `.env` and `data/`
//   <project>/.gitignore  `.watcher/.env` and `.watcher/data/`, appended, then verified with git
//                         check-ignore when the project is a git work tree
// The port is 7717 (or WATCHER_PORT, or --port) when it is free, else the next free one; the chosen
// port goes into baseUrl and .env so `run`, `status` and `doctor` all read the same number.

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ParsedArgs } from './util.ts'
import { CliError, flagValue, numberFlag, runProcess } from './util.ts'
import type { Output } from './output.ts'
import {
  cliVersion,
  configSecretNames,
  ensureGitignored,
  findFreePort,
  gitCheckIgnored,
  isGitWorkTree,
  newSecret,
  packageRoot,
  portIsFree,
  readConfig,
  readEnvVars,
  resolveProject,
  withDataDir,
  writeConfig,
  writeEnvExample,
  writeEnvVars,
  writeFileAtomic
} from './project.ts'
import { runDoctor } from './doctor.ts'
import { loadProjectEnv } from './run.ts'

export const INIT_SPEC = {
  valueFlags: ['dir', 'output', 'port', 'host', 'brand', 'short-name'],
  switchFlags: ['dry-run', 'help']
} as const

const DEFAULT_PORT = 7717

/** The seed config: a brand, no sources, no channels, no routes. `validateConfig` accepts it as written. */
export function seedConfig(brand: { name: string; shortName: string }, port: number, configPathLabel: string): Record<string, unknown> {
  return {
    brand,
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir: configPathLabel,
    historyHours: 24,
    staleAfterMisses: 3,
    sources: [],
    serviceMap: [],
    channels: [],
    routes: [],
    quietHours: null
  }
}

export async function runInit(args: ParsedArgs, out: Output): Promise<number> {
  const project = resolveProject(args.dir)
  const host = flagValue(args, 'host') ?? '127.0.0.1'
  const requestedPort = numberFlag(args, 'port', { min: 1, max: 65535 })
  const brandName = flagValue(args, 'brand')?.trim() || 'EZO Watcher'
  const brandShort = flagValue(args, 'short-name')?.trim() || (brandName === 'EZO Watcher' ? 'Watcher' : brandName)

  // Where the port comes from, in order: --port, the port this project already wrote, WATCHER_PORT,
  // then 7717. A chosen port that is taken moves to the next free one (and says so).
  const existingEnv = readEnvVars(project.envPath)
  const existingConfig = readConfig(project)
  const configExisted = existsSync(project.configPath)
  const configuredPort = existingConfig.ok ? existingConfig.config.port : undefined
  const portText = existingEnv.get('WATCHER_PORT') ?? process.env.WATCHER_PORT ?? (configuredPort !== undefined ? String(configuredPort) : '')
  const envPort = requestedPort ?? Number(portText)
  const start = Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 ? envPort : DEFAULT_PORT
  let port = start
  let moved = false
  if (!(await portIsFree(start, host))) {
    const pick = await findFreePort(start, host)
    port = pick.port
    moved = true
  }

  const seed = seedConfig({ name: brandName, shortName: brandShort }, port, '.watcher/data')
  const keptConfig = existingConfig.ok
  const wrote: string[] = []
  const kept: string[] = []

  // ---- config
  if (!configExisted) {
    if (args.dryRun) {
      wrote.push(project.configPath)
    } else {
      const written = writeConfig(project, seed)
      if (!written.ok) throw new CliError(written.error.code, written.error.message, { next: written.error.next })
      wrote.push(project.configPath)
    }
  } else {
    kept.push(project.configPath)
  }

  // A config that exists keeps its own port unless --port overrides it. The .env port and the
  // config's baseUrl are one number; init never leaves them disagreeing.
  const effectivePort = keptConfig && requestedPort === undefined && existingEnv.has('WATCHER_PORT') ? Number(existingEnv.get('WATCHER_PORT')) : port
  const finalPort = Number.isInteger(effectivePort) && effectivePort > 0 ? effectivePort : port

  // ---- .env (secrets are generated once and never rotated by a re-run)
  const envUpdates: Record<string, string> = {}
  const generated: string[] = []
  for (const name of ['WATCHER_ACK_SECRET', 'WATCHER_ADMIN_TOKEN', 'WATCHER_MCP_TOKEN']) {
    if (!existingEnv.has(name) || existingEnv.get(name) === '') {
      envUpdates[name] = newSecret()
      generated.push(name)
    }
  }
  for (const [name, value] of [
    ['WATCHER_HOST', existingEnv.get('WATCHER_HOST') ?? host],
    ['WATCHER_PORT', String(existingEnv.has('WATCHER_PORT') && requestedPort === undefined ? existingEnv.get('WATCHER_PORT') : finalPort)],
    ['WATCHER_CONFIG', '.watcher/config.json'],
    ['WATCHER_DATA_DIR', '.watcher/data']
  ] as const) {
    if (!existingEnv.has(name) || existingEnv.get(name) === '') envUpdates[name] = value
  }
  if (!args.dryRun) {
    writeEnvVars(project.envPath, envUpdates)
    writeEnvExample(project.envExamplePath, [...readEnvVars(project.envPath).keys(), ...(existingConfig.ok ? configSecretNames(existingConfig.raw) : [])])
    // The doctor summary below reads process.env: make this run see the secrets it just generated.
    loadProjectEnv(project.envPath)
    wrote.push(project.envPath, project.envExamplePath)
  } else {
    wrote.push(project.envPath, project.envExamplePath)
  }

  // ---- .watcher/.gitignore and the project's .gitignore
  const watcherIgnore = join(project.watcherDir, '.gitignore')
  if (!args.dryRun) {
    mkdirSync(project.watcherDir, { recursive: true })
    writeFileAtomic(watcherIgnore, '.env\ndata/\n', 0o644)
    const projectIgnore = ensureGitignored(project, ['.watcher/.env', '.watcher/data/'])
    wrote.push(watcherIgnore, projectIgnore.path)
  }
  if (!args.dryRun) mkdirSync(withDataDir(project, null).dataDir, { recursive: true })

  // ---- verify with git when this is a git project
  const git = isGitWorkTree(project)
  let ignoreVerified: boolean | null = null
  if (git && !args.dryRun) {
    const envIgnored = gitCheckIgnored(project, '.watcher/.env') || gitCheckIgnored(project, '.watcher/data')
    ignoreVerified = gitCheckIgnored(project, '.watcher/.env') && gitCheckIgnored(project, '.watcher/data')
    if (!envIgnored) ignoreVerified = false
  }

  // ---- the doctor summary: the same static checks `watcher doctor` runs, rendered compactly
  const doctor = args.dryRun
    ? emptyDoctor()
    : await runDoctor({ project, live: false, prove: false, noRuntimeSurface: false, target: 'local' })
  const ok = doctor.ok && (ignoreVerified !== false)

  const result = {
    ok,
    dryRun: args.dryRun,
    port: finalPort,
    host,
    wrote: [...new Set(wrote)],
    kept,
    generated,
    ...(moved ? { portMoved: true } : {}),
    ...(ignoreVerified === null ? {} : { envGitIgnored: ignoreVerified }),
    doctor
  }
  out.json(result)

  out.md(`# EZO Watcher initialised (v${cliVersion()})`)
  out.md('')
  out.md(`- project: ${project.dir}`)
  out.md(`- port: ${finalPort}${moved ? ` (${start} was taken, moved to the next free port)` : ''}`)
  out.md(`- config: ${configExisted ? 'kept the existing .watcher/config.json' : 'wrote a seed config: zero sources, no channel yet'}`)
  for (const name of generated) out.md(`- generated ${name} into .watcher/.env (0600)`)
  if (git) out.md(`- .watcher/.env and .watcher/data/ are ${ignoreVerified ? '' : 'NOT '}git-ignored`)
  out.md('')
  out.md('## doctor')
  out.md('')
  for (const c of doctor.checks) {
    if (c.status === 'pass') continue
    out.md(`- **${c.status.toUpperCase()}** \`${c.code}\`: ${c.message}${c.next ? `  \n  next: ${c.next}` : ''}`)
  }
  out.md('')
  out.md('Next: `watcher add http-probe --id api --url https://api.example.com/healthz --expect-json \'{"status":"ok"}\'`, then `watcher run --detach` and `watcher doctor --live`.')
  out.line(`${out.bold('EZO Watcher initialised')} ${out.dim(`(v${cliVersion()})`)}`)
  out.line(`project  ${project.dir}`)
  out.line(`port     ${finalPort}${moved ? out.warn(` (${start} was taken, moved to the next free port)`) : ''}`)
  out.line(`config   ${configExisted ? 'kept the existing .watcher/config.json' : 'wrote a seed config: zero sources, no channel yet'}`)
  for (const name of generated) out.line(`secret   generated ${name} into .watcher/.env (0600)`)
  if (kept.includes(project.configPath)) out.line(`kept     ${project.configPath}`)
  if (git) out.line(`ignore   ${ignoreVerified ? out.ok('.watcher/.env and .watcher/data/ are git-ignored') : out.bad('.watcher/.env is NOT git-ignored (see doctor)')}`)
  out.line('')
  printDoctorSummary(out, doctor)
  out.line('')
  out.line(`next     ${out.bold('watcher add http-probe --id api --url https://api.example.com/healthz --expect-json \'{"status":"ok"}\'')}`)
  out.line('         then `watcher run --detach` and `watcher doctor --live`')
  if (doctor.ok && ignoreVerified !== false) return 0
  return 1
}

function emptyDoctor(): { ok: boolean; target: 'local'; checks: never[]; live: boolean } {
  return { ok: true, target: 'local', checks: [], live: false }
}

export function printDoctorSummary(out: Output, doctor: { ok: boolean; checks: Array<{ code: string; status: string; message: string; next?: string }> }): void {
  const fail = doctor.checks.filter((c) => c.status === 'fail').length
  const warn = doctor.checks.filter((c) => c.status === 'warn').length
  const skip = doctor.checks.filter((c) => c.status === 'skip').length
  out.line(doctor.ok ? out.ok(`doctor: ${doctor.checks.length} checks, no failures${warn ? `, ${warn} warnings` : ''}${skip ? `, ${skip} skips` : ''}`) : out.bad(`doctor: ${fail} failure${fail === 1 ? '' : 's'}${warn ? `, ${warn} warnings` : ''}`))
  for (const c of doctor.checks) {
    if (c.status === 'pass') continue
    const mark = c.status === 'fail' ? out.bad('FAIL') : c.status === 'warn' ? out.warn('WARN') : out.dim('SKIP')
    out.line(`  ${mark} ${c.code}: ${c.message}`)
    if (c.next) out.line(`       next: ${c.next}`)
  }
}

/** The directory a project keeps its state in, for the help text. */
export function watcherStateDirLabel(): string {
  return join(packageRoot(), '.watcher')
}

/** A one-line check used by the tests: the seed config is what init wrote. */
export function seedExists(path: string): boolean {
  return existsSync(path)
}

export { runProcess }
