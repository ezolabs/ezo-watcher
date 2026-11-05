// `watcher run` and `watcher stop`.
//
// `run` loads `.watcher/.env` with process.loadEnvFile BEFORE the server module is imported (the
// server reads process.env only: there is no .env loader in src/server/main.ts), changes cwd to the
// project, and then imports the server: dist/server/main.mjs in an installed package (the CLI there is
// the bundle beside it), src/server/main.ts under native type stripping in a checkout without a build.
// When the web bundle is missing it is built once (vite) and the fact is said out loud, so a fresh
// clone serves the wall instead of `app not built`.
//
// `--detach` starts the same command as a child with its own session, writes `.watcher/data/watcher.pid`
// and appends to `.watcher/data/watcher.log`; `stop` sends SIGTERM to that pid and waits for it.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ParsedArgs } from './util.ts'
import { CliError, flagValue, numberFlag, runProcess, sleep } from './util.ts'
import type { Output } from './output.ts'
import {
  packageRoot,
  probePort,
  readConfig,
  resolveProject,
  waitForHttp,
  withDataDir,
  watcherUrl
} from './project.ts'

export const RUN_SPEC = {
  valueFlags: ['dir', 'output', 'port', 'host'],
  switchFlags: ['detach', 'help']
} as const

export const STOP_SPEC = {
  valueFlags: ['dir', 'output'],
  switchFlags: ['help']
} as const

/** The server source a checkout imports; the esbuild bundle in dist/server is what an installed package (and Docker) runs. */
export const SERVER_ENTRY = 'src/server/main.ts'

/**
 * The server module `watcher run` imports. A bundled CLI (dist/cli/main.mjs) imports dist/server/main.mjs
 * beside it, so an installed package never type-strips anything under node_modules; a checkout running
 * src/cli/run.ts imports src/server/main.ts as it always has. `import.meta.url` names the file this
 * module actually is, which is the one reliable difference between the two layouts.
 */
export function serverEntryPath(root = packageRoot()): string {
  if (import.meta.url.endsWith('.ts')) return join(root, 'src', 'server', 'main.ts')
  return join(root, 'dist', 'server', 'main.mjs')
}

/**
 * Load `.watcher/.env` into process.env without overriding what the caller already exported.
 * `process.loadEnvFile` has exactly that precedence, checked on this host (Node 26).
 */
export function loadProjectEnv(envPath: string): boolean {
  if (!existsSync(envPath)) return false
  process.loadEnvFile(envPath)
  return true
}

/**
 * The web bundle the server serves. A missing bundle is not fatal (the API still answers), but the
 * wall would read "app not built"; build it once, in the package directory, and say so.
 */
export async function ensureWebAssets(out: Output): Promise<{ status: 'present' | 'built' | 'failed'; dir: string; detail?: string }> {
  const dir = process.env.WATCHER_WEB_DIR ?? join(packageRoot(), 'dist/web')
  if (existsSync(join(dir, 'index.html'))) return { status: 'present', dir }
  const vite = join(packageRoot(), 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(vite)) {
    return {
      status: 'failed',
      dir,
      detail: `no web bundle at ${dir} and no vite at ${vite}; reinstall the package, or in a checkout run \`npm install && npm run build\` in ${packageRoot()}`
    }
  }
  out.note(`web bundle missing at ${dir}: building it once with vite (this is the only build \`watcher run\` does)`)
  const r = runProcess(process.execPath, [vite, 'build'], { cwd: packageRoot(), timeoutMs: 300_000 })
  if (r.status !== 0 || !existsSync(join(dir, 'index.html'))) {
    return { status: 'failed', dir, detail: `${r.stderr.slice(-1200) || r.stdout.slice(-1200) || `vite exited ${r.status}`}` }
  }
  return { status: 'built', dir }
}

export async function runRun(args: ParsedArgs, out: Output): Promise<number> {
  const project = resolveProject(args.dir)
  const loaded = loadProjectEnv(project.envPath)
  if (!loaded) {
    throw new CliError('run.no-env', `${project.envPath} does not exist`, { next: 'Run `watcher init` first: it writes .watcher/.env with the generated secrets.' })
  }
  if (!process.env.WATCHER_ACK_SECRET) {
    throw new CliError('run.missing-secret', 'WATCHER_ACK_SECRET is not set, and the server refuses to start without it', {
      next: `Add it to .watcher/.env: printf 'WATCHER_ACK_SECRET=%s\\n' "$(openssl rand -hex 32)" >> .watcher/.env (or re-run \`watcher init\`).`
    })
  }
  const configRead = readConfig(project)
  if (!configRead.ok) throw new CliError(configRead.error.code, configRead.error.message, { next: configRead.error.next })
  const config = configRead.config
  const data = withDataDir(project, config)
  const port = numberFlag(args, 'port', { min: 1, max: 65535 }) ?? Number(process.env.WATCHER_PORT ?? config.port ?? 7717)
  const host = flagValue(args, 'host') ?? process.env.WATCHER_HOST ?? config.host ?? '127.0.0.1'
  process.env.WATCHER_PORT = String(port)
  process.env.WATCHER_HOST = host
  process.env.WATCHER_CONFIG = project.configPath
  process.env.WATCHER_DATA_DIR = data.dataDir

  const web = await ensureWebAssets(out)
  if (web.status === 'failed') {
    out.note(`web bundle not built: ${web.detail}; the API still works and the wall answers "app not built"`)
  }
  process.env.WATCHER_WEB_DIR = web.dir
  mkdirSync(data.dataDir, { recursive: true })

  const running = await probePort(port, host === '0.0.0.0' ? '127.0.0.1' : host)
  if (running.kind === 'watcher') {
    throw new CliError('run.already-running', `${watcherUrl(host, port)} is already answering`, {
      next: 'Use `watcher status` to read it, or `watcher stop` and run again.'
    })
  }
  if (running.kind === 'other') {
    throw new CliError('port.in-use', `${host}:${port} is held by something that is not this Watcher`, {
      next: `Change WATCHER_PORT in .watcher/.env, or stop the process: lsof -nP -iTCP:${port} -sTCP:LISTEN`
    })
  }

  const bin = join(packageRoot(), 'bin', 'watcher.mjs')
  if (args.switches.get('detach') === true) {
    mkdirSync(data.dataDir, { recursive: true })
    const log = openSync(data.logPath, 'a')
    const child = spawn(process.execPath, [bin, 'run', '--dir', project.dir, '--port', String(port), '--host', host], {
      cwd: project.dir,
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env }
    })
    child.unref()
    closeSync(log)
    if (!child.pid) throw new CliError('run.spawn-failed', 'the detached server did not start', { next: `Read ${data.logPath}.` })
    writeFileSync(data.pidPath, `${child.pid}\n`, { mode: 0o600 })
    const connectHost = host === '0.0.0.0' ? '127.0.0.1' : host
    const health = await waitForHttp(`${watcherUrl(connectHost, port)}/healthz`, 15_000)
    if (health !== 200) {
      throw new CliError('run.not-up', `the detached server (pid ${child.pid}) did not answer /healthz within 15 s`, {
        next: `Read the log: tail -n 80 ${data.logPath}`
      })
    }
    const result = { ok: true, detached: true, pid: child.pid, url: watcherUrl(host, port), log: data.logPath, pidFile: data.pidPath, web: web.status }
    out.json(result)
    out.line(`${out.ok('running')} ${watcherUrl(host, port)} (pid ${child.pid}, detached)`)
    out.line(`log      ${data.logPath}`)
    out.line(`next     watcher status`)
    return 0
  }

  // Foreground: become the server. cwd moves to the project because the server resolves the config
  // and the data dir against it; nothing in this process needs the old cwd after the import.
  const entry = serverEntryPath()
  if (!existsSync(entry)) {
    throw new CliError('run.no-server', `the server module is missing at ${entry}`, {
      next: 'Reinstall the package, or run `npm run build` in a checkout that has no dist/.'
    })
  }
  process.chdir(project.dir)
  out.note(`starting ${watcherUrl(host, port)} in ${project.dir} (Ctrl-C to stop)`)
  await import(pathToFileURL(entry).href)
  return 0
}

export async function runStop(args: ParsedArgs, out: Output): Promise<number> {
  const project = resolveProject(args.dir)
  const data = withDataDir(project, null)
  if (!existsSync(data.pidPath)) {
    // No pid file: maybe it was started in the foreground elsewhere. Report honestly.
    const port = Number(process.env.WATCHER_PORT ?? 7717)
    const state = await probePort(port)
    if (state.kind === 'watcher') {
      throw new CliError('stop.no-pid', `a Watcher answers on ${port} but there is no pid file at ${data.pidPath}`, {
        next: 'Stop the foreground process with Ctrl-C, or find it: lsof -nP -iTCP:' + port + ' -sTCP:LISTEN'
      })
    }
    out.json({ ok: true, stopped: false, reason: 'not-running' })
    out.line(out.dim('not running (no pid file)'))
    return 0
  }
  const raw = readFileSync(data.pidPath, 'utf8').trim()
  const pid = Number(raw)
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new CliError('stop.bad-pid', `${data.pidPath} does not hold a pid (${JSON.stringify(raw)})`, { next: `Delete ${data.pidPath} and start again with \`watcher run --detach\`.` })
  }
  // Only ESRCH says a process is gone. EPERM (a process another user owns) means it is there and
  // un-signallable by us, so it must not be mistaken for a stale pid file: the file stays, and the
  // stop is reported denied with exit 1 instead of a false `stopped`.
  const probe = killQuietly(pid, 0)
  if (!probe.ok && probe.code === 'ESRCH') {
    out.json({ ok: true, stopped: false, pid, reason: 'stale-pid' })
    out.line(out.dim(`pid ${pid} was already gone; removed the stale pid file`))
    rmSync(data.pidPath, { force: true })
    return 0
  }
  // A pid is only a number after a reboot: verify the process is actually this Watcher before signalling it, or `stop` could kill
  // whatever the OS handed the recycled pid to. `ps` names the command line; an unreadable one (another user's, a platform with no
  // ps) is treated as unverified rather than a refusal.
  const mine = watcherCommandOf(pid)
  if (mine === false) {
    throw new CliError('stop.not-watcher', `pid ${pid} is running, but its command line is not a Watcher: the pid was reused`, {
      next: `Delete ${data.pidPath} if this Watcher is gone, or find the one that answers: lsof -nP -iTCP:${Number(process.env.WATCHER_PORT ?? 7717)} -sTCP:LISTEN`
    })
  }
  const term = killQuietly(pid, 'SIGTERM')
  if (!term.ok) {
    if (term.code === 'ESRCH') {
      out.json({ ok: true, stopped: false, pid, reason: 'stale-pid' })
      out.line(out.dim(`pid ${pid} exited before SIGTERM; removed the stale pid file`))
      rmSync(data.pidPath, { force: true })
      return 0
    }
    throw new CliError('stop.denied', `pid ${pid} is running but cannot be signalled${term.code ? ` (${term.code})` : ''}`, {
      exitCode: 1,
      next: `Run the stop as the user that owns the process, or end it yourself: kill ${pid}   (the pid file was kept at ${data.pidPath}).`
    })
  }
  let alive = true
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const now = killQuietly(pid, 0)
    if (!now.ok && now.code === 'ESRCH') {
      alive = false
      break
    }
    await sleep(150)
  }
  if (alive) {
    const hard = killQuietly(pid, 'SIGKILL')
    if (!hard.ok && hard.code !== 'ESRCH') {
      throw new CliError('stop.denied', `pid ${pid} did not stop and cannot be killed${hard.code ? ` (${hard.code})` : ''}`, {
        exitCode: 1,
        next: `Run the stop as the user that owns the process, or end it yourself: kill -9 ${pid}   (the pid file was kept at ${data.pidPath}).`
      })
    }
    out.note(`pid ${pid} did not stop on SIGTERM within 8 s; sent SIGKILL`)
  }
  rmSync(data.pidPath, { force: true })
  out.json({ ok: true, stopped: true, pid })
  out.line(`${out.ok('stopped')} pid ${pid}`)
  return 0
}

/** True/false when `ps` could say whether this pid runs a Watcher, null when it could not be read. */
export function watcherCommandOf(pid: number): boolean | null {
  const r = runProcess('ps', ['-p', String(pid), '-o', 'command='], { timeoutMs: 5000 })
  const command = r.stdout.trim()
  if (r.status !== 0 || command === '') return null
  return command.includes('watcher.mjs') || command.includes('ezo-watcher') || command.includes('dist/cli/main.mjs')
}

/** A signal, with the errno code back instead of a throw: the caller decides what each code means. */
function killQuietly(pid: number, signal: NodeJS.Signals | 0): { ok: true } | { ok: false; code: string } {
  try {
    process.kill(pid, signal)
    return { ok: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { ok: false, code: typeof code === 'string' ? code : 'unknown' }
  }
}
