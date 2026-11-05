// `watcher service install|uninstall`: run the Watcher as a per-user service.
//
// macOS: a launchd agent in ~/Library/LaunchAgents running `watcher run` in the project directory
// (RunAtLoad + KeepAlive), optional second agent for cloudflared when the tunnel token exists.
// Linux: a systemd --user unit with Restart=always.
//
// The plist/unit carries no secret. `watcher run` loads .watcher/.env itself, and the cloudflared
// agent reads the token from a 0600 file inside .watcher/data, so neither file outside the project
// holds one. Tests point HOME at a temp directory: every path this module writes is under $HOME.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ParsedArgs } from './util.ts'
import { CliError, commandOnPath, runProcess, slugify } from './util.ts'
import type { Output } from './output.ts'
import { packageRoot, readConfig, resolveProject, withDataDir, writeFileAtomic } from './project.ts'

export const SERVICE_SPEC = {
  valueFlags: ['dir', 'output'],
  switchFlags: ['help', 'with-tunnel', 'dry-run', 'force', 'no-load'],
  subVerbs: ['install', 'uninstall']
} as const

export interface ServiceFiles {
  platform: 'darwin' | 'linux'
  /** The service's stable label/basename. */
  name: string
  /** Absolute path of the plist or unit file. */
  path: string
  content: string
}

/** A stable per-project service name: readable slug + 8 hex of the absolute path. */
export function serviceName(projectDir: string): string {
  const hash = createHash('sha256').update(projectDir).digest('hex').slice(0, 8)
  return `watcher-${slugify(basename(projectDir), 'project')}-${hash}`
}

function labelOf(name: string): string {
  return `dev.ezolabs.${name}`
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * One systemd ExecStart/WorkingDirectory argument. systemd splits an unquoted line on whitespace, so a path with a space
 * ("Application Support" on macOS, any Windows-imported project) must be quoted; `%` is systemd's specifier introducer and is
 * doubled to stay literal. A path with no space, quote or backslash is left as-is so the unit stays readable.
 */
export function systemdArg(value: string): string {
  const escaped = value.replace(/%/g, '%%')
  if (escaped !== '' && !/[\s"'\\]/.test(escaped)) return escaped
  return `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The launchd plist for `watcher run` in this project. */
export function launchdPlist(input: { label: string; projectDir: string; node: string; bin: string; logPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.node)}</string>
    <string>${xml(input.bin)}</string>
    <string>run</string>
    <string>--dir</string>
    <string>${xml(input.projectDir)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(input.projectDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(input.logPath)}</string>
</dict>
</plist>
`
}

/** The launchd plist for cloudflared, reading the token from a 0600 file in the project. */
export function launchdTunnelPlist(input: { label: string; projectDir: string; cloudflared: string; tokenFile: string; logPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.cloudflared)}</string>
    <string>tunnel</string>
    <string>--no-autoupdate</string>
    <string>run</string>
    <string>--token-file</string>
    <string>${xml(input.tokenFile)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(input.projectDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(input.logPath)}</string>
</dict>
</plist>
`
}

/** The systemd --user unit for `watcher run` in this project. */
export function systemdUnit(input: { projectDir: string; node: string; bin: string }): string {
  return `[Unit]
Description=EZO Watcher for ${input.projectDir}
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdArg(input.projectDir)}
ExecStart=${systemdArg(input.node)} ${systemdArg(input.bin)} run --dir ${systemdArg(input.projectDir)}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
}

/** The systemd --user unit for cloudflared. */
export function systemdTunnelUnit(input: { projectDir: string; cloudflared: string; tokenFile: string }): string {
  return `[Unit]
Description=EZO Watcher Cloudflare tunnel for ${input.projectDir}
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdArg(input.projectDir)}
ExecStart=${systemdArg(input.cloudflared)} tunnel --no-autoupdate run --token-file ${systemdArg(input.tokenFile)}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
}

/** Where the files go, from HOME (tests set HOME to a temp directory). */
export function servicePaths(home: string, name: string): { dir: string; path: string } {
  if (process.platform === 'darwin') {
    const dir = join(home, 'Library', 'LaunchAgents')
    return { dir, path: join(dir, `${labelOf(name)}.plist`) }
  }
  const dir = join(home, '.config', 'systemd', 'user')
  return { dir, path: join(dir, `${name}.service`) }
}

/** The uid launchd's gui domain needs. */
function uid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 501
}

export interface InstallResult {
  ok: boolean
  platform: 'darwin' | 'linux'
  name: string
  path: string
  tunnel: boolean
  /** What the supervisor said, when it was asked to load the unit now. */
  loaded: { ok: boolean; detail: string }
}

/** Where a bin named cloudflared lives, as an absolute path: an explicit CLOUDFLARED_BIN, PATH, then the Homebrew and system
 * locations a launchd agent's minimal PATH would miss. Null when it is not installed. */
export function resolveCloudflared(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.CLOUDFLARED_BIN
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) return explicit
  const onPath = commandOnPath('cloudflared', env)
  if (onPath !== null) return onPath
  for (const candidate of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared']) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Install the service file(s) and ask the supervisor to load them. */
export async function installService(input: { projectDir: string; withTunnel: boolean; force: boolean; dryRun: boolean; load?: boolean }): Promise<InstallResult> {
  const home = homedir()
  const platform = process.platform as 'darwin' | 'linux'
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new CliError('service.unsupported', `service install supports macOS (launchd) and Linux (systemd); this is ${process.platform}`, {
      next: 'Run the Watcher yourself: `watcher run --detach`, or use Docker (compose.yaml).'
    })
  }
  const project = resolveProject(input.projectDir)
  const configRead = readConfig(project)
  if (!configRead.ok) throw new CliError(configRead.error.code, configRead.error.message, { next: configRead.error.next })
  const data = withDataDir(project, configRead.config)
  const name = serviceName(project.dir)
  const bin = join(packageRoot(), 'bin', 'watcher.mjs')
  if (!existsSync(bin)) throw new CliError('service.bin-missing', `the CLI's bin file is missing: ${bin}`, { next: 'Reinstall the package (npm i -g ezo-watcher); the install recreates bin/watcher.mjs.' })
  const dir = servicePaths(home, name).dir
  const path = servicePaths(home, name).path
  const main = process.platform === 'darwin'
    ? launchdPlist({ label: labelOf(name), projectDir: project.dir, node: process.execPath, bin, logPath: data.logPath })
    : systemdUnit({ projectDir: project.dir, node: process.execPath, bin })

  const tokenName = join(data.dataDir, 'cloudflared.token')
  const envToken = process.env.CLOUDFLARE_TUNNEL_TOKEN
  const tunnelWanted = input.withTunnel && (envToken !== undefined || existsSync(tokenName))
  let tunnelPath: string | null = null
  let tunnelContent: string | null = null
  if (tunnelWanted) {
    // launchd runs the agent with a minimal PATH, so `cloudflared` is resolved to an absolute path now, while the installing
    // shell still has Homebrew's bin on it. The plist and the unit both carry that path.
    const cloudflared = resolveCloudflared()
    if (cloudflared === null) {
      throw new CliError('cloudflare.cloudflared-missing', 'cloudflared is not installed, so --with-tunnel cannot install its agent', {
        next: 'Install it: brew install cloudflared   (or set CLOUDFLARED_BIN to its absolute path), then re-run `watcher service install --with-tunnel`.'
      })
    }
    if (process.platform === 'darwin') {
      tunnelPath = join(dir, `${labelOf(`${name}-tunnel`)}.plist`)
      tunnelContent = launchdTunnelPlist({ label: labelOf(`${name}-tunnel`), projectDir: project.dir, cloudflared, tokenFile: tokenName, logPath: join(data.dataDir, 'cloudflared.log') })
    } else {
      tunnelPath = join(dir, `${name}-tunnel.service`)
      tunnelContent = systemdTunnelUnit({ projectDir: project.dir, cloudflared, tokenFile: tokenName })
    }
  }

  if (input.dryRun) {
    return { ok: true, platform, name, path, tunnel: tunnelWanted, loaded: { ok: false, detail: 'dry run: nothing written' } }
  }
  if (existsSync(path) && !input.force) {
    throw new CliError('service.exists', `${path} already exists`, { next: `Re-run with --force to replace it, or \`watcher service uninstall\` first.` })
  }
  mkdirSync(dir, { recursive: true })
  mkdirSync(data.dataDir, { recursive: true })
  if (tunnelWanted && envToken !== undefined) writeFileAtomic(tokenName, `${envToken}\n`, 0o600)
  writeFileAtomic(path, main, 0o644)
  if (tunnelPath && tunnelContent) writeFileAtomic(tunnelPath, tunnelContent, 0o644)

  const load = input.load !== false
  const loaded = load
    ? process.platform === 'darwin'
      ? bootstrapLaunchd(path, labelOf(name))
      : enableSystemd(name)
    : { ok: true, detail: 'file written; not loaded (--no-load)' }
  if (load && tunnelPath && tunnelContent) {
    if (process.platform === 'darwin') bootstrapLaunchd(tunnelPath, labelOf(`${name}-tunnel`))
    else enableSystemd(`${name}-tunnel`)
  }
  return { ok: loaded.ok, platform, name, path, tunnel: tunnelWanted, loaded }
}

function bootstrapLaunchd(path: string, label: string): { ok: boolean; detail: string } {
  runProcess('launchctl', ['bootout', `gui/${uid()}/${label}`], { timeoutMs: 10_000 })
  const r = runProcess('launchctl', ['bootstrap', `gui/${uid()}`, path], { timeoutMs: 15_000 })
  return { ok: r.status === 0, detail: (r.stderr || r.stdout).trim().slice(0, 400) || (r.status === 0 ? 'loaded' : `launchctl exited ${r.status}`) }
}

function enableSystemd(name: string): { ok: boolean; detail: string } {
  runProcess('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 15_000 })
  const r = runProcess('systemctl', ['--user', 'enable', '--now', `${name}.service`], { timeoutMs: 20_000 })
  return { ok: r.status === 0, detail: (r.stderr || r.stdout).trim().slice(0, 400) || (r.status === 0 ? 'enabled and started' : `systemctl exited ${r.status}`) }
}

/** Remove the service file(s) and stop the supervisor's copy. */
export async function uninstallService(input: { projectDir: string; dryRun: boolean }): Promise<{ ok: boolean; removed: string[]; platform: string }> {
  const project = resolveProject(input.projectDir)
  const name = serviceName(project.dir)
  const { path } = servicePaths(homedir(), name)
  const tunnel = process.platform === 'darwin' ? join(servicePaths(homedir(), name).dir, `${labelOf(`${name}-tunnel`)}.plist`) : join(servicePaths(homedir(), name).dir, `${name}-tunnel.service`)
  const removed: string[] = []
  if (input.dryRun) return { ok: true, removed: [path, tunnel].filter((p) => existsSync(p)), platform: process.platform }
  if (process.platform === 'darwin') {
    runProcess('launchctl', ['bootout', `gui/${uid()}/${labelOf(name)}`], { timeoutMs: 10_000 })
    runProcess('launchctl', ['bootout', `gui/${uid()}/${labelOf(`${name}-tunnel`)}`], { timeoutMs: 10_000 })
  } else if (process.platform === 'linux') {
    runProcess('systemctl', ['--user', 'disable', '--now', `${name}.service`], { timeoutMs: 20_000 })
    runProcess('systemctl', ['--user', 'disable', '--now', `${name}-tunnel.service`], { timeoutMs: 20_000 })
  }
  for (const p of [path, tunnel]) {
    if (existsSync(p)) {
      rmSync(p, { force: true })
      removed.push(p)
    }
  }
  return { ok: true, removed, platform: process.platform }
}

export async function runService(args: ParsedArgs, out: Output): Promise<number> {
  const sub = args.sub
  if (sub !== 'install' && sub !== 'uninstall') {
    throw new CliError('usage.missing-sub', 'service needs install or uninstall', { exitCode: 64, next: 'watcher service install [--with-tunnel]  |  watcher service uninstall' })
  }
  const projectDir = resolveProject(args.dir).dir
  if (sub === 'install') {
    const result = await installService({
      projectDir,
      withTunnel: args.switches.get('with-tunnel') === true,
      force: args.switches.get('force') === true,
      dryRun: args.dryRun,
      load: args.switches.get('no-load') !== true
    })
    out.json(result)
    out.line(`${out.ok('service installed')} ${result.platform === 'darwin' ? 'launchd agent' : 'systemd --user unit'}`)
    out.line(`file     ${result.path}`)
    if (result.tunnel) out.line('tunnel   cloudflared agent installed too (token in .watcher/data/cloudflared.token, 0600)')
    out.line(`load     ${result.loaded.ok ? out.ok(result.loaded.detail) : out.warn(result.loaded.detail)}`)
    out.line(`next     watcher status`)
    return result.loaded.ok || args.dryRun ? 0 : 1
  }
  const result = await uninstallService({ projectDir, dryRun: args.dryRun })
  out.json(result)
  out.line(`${out.ok('service uninstalled')} (${result.platform})`)
  if (result.removed.length === 0) out.line(out.dim('no service file was installed'))
  for (const p of result.removed) out.line(`removed  ${p}`)
  return 0
}

/** The token file `--with-tunnel` reads, exposed for the cloudflare verb to write. */
export function tunnelTokenFile(projectDir: string): string {
  const project = resolveProject(projectDir)
  const configRead = readConfig(project)
  return join(withDataDir(project, configRead.ok ? configRead.config : null).dataDir, 'cloudflared.token')
}

/** Read the tunnel token from the env first, then the 0600 file (never printed). */
export function readTunnelToken(projectDir: string): string | null {
  if (process.env.CLOUDFLARE_TUNNEL_TOKEN) return process.env.CLOUDFLARE_TUNNEL_TOKEN
  const file = tunnelTokenFile(projectDir)
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8').trim()
  return text === '' ? null : text
}

