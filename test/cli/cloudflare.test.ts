import { describe, expect, it, afterEach } from 'vitest'
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { INIT_SPEC, runInit } from '../../src/cli/init.ts'
import {
  CLOUDFLARE_SPEC,
  apexOf,
  cloudflareDoctorChecks,
  quickTunnel,
  quickTunnelUrl,
  setupTunnel,
  tunnelName
} from '../../src/cli/cloudflare.ts'
import type { CloudflareContext } from '../../src/cli/cloudflare.ts'
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

interface FakeCf {
  fetchImpl: typeof fetch
  requests: Array<{ method: string; path: string; body: string }>
}

interface CfState {
  tunnels: Array<{ id: string; name: string; status: string }>
  records: Array<{ id: string; name: string; type: string; content: string; proxied: boolean }>
  failVerify?: boolean
  zone?: boolean
  port?: number
  accessApps?: Array<{ id: string; domain: string }>
  accessPolicies?: Array<{ id: string; name: string }>
}

/**
 * A scripted Cloudflare API. Every path is the real one the CLI calls, so a wrong endpoint shows up
 * as a 404 in the test rather than passing silently.
 */
function fakeCf(state: CfState = { tunnels: [], records: [] }): FakeCf {
  const requests: FakeCf['requests'] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : ''
    requests.push({ method, path: `${url.pathname}${url.search}`, body })
    const json = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    const success = (result: unknown): Response => json({ success: true, errors: [], messages: [], result })

    if (url.pathname === '/client/v4/user/tokens/verify') {
      return state.failVerify ? json({ success: false, errors: [{ code: 1000, message: 'invalid token' }], result: null }, 403) : success({ id: 'tok', status: 'active' })
    }
    if (url.pathname === '/client/v4/zones') {
      return success(state.zone === false ? [] : [{ id: 'zone1', name: 'example.com' }])
    }
    if (url.pathname === '/client/v4/accounts/acct/cfd_tunnel' && method === 'GET') {
      const name = url.searchParams.get('name')
      return success(state.tunnels.filter((t) => t.name === name))
    }
    if (url.pathname === '/client/v4/accounts/acct/cfd_tunnel' && method === 'POST') {
      const parsed = JSON.parse(body) as { name: string }
      const tunnel = { id: 'tun1', name: parsed.name, status: 'inactive' }
      state.tunnels.push(tunnel)
      return success(tunnel)
    }
    if (/^\/client\/v4\/accounts\/acct\/cfd_tunnel\/tun1$/.test(url.pathname)) {
      return success(state.tunnels.find((t) => t.id === 'tun1'))
    }
    if (url.pathname === '/client/v4/accounts/acct/cfd_tunnel/tun1/configurations') {
      return success({ config: { ingress: [{ hostname: 'watch.example.com', service: `http://127.0.0.1:${state.port ?? 7717}` }, { service: 'http_status:404' }] } })
    }
    if (url.pathname === '/client/v4/accounts/acct/cfd_tunnel/tun1/token') {
      return success('tunnel-token-value')
    }
    if (/^\/client\/v4\/zones\/zone1\/dns_records$/.test(url.pathname) && method === 'GET') {
      const name = url.searchParams.get('name')
      return success(state.records.filter((r) => r.name === name))
    }
    if (/^\/client\/v4\/zones\/zone1\/dns_records$/.test(url.pathname) && method === 'POST') {
      const parsed = JSON.parse(body) as { name: string; type: string; content: string; proxied: boolean }
      const record = { id: 'rec1', ...parsed }
      state.records.push(record)
      return success(record)
    }
    if (/^\/client\/v4\/zones\/zone1\/dns_records\/rec1$/.test(url.pathname) && method === 'PATCH') {
      const parsed = JSON.parse(body) as { name: string; type: string; content: string; proxied: boolean }
      state.records = state.records.map((r) => (r.id === 'rec1' ? { id: 'rec1', ...parsed } : r))
      return success(state.records[0])
    }
    if (url.pathname === '/client/v4/accounts/acct/access/apps' && method === 'GET') {
      const domain = url.searchParams.get('domain')
      return success((state.accessApps ?? []).filter((a) => domain === null || a.domain === domain))
    }
    if (url.pathname === '/client/v4/accounts/acct/access/apps' && method === 'POST') {
      return success({ id: 'app1', domain: 'watch.example.com' })
    }
    if (/^\/client\/v4\/accounts\/acct\/access\/apps\/app1$/.test(url.pathname) && method === 'PUT') {
      return success({ id: 'app1', domain: 'watch.example.com' })
    }
    if (url.pathname === '/client/v4/accounts/acct/access/apps/app1/policies' && method === 'GET') {
      return success(state.accessPolicies ?? [])
    }
    if (url.pathname === '/client/v4/accounts/acct/access/apps/app1/policies' && method === 'POST') {
      return success({ id: 'pol1' })
    }
    if (/^\/client\/v4\/accounts\/acct\/access\/apps\/app1\/policies\/pol1$/.test(url.pathname) && method === 'PUT') {
      return success({ id: 'pol1' })
    }
    return json({ success: false, errors: [{ code: 7000, message: `unexpected ${method} ${url.pathname}` }], result: null }, 404)
  }) as typeof fetch
  return { fetchImpl, requests }
}

async function seeded(prefix: string): Promise<string> {
  const g = guard()
  const port = await freePort()
  g.set({ WATCHER_ACK_SECRET: 'ack', WATCHER_ADMIN_TOKEN: 'admin', WATCHER_MCP_TOKEN: 'mcp', WATCHER_PORT: String(port), CLOUDFLARE_API_TOKEN: 'cf-token', CLOUDFLARE_ACCOUNT_ID: 'acct' })
  const dir = temp(prefix)
  expect(await runInit(parse(['init', '--dir', dir], INIT_SPEC), capture('json').out)).toBe(0)
  return dir
}

function ctxFor(dir: string, fetchImpl: typeof fetch, opts: Partial<CloudflareContext> = {}): CloudflareContext {
  return {
    projectDir: dir,
    projectName: 'watcher-proj',
    port: 7717,
    host: '127.0.0.1',
    hostname: 'watch.example.com',
    accessEmail: undefined,
    dryRun: false,
    fetchImpl,
    apiToken: 'cf-token',
    accountId: 'acct',
    tunnelName: 'watcher-proj',
    dataDir: join(dir, '.watcher', 'data'),
    envPath: join(dir, '.watcher', '.env'),
    ...opts
  }
}

describe('cloudflare helpers', () => {
  it('derives the apex (including two-label suffixes) and the tunnel name', () => {
    expect(apexOf('watch.example.com')).toBe('example.com')
    expect(apexOf('example.com')).toBe('example.com')
    expect(apexOf('a.b.example.co.uk')).toBe('example.co.uk')
    expect(tunnelName(join(tmpdir(), 'someone', 'projects', 'My App'))).toBe('watcher-my-app')
  })

  it('recognises the trycloudflare URL cloudflared prints', () => {
    expect(quickTunnelUrl('INF |  https://brave-tiger-42.trycloudflare.com  |')).toBe('https://brave-tiger-42.trycloudflare.com')
    expect(quickTunnelUrl('nothing yet')).toBeNull()
  })
})

describe('watcher cloudflare tunnel', () => {
  it('creates the tunnel, configures ingress, upserts a proxied CNAME, writes the token and the Access app', async () => {
    const dir = await seeded('cf-tunnel')
    const fake = fakeCf({ tunnels: [], records: [] })
    const result = await setupTunnel(ctxFor(dir, fake.fetchImpl, { accessEmail: 'ops@example.com' }))
    expect(result.ok).toBe(true)
    expect(result.tunnel).toMatchObject({ id: 'tun1', name: 'watcher-proj', created: true })
    expect(result.zone).toEqual({ id: 'zone1', name: 'example.com' })
    expect(result.dns).toMatchObject({ name: 'watch.example.com', content: 'tun1.cfargotunnel.com', proxied: true, created: true })

    const config = fake.requests.find((r) => r.method === 'PUT' && r.path.endsWith('/cfd_tunnel/tun1/configurations'))
    expect(config).toBeDefined()
    const ingress = (JSON.parse(config!.body) as { config: { ingress: Array<Record<string, string>> } }).config.ingress
    expect(ingress[0]).toMatchObject({ hostname: 'watch.example.com', service: 'http://127.0.0.1:7717' })
    expect(ingress[ingress.length - 1]).toEqual({ service: 'http_status:404' })

    const dnsPost = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/zones/zone1/dns_records'))
    expect(JSON.parse(dnsPost!.body)).toMatchObject({ type: 'CNAME', name: 'watch.example.com', content: 'tun1.cfargotunnel.com', proxied: true })

    const env = readFileSync(join(dir, '.watcher', '.env'), 'utf8')
    expect(env).toContain('CLOUDFLARE_TUNNEL_TOKEN=tunnel-token-value')
    expect(statSync(join(dir, '.watcher', '.env')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, '.watcher', 'data', 'cloudflared.token')).mode & 0o777).toBe(0o600)
    // The token is written, never returned in the result (which a --json run prints).
    expect(JSON.stringify(result)).not.toContain('tunnel-token-value')

    const appPost = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/access/apps'))
    const app = JSON.parse(appPost!.body) as { domain: string; destinations: Array<{ uri: string; overrides: Array<{ path_pattern: string }> }> }
    expect(app.domain).toBe('watch.example.com')
    expect(app.destinations[0].overrides.map((o) => o.path_pattern)).toEqual(['/ingest/*', '/mcp', '/healthz'])
    const policy = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/access/apps/app1/policies'))
    expect(JSON.parse(policy!.body)).toMatchObject({ decision: 'allow', include: [{ email: { email: 'ops@example.com' } }] })
  })

  it('updates a found Access app in place and upserts its policy instead of appending duplicates', async () => {
    const dir = await seeded('cf-access-upsert')
    const state: CfState = {
      tunnels: [{ id: 'tun1', name: 'watcher-proj', status: 'healthy' }],
      records: [],
      accessApps: [{ id: 'app1', domain: 'watch.example.com' }],
      accessPolicies: [{ id: 'pol1', name: 'allow ops@example.com' }]
    }
    const fake = fakeCf(state)
    const result = await setupTunnel(ctxFor(dir, fake.fetchImpl, { accessEmail: 'ops@example.com' }))
    expect(result.access).toMatchObject({ appId: 'app1', policyId: 'pol1' })
    const appPut = fake.requests.filter((r) => r.method === 'PUT' && /\/access\/apps\/app1$/.test(r.path))
    expect(appPut).toHaveLength(1)
    expect(JSON.parse(appPut[0].body)).toMatchObject({ domain: 'watch.example.com', destinations: [{ overrides: [{ path_pattern: '/ingest/*' }, { path_pattern: '/mcp' }, { path_pattern: '/healthz' }] }] })
    const policyPut = fake.requests.filter((r) => r.method === 'PUT' && /\/access\/apps\/app1\/policies\/pol1$/.test(r.path))
    expect(policyPut).toHaveLength(1)
    expect(fake.requests.some((r) => r.method === 'POST' && r.path.endsWith('/access/apps'))).toBe(false)
    expect(fake.requests.some((r) => r.method === 'POST' && r.path.endsWith('/access/apps/app1/policies'))).toBe(false)
  })

  it('is idempotent: an existing tunnel and record are reused (the record patched, not posted again)', async () => {
    const dir = await seeded('cf-idem')
    const state: CfState = { tunnels: [{ id: 'tun1', name: 'watcher-proj', status: 'healthy' }], records: [{ id: 'rec1', name: 'watch.example.com', type: 'CNAME', content: 'old.cfargotunnel.com', proxied: false }] }
    const fake = fakeCf(state)
    const result = await setupTunnel(ctxFor(dir, fake.fetchImpl))
    expect(result.tunnel.created).toBe(false)
    expect(result.dns.created).toBe(false)
    expect(fake.requests.some((r) => r.method === 'POST' && r.path.endsWith('/cfd_tunnel'))).toBe(false)
    expect(fake.requests.some((r) => r.method === 'PATCH' && r.path.endsWith('/dns_records/rec1'))).toBe(true)
    expect(fake.requests.some((r) => r.method === 'POST' && r.path.endsWith('/dns_records'))).toBe(false)
  })

  it('fails with cloudflare.zone-missing before touching tunnels or DNS', async () => {
    const dir = await seeded('cf-nozone')
    const fake = fakeCf({ tunnels: [], records: [], zone: false })
    await expect(setupTunnel(ctxFor(dir, fake.fetchImpl))).rejects.toMatchObject({ code: 'cloudflare.zone-missing' })
    expect(fake.requests.some((r) => r.path.includes('/cfd_tunnel'))).toBe(false)
  })

  it('--dry-run sends nothing and writes no token', async () => {
    const dir = await seeded('cf-dry')
    const fake = fakeCf({ tunnels: [], records: [] })
    const result = await setupTunnel(ctxFor(dir, fake.fetchImpl, { dryRun: true }))
    expect(fake.requests).toEqual([])
    expect(result.tokenWritten).toBe(false)
    expect(readFileSync(join(dir, '.watcher', '.env'), 'utf8')).not.toContain('CLOUDFLARE_TUNNEL_TOKEN')
  })
})

describe('watcher cloudflare quick', () => {
  it('requires WATCHER_ADMIN_TOKEN (the tunnel is public)', async () => {
    const dir = await seeded('cf-quick')
    const g = guard()
    g.set({ WATCHER_ADMIN_TOKEN: undefined })
    await expect(quickTunnel(parse(['cloudflare', 'quick', '--dir', dir], CLOUDFLARE_SPEC), capture('json').out)).rejects.toMatchObject({ code: 'cloudflare.admin-token-missing' })
  })

  it('prints the command in --dry-run and refuses without cloudflared', async () => {
    const dir = await seeded('cf-quick2')
    const bin = temp('cf-bin')
    const fakeBin = join(bin, 'cloudflared')
    writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n')
    chmodSync(fakeBin, 0o755)
    const g = guard()
    g.set({ PATH: `${bin}:/usr/bin:/bin` })
    const cap = capture('json')
    const code = await quickTunnel(parse(['cloudflare', 'quick', '--dir', dir, '--dry-run'], CLOUDFLARE_SPEC), cap.out)
    expect(code).toBe(0)
    expect(String((JSON.parse(cap.stdout()) as { command: string }).command)).toContain('tunnel --url http://127.0.0.1:')

    g.set({ PATH: '/nonexistent' })
    await expect(quickTunnel(parse(['cloudflare', 'quick', '--dir', dir, '--dry-run'], CLOUDFLARE_SPEC), capture('json').out)).rejects.toMatchObject({ code: 'cloudflare.cloudflared-missing' })
  })
})

describe('doctor --target cloudflare', () => {
  it('passes a healthy tunnel with the right DNS record', async () => {
    const dir = await seeded('cf-doctor-ok')
    const name = tunnelName(dir)
    const state: CfState = { tunnels: [{ id: 'tun1', name, status: 'healthy' }], records: [{ id: 'rec1', name: 'watch.example.com', type: 'CNAME', content: 'tun1.cfargotunnel.com', proxied: true }], port: Number(process.env.WATCHER_PORT) }
    const fake = fakeCf(state)
    const bin = temp('cf-bin2')
    writeFileSync(join(bin, 'cloudflared'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, 'cloudflared'), 0o755)
    const g = guard()
    g.set({ PATH: `${bin}:/usr/bin:/bin` })
    const project = { dir, watcherDir: join(dir, '.watcher'), configPath: join(dir, '.watcher', 'config.json'), envPath: join(dir, '.watcher', '.env'), envExamplePath: join(dir, '.watcher', '.env.example') }
    const checks = await cloudflareDoctorChecks({ project, hostname: 'watch.example.com', fetchImpl: fake.fetchImpl, token: 'cf-token', accountId: 'acct' })
    const by = (code: string) => checks.find((c) => c.code === code)
    expect(by('cloudflare.token-valid')?.status).toBe('pass')
    expect(by('cloudflare.cloudflared')?.status).toBe('pass')
    expect(by('cloudflare.tunnel')?.status).toBe('pass')
    expect(by('cloudflare.dns')?.status).toBe('pass')
    expect(by('cloudflare.ingress')?.status).toBe('pass')
    expect(by('cloudflare.scopes')?.status).toBe('pass')
    expect(checks.some((c) => c.status === 'fail')).toBe(false)
  })

  it('fails an invalid token and an unhealthy tunnel, and skips a missing one', async () => {
    const dir = await seeded('cf-doctor-bad')
    const bin = temp('cf-bin3')
    writeFileSync(join(bin, 'cloudflared'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, 'cloudflared'), 0o755)
    const g = guard()
    g.set({ PATH: `${bin}:/usr/bin:/bin` })
    const project = { dir, watcherDir: join(dir, '.watcher'), configPath: join(dir, '.watcher', 'config.json'), envPath: join(dir, '.watcher', '.env'), envExamplePath: join(dir, '.watcher', '.env.example') }

    const invalid = fakeCf({ tunnels: [], records: [], failVerify: true })
    let checks = await cloudflareDoctorChecks({ project, hostname: 'watch.example.com', fetchImpl: invalid.fetchImpl, token: 'bad', accountId: 'acct' })
    expect(checks.find((c) => c.code === 'cloudflare.token-invalid')?.status).toBe('fail')

    const unhealthy = fakeCf({ tunnels: [{ id: 'tun1', name: tunnelName(dir), status: 'down' }], records: [] })
    checks = await cloudflareDoctorChecks({ project, hostname: 'watch.example.com', fetchImpl: unhealthy.fetchImpl, token: 'cf-token', accountId: 'acct' })
    expect(checks.find((c) => c.code === 'cloudflare.tunnel-unhealthy')?.status).toBe('fail')
    expect(checks.find((c) => c.code === 'cloudflare.dns')?.status).toBe('fail')

    const missing = fakeCf({ tunnels: [], records: [] })
    checks = await cloudflareDoctorChecks({ project, hostname: 'watch.example.com', fetchImpl: missing.fetchImpl, token: 'cf-token', accountId: 'acct' })
    expect(checks.find((c) => c.code === 'cloudflare.tunnel-missing')?.status).toBe('skip')
  })
})

