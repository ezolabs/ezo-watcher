// `watcher cloudflare`: put a running Watcher behind Cloudflare, with as little account setup as
// possible.
//
//   quick   the zero-account rung: `cloudflared tunnel --url http://127.0.0.1:<port>` and an
//           ephemeral https://<random>.trycloudflare.com URL. Public, so it needs
//           WATCHER_ADMIN_TOKEN (which `watcher init` generates). Nothing is written to Cloudflare.
//   tunnel  the hosted rung: find-or-create a remotely-managed tunnel named `watcher-<project>`,
//           PUT its ingress config, upsert a proxied CNAME, fetch the run token to .watcher/.env,
//           and optionally put an Access application in front of the wall.
//
// Endpoints verified against developers.cloudflare.com on 2026-11-04 (the docs' own "Last updated"
// dates in parentheses):
//   POST   /accounts/{account_id}/cfd_tunnel                                  (Create a tunnel (API), 2026-04-17)
//   PUT    /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations       (same page)
//   GET    /accounts/{account_id}/cfd_tunnel/{tunnel_id}                      (same page, "Verify tunnel status")
//   GET    /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token                (same page, "the Cloudflare Tunnel token endpoint")
//   GET    /zones?name={apex}                                                 (List Zones, API reference)
//   GET    /zones/{zone_id}/dns_records?name={host}                           (List DNS Records, API reference)
//   POST   /zones/{zone_id}/dns_records                                       (Create a tunnel (API), 2026-04-17)
//   PATCH  /zones/{zone_id}/dns_records/{record_id}                           (Update DNS Record, API reference)
//   POST   /accounts/{account_id}/access/apps                                 (Add an Access application, API reference)
//   PUT    /accounts/{account_id}/access/apps/{app_id}                        (Update an Access application, retrieved 2026-11-04,
//                                                                             developers.cloudflare.com/api/resources/zero_trust/
//                                                                             subresources/access/subresources/applications/methods/update/)
//   GET    /accounts/{account_id}/access/apps/{app_id}/policies               (List Access policies, API reference)
//   POST   /accounts/{account_id}/access/apps/{app_id}/policies               (Create an Access application policy, API reference)
//   PUT    /accounts/{account_id}/access/apps/{app_id}/policies/{policy_id}   (Update an Access application policy, retrieved
//                                                                             2026-11-04, developers.cloudflare.com/api/resources/zero_trust/
//                                                                             subresources/access/subresources/applications/subresources/policies/methods/update/)
//   GET    /user/tokens/verify                                                (Verify Token, API reference)
//
// Minimum token permissions are in deploy/cloudflare/README.md. Tests mock fetch; no test talks to
// Cloudflare, and no code path ever prints the API token or the tunnel token.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ParsedArgs } from './util.ts'
import { CliError, commandOnPath, flagValue, numberFlag, oneLine, runProcess, sleep, slugify } from './util.ts'
import type { Output } from './output.ts'
import type { Check } from './doctor.ts'
import { readConfig, resolveProject, withDataDir, writeEnvVars, writeFileAtomic } from './project.ts'
import type { WatchConfig } from '../server/config.ts'

export const CLOUDFLARE_SPEC = {
  valueFlags: ['dir', 'output', 'hostname', 'access-email', 'account-id', 'tunnel-name'],
  switchFlags: ['help', 'dry-run', 'force'],
  subVerbs: ['quick', 'tunnel']
} as const

const API = 'https://api.cloudflare.com/client/v4'

export interface CloudflareEnv {
  token: string | null
  accountId: string | null
}

/** The credentials, from the environment the CLI already loaded (.watcher/.env included). */
export function cloudflareEnv(args?: ParsedArgs, env: NodeJS.ProcessEnv = process.env): CloudflareEnv {
  return {
    token: env.CLOUDFLARE_API_TOKEN ?? null,
    accountId: (args ? flagValue(args, 'account-id') : undefined) ?? env.CLOUDFLARE_ACCOUNT_ID ?? null
  }
}

interface ApiAnswer<T> {
  ok: boolean
  result: T | null
  errors: Array<{ code?: number; message?: string }>
  status: number
}

/**
 * The API client. Every path is relative to /client/v4 and every answer goes through one place, so
 * an error names Cloudflare's own message and never the bearer token.
 */
class CloudflareApi {
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly dryRun: boolean

  constructor(token: string, fetchImpl: typeof fetch, dryRun: boolean) {
    this.token = token
    this.fetchImpl = fetchImpl
    this.dryRun = dryRun
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<ApiAnswer<T>> {
    if (this.dryRun) {
      return { ok: true, result: null, errors: [], status: 0 }
    }
    let res: Response
    try {
      res = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000)
      })
    } catch (err) {
      return { ok: false, result: null, errors: [{ message: `network error: ${(err as Error).message}` }], status: 0 }
    }
    let parsed: { success?: unknown; result?: unknown; errors?: unknown } = {}
    try {
      parsed = (await res.json()) as { success?: unknown; result?: unknown; errors?: unknown }
    } catch {
      parsed = {}
    }
    const errors = Array.isArray(parsed.errors)
      ? (parsed.errors as Array<{ code?: number; message?: string }>).map((e) => ({ ...(typeof e?.code === 'number' ? { code: e.code } : {}), ...(typeof e?.message === 'string' ? { message: e.message } : {}) }))
      : []
    return { ok: res.ok && parsed.success === true, result: (parsed.result ?? null) as T | null, errors, status: res.status }
  }
}

/** The apex of a hostname, for the zones lookup. Handles the common two-label public suffixes. */
export function apexOf(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.')
  if (labels.length <= 2) return labels.join('.')
  const twoLabel = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.nz', 'co.za', 'com.br', 'com.mx', 'com.tr', 'com.sg', 'co.in', 'com.cn', 'com.hk'])
  const lastTwo = labels.slice(-2).join('.')
  return twoLabel.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo
}

export function tunnelName(projectDir: string): string {
  const base = projectDir.split('/').filter(Boolean).pop() ?? 'project'
  return `watcher-${slugify(base, 'project')}`
}

interface ZoneRecord {
  id: string
  name: string
}

interface TunnelRecord {
  id: string
  name?: string
  status?: string
  created_at?: string
  config_src?: string
}

interface DnsRecord {
  id: string
  name: string
  type: string
  content: string
  proxied?: boolean
}

export interface TunnelResult {
  ok: boolean
  dryRun: boolean
  accountId: string
  hostname: string
  zone: { id: string; name: string }
  tunnel: { id: string; name: string; status: string; created: boolean }
  dns: { id: string; name: string; content: string; proxied: boolean; created: boolean }
  access?: { appId: string; policyId?: string; email: string }
  tokenWritten: boolean
  runCommand: string
  ingress: Array<{ hostname?: string; service: string }>
}

export interface CloudflareContext {
  projectDir: string
  projectName: string
  port: number
  host: string
  hostname: string | undefined
  accessEmail: string | undefined
  dryRun: boolean
  fetchImpl: typeof fetch
  apiToken: string
  accountId: string
  tunnelName: string
  dataDir: string
  envPath: string
  log?: (line: string) => void
}

function context(args: ParsedArgs, need: { hostname: boolean }, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): CloudflareContext {
  const project = resolveProject(args.dir)
  const configRead = readConfig(project)
  if (!configRead.ok) throw new CliError(configRead.error.code, configRead.error.message, { next: configRead.error.next })
  const config: WatchConfig = configRead.config
  const data = withDataDir(project, config)
  const credentials = cloudflareEnv(args, env)
  const hostname = flagValue(args, 'hostname')
  if (need.hostname && !hostname) {
    throw new CliError('cloudflare.hostname-missing', 'tunnel needs --hostname <name> (the public name to serve the wall on)', {
      exitCode: 64,
      next: 'Example: watcher cloudflare tunnel --hostname watch.example.com'
    })
  }
  if (!credentials.token) {
    throw new CliError('cloudflare.token-missing', 'CLOUDFLARE_API_TOKEN is not set', {
      next: "Add it to .watcher/.env: printf 'CLOUDFLARE_API_TOKEN=%s\\n' '<token>' >> .watcher/.env (permissions: Cloudflare Tunnel Write, DNS Write on the zone, Access Apps and Policies Write with --access-email)."
    })
  }
  if (!credentials.accountId) {
    throw new CliError('cloudflare.account-missing', 'CLOUDFLARE_ACCOUNT_ID is not set', {
      next: "Add it to .watcher/.env: printf 'CLOUDFLARE_ACCOUNT_ID=%s\\n' '<account id>' >> .watcher/.env"
    })
  }
  return {
    projectDir: project.dir,
    projectName: tunnelName(project.dir),
    port: Number(env.WATCHER_PORT ?? config.port ?? 7717),
    host: env.WATCHER_HOST ?? config.host ?? '127.0.0.1',
    hostname,
    accessEmail: flagValue(args, 'access-email'),
    dryRun: args.dryRun,
    fetchImpl,
    apiToken: credentials.token,
    accountId: credentials.accountId,
    tunnelName: flagValue(args, 'tunnel-name') ?? tunnelName(project.dir),
    dataDir: data.dataDir,
    envPath: project.envPath
  }
}

function cloudflaredMissing(): CliError {
  const brew = process.platform === 'darwin' ? 'brew install cloudflared' : 'sudo apt install cloudflared  # or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
  return new CliError('cloudflare.cloudflared-missing', 'cloudflared is not on PATH', { next: `Install it: ${brew}` })
}

/** `cloudflared quick`: an ephemeral tunnel with no account. Public, so the admin token is required. */
export async function quickTunnel(args: ParsedArgs, out: Output): Promise<number> {
  const project = resolveProject(args.dir)
  const configRead = readConfig(project)
  if (!configRead.ok) throw new CliError(configRead.error.code, configRead.error.message, { next: configRead.error.next })
  const port = Number(process.env.WATCHER_PORT ?? configRead.config.port ?? 7717)
  const local = `http://127.0.0.1:${port}`
  if (!process.env.WATCHER_ADMIN_TOKEN) {
    throw new CliError('cloudflare.admin-token-missing', 'WATCHER_ADMIN_TOKEN is not set; a quick tunnel is public, so every /api call must be authenticated', {
      next: 'Run `watcher init` (it generates WATCHER_ADMIN_TOKEN) or add one to .watcher/.env.'
    })
  }
  const bin = commandOnPath('cloudflared')
  if (!bin) throw cloudflaredMissing()
  const command = `${bin} tunnel --url ${local}`
  if (args.dryRun) {
    out.json({ ok: true, dryRun: true, command, ephemeral: true, note: 'the URL is minted by cloudflared and printed when the tunnel connects' })
    out.line(`would run: ${command}`)
    out.line(out.warn('the URL is ephemeral (trycloudflare.com) and public; WATCHER_ADMIN_TOKEN is required on /api.'))
    return 0
  }
  out.note(`starting ${command}`)
  out.note('the URL is ephemeral and public; keep WATCHER_ADMIN_TOKEN set and stop with Ctrl-C')
  const child = spawn(bin, ['tunnel', '--url', local], { stdio: ['ignore', 'pipe', 'pipe'] })
  let printed = false
  const scan = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    process.stderr.write(text)
    if (printed) return
    const m = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i.exec(text)
    if (m) {
      printed = true
      out.line(`${out.ok('public URL')} ${m[1]} ${out.warn('(ephemeral: it changes every run)')}`)
      out.line('next     watcher mcp-config --client claude   (point clients at the public /mcp if you need them remote)')
    }
  }
  child.stdout.on('data', scan)
  child.stderr.on('data', scan)
  const code: number = await new Promise((resolvePromise) => {
    child.once('close', (c) => resolvePromise(c ?? 0))
    child.once('error', (err) => {
      out.note(`cloudflared failed to start: ${err.message}`)
      resolvePromise(1)
    })
  })
  if (!printed) out.note('cloudflared exited without printing a trycloudflare URL')
  return code === 0 ? 0 : 1
}

/** `cloudflared tunnel --hostname`: the hosted, idempotent setup. */
export async function tunnelCommand(args: ParsedArgs, out: Output): Promise<number> {
  const ctx = context(args, { hostname: true })
  if (!commandOnPath('cloudflared')) throw cloudflaredMissing()
  const result = await setupTunnel(ctx)
  out.json(result)
  out.line(`${out.ok('cloudflare tunnel ready')} ${ctx.dryRun ? out.warn('(dry run: nothing was sent)') : ''}`)
  out.line(`hostname ${result.hostname}`)
  out.line(`zone     ${result.zone.name} (${result.zone.id})`)
  out.line(`tunnel   ${result.tunnel.name} (${result.tunnel.id}, ${result.tunnel.status}${result.tunnel.created ? ', created' : ', existing'})`)
  out.line(`dns      ${result.dns.name} CNAME ${result.dns.content} proxied=${result.dns.proxied}${result.dns.created ? ' (created)' : ' (updated)'}`)
  if (result.access) out.line(`access   app ${result.access.appId}, allow ${result.access.email}; /ingest/*, /mcp and /healthz are public`)
  out.line(`ingress  ${result.hostname} -> http://127.0.0.1:${ctx.port}, catch-all http_status:404`)
  out.line(`token    ${result.tokenWritten ? 'written to .watcher/.env as CLOUDFLARE_TUNNEL_TOKEN (0600) and .watcher/data/cloudflared.token' : 'not fetched (dry run)'}`)
  out.line('')
  out.line(`run it:  ${result.runCommand}`)
  out.line(`service: watcher service install --with-tunnel   (installs a launchd/systemd agent for cloudflared)`)
  return 0
}

/** The plan `--dry-run` prints: the same result shape, no request sent and no secret fetched. */
function plannedTunnel(ctx: CloudflareContext): TunnelResult {
  const hostname = ctx.hostname as string
  const apex = apexOf(hostname)
  return {
    ok: true,
    dryRun: true,
    accountId: ctx.accountId,
    hostname,
    zone: { id: 'dry-run-zone', name: apex },
    tunnel: { id: 'dry-run-tunnel', name: ctx.tunnelName, status: 'planned', created: true },
    dns: { id: 'dry-run-record', name: hostname, content: 'dry-run-tunnel.cfargotunnel.com', proxied: true, created: true },
    ...(ctx.accessEmail ? { access: { appId: 'dry-run-app', email: ctx.accessEmail } } : {}),
    tokenWritten: false,
    runCommand: `cloudflared tunnel --no-autoupdate run --token-file ${join(ctx.dataDir, 'cloudflared.token')}`,
    ingress: [
      { hostname, service: `http://127.0.0.1:${ctx.port}` },
      { service: 'http_status:404' }
    ]
  }
}

export async function setupTunnel(ctx: CloudflareContext): Promise<TunnelResult> {
  if (ctx.dryRun) return plannedTunnel(ctx)
  const api = new CloudflareApi(ctx.apiToken, ctx.fetchImpl, ctx.dryRun)
  const account = encodeURIComponent(ctx.accountId)
  const hostname = ctx.hostname as string
  const apex = apexOf(hostname)

  // 1. the zone must be on this account: fail early with the exact fix, not a 404 from DNS later.
  const zones = await api.request<ZoneRecord[]>('GET', `/zones?name=${encodeURIComponent(apex)}`)
  if (!zones.ok) throw apiError('cloudflare.zone-check', zones)
  const zone = zones.result?.find((z) => z.name === apex)
  if (!zone) {
    throw new CliError('cloudflare.zone-missing', `the zone ${apex} is not in this Cloudflare account`, {
      next: `Add ${apex} to the account that owns CLOUDFLARE_API_TOKEN (Cloudflare dashboard -> Add a site), or use a hostname under a zone it already holds.`
    })
  }

  // 2. find-or-create the remotely-managed tunnel named watcher-<project>.
  const list = await api.request<TunnelRecord[]>('GET', `/accounts/${account}/cfd_tunnel?name=${encodeURIComponent(ctx.tunnelName)}&is_deleted=false`)
  if (!list.ok) throw apiError('cloudflare.tunnel-list', list)
  let tunnel = list.result?.find((t) => t.name === ctx.tunnelName) ?? null
  let created = false
  if (!tunnel) {
    const post = await api.request<TunnelRecord>('POST', `/accounts/${account}/cfd_tunnel`, { name: ctx.tunnelName, config_src: 'cloudflare' })
    if (!post.ok || !post.result) throw apiError('cloudflare.tunnel-create', post)
    tunnel = post.result
    created = true
  }
  if (!tunnel.id) throw new CliError('cloudflare.tunnel-create', 'Cloudflare answered a tunnel with no id', { next: 'Check the API token permissions: Cloudflare Tunnel Write on this account.' })

  // 3. ingress: hostname -> the local server, catch-all 404. The path order is the contract; the
  //    catch-all must be last or Cloudflare refuses the config.
  const ingress = [
    { hostname, service: `http://127.0.0.1:${ctx.port}`, originRequest: {} },
    { service: 'http_status:404' }
  ]
  const put = await api.request<unknown>('PUT', `/accounts/${account}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ingress } })
  if (!put.ok) throw apiError('cloudflare.tunnel-config', put)

  // 4. the DNS record: a proxied CNAME at the hostname pointing at the tunnel.
  const target = `${tunnel.id}.cfargotunnel.com`
  const dnsList = await api.request<DnsRecord[]>('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`)
  if (!dnsList.ok) throw apiError('cloudflare.dns-list', dnsList)
  const existing = dnsList.result?.find((r) => r.name.toLowerCase() === hostname.toLowerCase())
  let dns: DnsRecord | null = null
  let dnsCreated = false
  if (existing) {
    const patch = await api.request<DnsRecord>('PATCH', `/zones/${zone.id}/dns_records/${existing.id}`, { type: 'CNAME', name: hostname, content: target, proxied: true })
    if (!patch.ok) throw apiError('cloudflare.dns-update', patch)
    dns = patch.result ?? existing
  } else {
    const post = await api.request<DnsRecord>('POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: hostname, content: target, proxied: true })
    if (!post.ok || !post.result) throw apiError('cloudflare.dns-create', post)
    dns = post.result
    dnsCreated = true
  }

  // 5. the run token: into .watcher/.env and a 0600 file, never printed.
  let tokenWritten = false
  if (!ctx.dryRun) {
    const tokenAnswer = await api.request<string>('GET', `/accounts/${account}/cfd_tunnel/${tunnel.id}/token`)
    if (!tokenAnswer.ok || typeof tokenAnswer.result !== 'string') throw apiError('cloudflare.tunnel-token', tokenAnswer)
    mkdirSync(ctx.dataDir, { recursive: true })
    writeEnvVars(ctx.envPath, { CLOUDFLARE_TUNNEL_TOKEN: tokenAnswer.result })
    writeFileAtomic(join(ctx.dataDir, 'cloudflared.token'), `${tokenAnswer.result}\n`, 0o600)
    tokenWritten = true
  }

  // 6. optional Access: an application for the hostname, an allow policy for the email, and public
  //    path overrides for the machine callers (/ingest/*, /mcp, /healthz).
  let access: TunnelResult['access']
  if (ctx.accessEmail) {
    const app = await ensureAccessApp(api, account, hostname, ctx.accessEmail)
    access = app
  }

  const runCommand = `cloudflared tunnel --no-autoupdate run --token-file ${join(ctx.dataDir, 'cloudflared.token')}`
  return {
    ok: true,
    dryRun: ctx.dryRun,
    accountId: ctx.accountId,
    hostname,
    zone: { id: zone.id, name: zone.name },
    tunnel: { id: tunnel.id, name: tunnel.name ?? ctx.tunnelName, status: tunnel.status ?? 'unknown', created },
    dns: { id: dns?.id ?? 'dry-run', name: dns?.name ?? hostname, content: dns?.content ?? target, proxied: dns?.proxied === true || ctx.dryRun, created: dnsCreated },
    ...(access ? { access } : {}),
    tokenWritten,
    runCommand,
    ingress
  }
}

async function ensureAccessApp(api: CloudflareApi, account: string, hostname: string, email: string): Promise<{ appId: string; policyId?: string; email: string }> {
  const desired = {
    name: `EZO Watcher (${hostname})`,
    domain: hostname,
    type: 'self_hosted',
    destinations: [
      {
        type: 'public',
        uri: hostname,
        // These paths are how machines reach the Watcher: senders push to /ingest, agents speak
        // MCP at /mcp, hosts answer /healthz. Public means Access does not authenticate them.
        overrides: [
          { behavior: 'public', path_pattern: '/ingest/*' },
          { behavior: 'public', path_pattern: '/mcp' },
          { behavior: 'public', path_pattern: '/healthz' }
        ]
      }
    ]
  }
  const list = await api.request<Array<{ id: string; domain?: string; name?: string }>>('GET', `/accounts/${account}/access/apps?domain=${encodeURIComponent(hostname)}`)
  const found = list.ok ? (list.result ?? []).find((a) => a.domain === hostname) ?? null : null
  let app: { id: string; domain?: string }
  if (found) {
    // A re-run updates the application it already owns. Creating a second app for the same domain is the defect this fixes:
    // Access would keep the first and the two would disagree about the public paths.
    const updated = await api.request<{ id: string }>('PUT', `/accounts/${account}/access/apps/${found.id}`, desired)
    if (!updated.ok) throw apiError('cloudflare.access-app', updated)
    app = { id: found.id, domain: hostname }
  } else {
    const created = await api.request<{ id: string }>('POST', `/accounts/${account}/access/apps`, desired)
    if (!created.ok || !created.result?.id) throw apiError('cloudflare.access-app', created)
    app = { id: created.result.id, domain: hostname }
  }
  // The allow policy is upserted by name: a second run rewrites the one it wrote instead of appending a duplicate.
  const policyBody = { name: `allow ${email}`, decision: 'allow', include: [{ email: { email } }] }
  const policies = await api.request<Array<{ id: string; name?: string }>>('GET', `/accounts/${account}/access/apps/${app.id}/policies`)
  const existing = policies.ok ? (policies.result ?? []).find((p) => p.name === policyBody.name) ?? null : null
  const policy = existing
    ? await api.request<{ id: string }>('PUT', `/accounts/${account}/access/apps/${app.id}/policies/${existing.id}`, policyBody)
    : await api.request<{ id: string }>('POST', `/accounts/${account}/access/apps/${app.id}/policies`, policyBody)
  if (!policy.ok) throw apiError('cloudflare.access-policy', policy)
  return { appId: app.id, ...(policy.result?.id ? { policyId: policy.result.id } : {}), email }
}

function apiError(code: string, answer: ApiAnswer<unknown>): CliError {
  const detail = answer.errors.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).filter(Boolean).join('; ')
  return new CliError(code, `Cloudflare API answered ${answer.status}: ${detail || 'no detail'}`, {
    next: 'Check the API token permissions (Cloudflare Tunnel Write, DNS Write on the zone, Access: Apps and Policies Write with --access-email) and CLOUDFLARE_ACCOUNT_ID.'
  })
}

// ---- doctor --target cloudflare ---------------------------------------------------------------------

const NEEDS_CLOUDFLARE: Check = {
  code: 'cloudflare.credentials',
  status: 'fail',
  message: 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are both needed',
  next: "Add both to .watcher/.env: printf 'CLOUDFLARE_API_TOKEN=%s\\nCLOUDFLARE_ACCOUNT_ID=%s\\n' '<token>' '<account id>' >> .watcher/.env"
}

/** The cloudflare checks `watcher doctor --target cloudflare` appends. */
export async function cloudflareDoctorChecks(input: {
  project: ReturnType<typeof resolveProject>
  hostname?: string
  fetchImpl?: typeof fetch
  token?: string
  accountId?: string
}): Promise<Check[]> {
  const checks: Check[] = []
  const env = { token: input.token ?? process.env.CLOUDFLARE_API_TOKEN ?? null, accountId: input.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? null }
  if (!env.token || !env.accountId) return [NEEDS_CLOUDFLARE]
  const api = new CloudflareApi(env.token, input.fetchImpl ?? fetch, false)

  const verify = await api.request<{ id?: string; status?: string }>('GET', '/user/tokens/verify')
  if (!verify.ok) {
    checks.push({ code: 'cloudflare.token-invalid', status: 'fail', message: `the API token did not verify: ${verify.errors.map((e) => e.message).join('; ') || `HTTP ${verify.status}`}`, next: 'Create a token with Cloudflare Tunnel Write, DNS Write on the zone (and Access: Apps and Policies Write for --access-email), then update CLOUDFLARE_API_TOKEN in .watcher/.env.' })
  } else {
    checks.push({ code: 'cloudflare.token-valid', status: 'pass', message: `the API token verifies (${verify.result?.status ?? 'active'})` })
  }

  if (!commandOnPath('cloudflared')) {
    checks.push({ code: 'cloudflare.cloudflared-missing', status: 'fail', message: 'cloudflared is not on PATH, so the tunnel cannot run on this host', next: process.platform === 'darwin' ? 'brew install cloudflared' : 'sudo apt install cloudflared' })
  } else {
    checks.push({ code: 'cloudflare.cloudflared', status: 'pass', message: `cloudflared is on PATH (${commandOnPath('cloudflared')})` })
  }

  const configRead = readConfig(input.project)
  const config = configRead.ok ? configRead.config : null
  const port = Number(process.env.WATCHER_PORT ?? config?.port ?? 7717)
  const name = tunnelName(input.project.dir)
  const list = await api.request<Array<{ id: string; name?: string; status?: string }>>('GET', `/accounts/${encodeURIComponent(env.accountId)}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`)
  if (!list.ok) {
    checks.push({ code: 'cloudflare.scopes', status: 'fail', message: `could not list tunnels: ${list.errors.map((e) => e.message).join('; ') || `HTTP ${list.status}`}`, next: 'Give the token Cloudflare Tunnel Read (and Cloudflare Tunnel Edit to create or configure a tunnel) on this account, then re-run.' })
    return checks
  }
  const tunnel = (list.result ?? []).find((t) => t.name === name) ?? null
  if (!tunnel) {
    checks.push({ code: 'cloudflare.tunnel-missing', status: 'skip', message: `no tunnel named ${name}`, next: `watcher cloudflare tunnel --hostname <name>` })
    return checks
  }
  const detail = await api.request<{ status?: string; connections?: unknown[] }>('GET', `/accounts/${encodeURIComponent(env.accountId)}/cfd_tunnel/${tunnel.id}`)
  const status = detail.result?.status ?? tunnel.status ?? 'unknown'
  if (status === 'healthy') {
    checks.push({ code: 'cloudflare.tunnel', status: 'pass', message: `tunnel ${name} (${tunnel.id}) is healthy` })
  } else {
    checks.push({
      code: 'cloudflare.tunnel-unhealthy',
      status: 'fail',
      message: `tunnel ${name} is ${status}`,
      next: `Run it on this host: watcher service install --with-tunnel (or cloudflared tunnel --no-autoupdate run --token-file ${join(withDataDir(input.project, config).dataDir, 'cloudflared.token')}).`
    })
  }

  // The hostname: --hostname, else the first ingress hostname the tunnel already serves.
  let hostname = input.hostname
  if (!hostname) {
    const cfg = await api.request<{ config?: { ingress?: Array<{ hostname?: string }> } }>('GET', `/accounts/${encodeURIComponent(env.accountId)}/cfd_tunnel/${tunnel.id}/configurations`)
    hostname = cfg.result?.config?.ingress?.find((i) => typeof i.hostname === 'string' && i.hostname !== '')?.hostname
  }
  if (!hostname) {
    checks.push({ code: 'cloudflare.hostname-missing', status: 'skip', message: 'the tunnel has no hostname ingress yet', next: `watcher cloudflare tunnel --hostname <name>` })
    return checks
  }

  const apex = apexOf(hostname)
  const zones = await api.request<Array<{ id: string; name: string }>>('GET', `/zones?name=${encodeURIComponent(apex)}`)
  const zone = zones.ok ? zones.result?.find((z) => z.name === apex) ?? null : null
  if (!zone) {
    checks.push({ code: 'cloudflare.zone-missing', status: 'fail', message: `the zone ${apex} is not on this account`, next: `Add ${apex} to the account, or move the hostname under a zone it holds.` })
    return checks
  }
  const dns = await api.request<Array<{ id: string; name: string; type: string; content: string; proxied?: boolean }>>('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`)
  const record = dns.ok ? dns.result?.find((r) => r.name.toLowerCase() === hostname!.toLowerCase()) ?? null : null
  if (record && record.type === 'CNAME' && record.content.startsWith(`${tunnel.id}.cfargotunnel.com`) && record.proxied === true) {
    checks.push({ code: 'cloudflare.dns', status: 'pass', message: `${hostname} is a proxied CNAME to ${record.content}` })
  } else if (record) {
    checks.push({
      code: 'cloudflare.dns',
      status: 'fail',
      message: `${hostname} is ${record.type} -> ${record.content} (proxied=${record.proxied === true}); it must be a proxied CNAME to ${tunnel.id}.cfargotunnel.com`,
      next: `watcher cloudflare tunnel --hostname ${hostname}   (it upserts the record)`
    })
  } else {
    checks.push({ code: 'cloudflare.dns', status: 'fail', message: `no DNS record for ${hostname}`, next: `watcher cloudflare tunnel --hostname ${hostname}` })
  }

  // The local end of the tunnel: does its ingress point the hostname at this Watcher's port?
  const cfg = await api.request<{ config?: { ingress?: Array<{ hostname?: string; service?: string }> } }>('GET', `/accounts/${encodeURIComponent(env.accountId)}/cfd_tunnel/${tunnel.id}/configurations`)
  const rule = cfg.ok ? (cfg.result?.config?.ingress ?? []).find((i) => i.hostname === hostname) : undefined
  const wanted = `http://127.0.0.1:${port}`
  if (cfg.ok && rule && rule.service === wanted) {
    checks.push({ code: 'cloudflare.ingress', status: 'pass', message: `the ingress maps ${hostname} to ${wanted}` })
  } else if (cfg.ok && rule) {
    checks.push({ code: 'cloudflare.ingress', status: 'fail', message: `the ingress maps ${hostname} to ${rule.service ?? 'nothing'}, not ${wanted}`, next: `watcher cloudflare tunnel --hostname ${hostname}   (rewrites the ingress to this port)` })
  } else {
    checks.push({ code: 'cloudflare.ingress', status: 'skip', message: `could not read the ingress configuration${cfg.ok ? ': no rule for ' + hostname : ''}`, next: `watcher cloudflare tunnel --hostname ${hostname}` })
  }
  checks.push({ code: 'cloudflare.scopes', status: 'pass', message: 'the token can read tunnels, DNS records and the tunnel configuration (Cloudflare Tunnel Read, DNS Read, Zone Read)' })
  return checks
}

// ---- the verb ----------------------------------------------------------------------------------------

export async function runCloudflare(args: ParsedArgs, out: Output): Promise<number> {
  const sub = args.sub
  if (sub === 'quick') return quickTunnel(args, out)
  if (sub === 'tunnel') return tunnelCommand(args, out)
  throw new CliError('usage.missing-sub', 'cloudflare needs quick or tunnel', {
    exitCode: 64,
    next: 'watcher cloudflare quick   |   watcher cloudflare tunnel --hostname <name>'
  })
}

/** Wait until a file exists, for tests that watch the quick-tunnel spawn. */
export async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (existsSync(path)) return true
    await sleep(100)
  }
  return false
}

/** The one line the quick tunnel prints once cloudflared names its URL, exported so a test can pin the shape. */
export function quickTunnelUrl(text: string): string | null {
  const m = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i.exec(text)
  return m ? m[1] : null
}

export { numberFlag, oneLine, runProcess }
