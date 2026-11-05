// `watcher service install`: the plist and the systemd unit must survive a project path with a space ("Application Support"),
// and the cloudflared agent must carry an absolute binary path — launchd starts it with a minimal PATH, where Homebrew's
// /opt/homebrew/bin is not on it.
import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INIT_SPEC, runInit } from '../../src/cli/init.ts'
import {
  installService,
  launchdPlist,
  launchdTunnelPlist,
  resolveCloudflared,
  serviceName,
  servicePaths,
  systemdArg,
  systemdTunnelUnit,
  systemdUnit,
  uninstallService
} from '../../src/cli/service.ts'
import { commandOnPath } from '../../src/cli/util.ts'
import { EnvGuard, WATCHER_KEYS, capture, freePort, parse, rmTemp, tempDir } from './helpers.ts'

const dirs: string[] = []
const guards: Array<() => void> = []

function temp(prefix: string): string {
  const dir = tempDir(prefix)
  dirs.push(dir)
  return dir
}

function guard(): EnvGuard {
  const g = new EnvGuard(WATCHER_KEYS)
  guards.push(() => g.restore())
  return g
}

afterEach(() => {
  for (const restore of guards.splice(0)) restore()
  for (const dir of dirs.splice(0)) rmTemp(dir)
})

describe('systemd quoting', () => {
  it('quotes a path with a space and doubles a percent specifier', () => {
    expect(systemdArg('/srv/app')).toBe('/srv/app')
    expect(systemdArg('/srv/Application Support/app')).toBe('"/srv/Application Support/app"')
    expect(systemdArg('/srv/100%')).toBe('/srv/100%%')
    expect(systemdArg('/srv/a"b')).toBe('"/srv/a\\"b"')
  })

  it('writes WorkingDirectory and every ExecStart argument quoted', () => {
    const unit = systemdUnit({ projectDir: '/srv/Application Support/app', node: '/srv/node/bin/node', bin: '/srv/pkg/bin/watcher.mjs' })
    expect(unit).toContain('WorkingDirectory="/srv/Application Support/app"')
    expect(unit).toContain('ExecStart=/srv/node/bin/node /srv/pkg/bin/watcher.mjs run --dir "/srv/Application Support/app"')
    expect(unit).not.toContain('ExecStart=/srv/node/bin/node /srv/pkg/bin/watcher.mjs run --dir /srv/Application Support/app')
  })

  it('quotes the tunnel unit too', () => {
    const unit = systemdTunnelUnit({ projectDir: '/srv/Application Support/app', cloudflared: '/srv/bin/cloudflared', tokenFile: '/srv/Application Support/app/.watcher/data/cloudflared.token' })
    expect(unit).toContain('ExecStart=/srv/bin/cloudflared tunnel --no-autoupdate run --token-file "/srv/Application Support/app/.watcher/data/cloudflared.token"')
  })
})

describe("the launchd plist's arguments", () => {
  it('keeps a path with a space as one XML string, escaped', () => {
    const plist = launchdPlist({ label: 'dev.ezolabs.watcher-demo', projectDir: '/srv/Application Support/app', node: '/srv/node/bin/node', bin: '/srv/pkg/bin/watcher.mjs', logPath: '/tmp/w.log' })
    expect(plist).toContain('<string>/srv/Application Support/app</string>')
    expect((plist.match(/<string>\/srv\/Application Support\/app<\/string>/g) ?? []).length).toBe(2)
    expect(plist).toContain('<key>WorkingDirectory</key>')
    expect(launchdPlist({ label: 'x', projectDir: '/srv/a & b', node: 'n', bin: 'w', logPath: 'l' })).toContain('<string>/srv/a &amp; b</string>')
  })

  it('puts the absolute cloudflared path in the tunnel plist', () => {
    const plist = launchdTunnelPlist({ label: 'x', projectDir: '/p', cloudflared: '/srv/bin/cloudflared', tokenFile: '/p/t', logPath: '/p/l' })
    expect(plist).toContain('<string>/srv/bin/cloudflared</string>')
  })
})

describe('cloudflared resolution', () => {
  it('prefers CLOUDFLARED_BIN when it exists', () => {
    const fake = join(temp('cf-bin'), 'cloudflared')
    writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 })
    expect(resolveCloudflared({ CLOUDFLARED_BIN: fake, PATH: '' })).toBe(fake)
    const fallback = resolveCloudflared({ CLOUDFLARED_BIN: join(temp('cf-missing'), 'nope'), PATH: '' })
    expect(fallback === null || fallback.endsWith('cloudflared')).toBe(true)
  })

  it('is a path, not a bare name, when the host has it installed', () => {
    const found = resolveCloudflared()
    if (found === null) return // not installed here: the service install refuses instead, tested below
    expect(found.startsWith('/')).toBe(true)
    expect(commandOnPath('cloudflared')).not.toBeNull()
  })
})

describe('watcher service install with a project path that has a space', () => {
  async function seeded(prefix: string): Promise<{ dir: string; home: string }> {
    const g = guard()
    const port = await freePort()
    g.set({ WATCHER_ACK_SECRET: 'ack-for-service', WATCHER_ADMIN_TOKEN: 'admin-for-service', WATCHER_MCP_TOKEN: 'mcp-for-service', WATCHER_PORT: String(port) })
    const dir = join(temp(prefix), 'Application Support', 'app')
    const out = capture('json').out
    expect(await runInit(parse(['init', '--dir', dir], INIT_SPEC), out)).toBe(0)
    const home = temp('service-home')
    g.set({ HOME: home })
    return { dir, home }
  }

  it('writes a unit/plist whose arguments name the whole path, and removes it again', async () => {
    const { dir } = await seeded('service-space')
    const result = await installService({ projectDir: dir, withTunnel: false, force: true, dryRun: false, load: false })
    expect(result.ok).toBe(true)
    const text = readFileSync(result.path, 'utf8')
    expect(text).toContain(dir)
    if (process.platform === 'darwin') {
      expect(text).toContain(`<string>${dir}</string>`)
    } else {
      expect(text).toContain(`WorkingDirectory="${dir}"`)
      expect(text).toContain(`--dir "${dir}"`)
    }
    const removed = await uninstallService({ projectDir: dir, dryRun: false })
    expect(removed.removed).toContain(result.path)
    expect(existsSync(result.path)).toBe(false)
    expect(serviceName(dir)).toContain('watcher-')
  })

  it('writes the resolved cloudflared path into the tunnel agent', async () => {
    const { dir } = await seeded('service-tunnel')
    const fake = join(temp('cf-tunnel-bin'), 'cloudflared')
    writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 })
    const g = guard()
    g.set({ CLOUDFLARED_BIN: fake, CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token-for-test' })
    const result = await installService({ projectDir: dir, withTunnel: true, force: true, dryRun: false, load: false })
    expect(result.tunnel).toBe(true)
    const { dir: dirOf } = servicePaths(process.env.HOME ?? '', serviceName(dir))
    const tunnelPath = process.platform === 'darwin'
      ? join(dirOf, `dev.ezolabs.${serviceName(dir)}-tunnel.plist`)
      : join(dirOf, `${serviceName(dir)}-tunnel.service`)
    const text = readFileSync(tunnelPath, 'utf8')
    expect(text).toContain(fake)
    expect(text).not.toMatch(/ExecStart=cloudflared |<string>cloudflared<\/string>/)
  })
})
