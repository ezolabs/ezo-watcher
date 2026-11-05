// The read verbs against a running Watcher: `status`, `incidents`, `test-alert` and `mcp-config`.
//
// All of them read the server's HTTP API, never its SQLite file (one writer, one reader), and send
// `Authorization: Bearer $WATCHER_ADMIN_TOKEN` when it is set: the admin token is the server's
// CLI-facing gate, so the CLI is ready for the enforced surface and works on a server that does not
// check it yet. `--output json|md|table` decides the shape; nothing here prompts.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ParsedArgs } from './util.ts'
import { CliError, flagValue, flagValues, numberFlag } from './util.ts'
import type { Output } from './output.ts'
import { ageOf, markdownTable } from './output.ts'
import { packageRoot, readConfig, resolveProject, watcherUrl } from './project.ts'
import type { WatchConfig } from '../server/config.ts'

export const STATUS_SPEC = { valueFlags: ['dir', 'output', 'url'], switchFlags: ['help', 'brief'] } as const
export const INCIDENTS_SPEC = {
  valueFlags: ['dir', 'output', 'url', 'severity', 'service', 'limit'],
  switchFlags: ['help', 'all', 'open']
} as const
export const TEST_ALERT_SPEC = { valueFlags: ['dir', 'output', 'url', 'channel'], switchFlags: ['help'] } as const
export const MCP_CONFIG_SPEC = { valueFlags: ['dir', 'output', 'url', 'client'], switchFlags: ['help', 'show-secret'] } as const

export interface ServerRef {
  base: string
  headers: Record<string, string>
}

/** The server this project's CLI talks to: --url, else WATCHER_HOST/PORT, else the config's port. */
export function serverRef(args: ParsedArgs, config: WatchConfig | null): ServerRef {
  const explicit = flagValue(args, 'url')
  if (explicit) return { base: explicit.replace(/\/+$/, ''), headers: authHeaders() }
  const port = Number(process.env.WATCHER_PORT ?? config?.port ?? 7717)
  const host = process.env.WATCHER_HOST ?? config?.host ?? '127.0.0.1'
  return { base: watcherUrl(host === '0.0.0.0' ? '127.0.0.1' : host, port), headers: authHeaders() }
}

function authHeaders(): Record<string, string> {
  const token = process.env.WATCHER_ADMIN_TOKEN
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function requestJson(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<{ status: number; body: unknown; text: string } | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    const text = await res.text().catch(() => '')
    let body: unknown = null
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = null
    }
    return { status: res.status, body, text }
  } catch {
    return null
  }
}

export function requireServer(answer: { status: number; body: unknown } | null, base: string, what: string): void {
  if (answer === null) {
    throw new CliError('server.down', `nothing answers at ${base}`, { next: 'Start it: `watcher run --detach`, then `watcher status`.' })
  }
  if (answer.status === 401) {
    throw new CliError('server.auth', `${base}${what} answered 401`, { next: 'Set WATCHER_ADMIN_TOKEN in .watcher/.env to the server\'s value.' })
  }
  if (answer.status !== 200) {
    throw new CliError('server.http', `${base}${what} answered HTTP ${answer.status}`, { next: 'Read .watcher/data/watcher.log.' })
  }
}

/**
 * `watcher status --brief`: what a session hook prints. At most ten lines: up to eight open incidents (severity, service,
 * title, age, key), a line for any overflow, and the closing hint. Nothing at all when the wall is green or the Watcher is
 * not running, and always exit 0: a hook must never block or fail a session.
 */
async function runBrief(args: ParsedArgs, out: Output): Promise<number> {
  try {
    const project = resolveProject(args.dir)
    const read = readConfig(project)
    if (!read.ok) return 0
    const ref = serverRef(args, read.config)
    const answer = await requestJson(`${ref.base}/api/state`, { headers: ref.headers })
    if (answer === null || answer.status !== 200) return 0
    const wall = answer.body as { incidents?: Array<Record<string, unknown>> }
    const open = (wall.incidents ?? []).filter((i) => {
      const state = (i.state ?? {}) as { firing?: boolean; attention?: string }
      return state.firing !== false && state.attention !== 'parked'
    })
    if (open.length === 0) return 0
    const max = 8
    const rows = open.slice(0, max).map((i) => {
      const rule = String(i.rule ?? '')
      const instance = typeof i.instance === 'string' && i.instance !== '' ? i.instance : null
      const title = instance === null ? rule : `${rule} on ${instance}`
      return {
        severity: String(i.severity ?? 'info'),
        service: String(i.service ?? ''),
        title,
        age: ageOf(typeof i.startsAt === 'string' ? i.startsAt : null),
        key: String(i.key ?? '')
      }
    })
    const hint = 'run `watcher incident <key> --fix-context` or the MCP tool get_fix_context'
    if (out.format === 'json') {
      out.json({ ok: true, count: open.length, incidents: rows, ...(open.length > max ? { more: open.length - max } : {}), hint })
      return 0
    }
    const lines = rows.map((r) => `${r.severity}  ${r.service}  ${r.title}  ${r.age}  ${r.key}`)
    if (open.length > max) lines.push(`+${open.length - max} more`)
    lines.push(hint)
    if (out.format === 'md') for (const line of lines) out.md(line)
    else for (const line of lines) out.line(line)
    return 0
  } catch {
    // A brief is a convenience: any failure is silence, never a session that cannot start.
    return 0
  }
}

export async function runStatus(args: ParsedArgs, out: Output): Promise<number> {
  if (args.switches.get('brief') === true) return runBrief(args, out)
  const project = resolveProject(args.dir)
  const read = readConfig(project)
  if (!read.ok) throw new CliError(read.error.code, read.error.message, { next: read.error.next })
  const ref = serverRef(args, read.config)
  const health = await requestJson(`${ref.base}/healthz`, { headers: ref.headers })
  if (health === null || health.status !== 200) {
    const result = { ok: false, server: { up: false, url: ref.base }, config: { sources: read.config.sources.length, channels: read.config.channels.length } }
    out.json(result)
    out.line(out.bad(`down`) + `  ${ref.base}`)
    out.line(`next     watcher run --detach`)
    return 1
  }
  const [summary, state] = await Promise.all([
    requestJson(`${ref.base}/api/summary`, { headers: ref.headers }),
    requestJson(`${ref.base}/api/state`, { headers: ref.headers })
  ])
  if (summary === null || summary.status !== 200 || state === null || state.status !== 200) {
    throw new CliError('server.api', `${ref.base} answered /healthz but not /api/summary and /api/state with 200`, { next: 'Read .watcher/data/watcher.log.' })
  }
  const sum = summary.body as {
    firing: number
    unattended: number
    acknowledged: number
    parked: number
    worst: string
    bySeverity: { page: number; warning: number; info: number }
    stale: boolean
  }
  const wall = state.body as {
    generatedAt: string
    sources: Array<Record<string, unknown>>
    channels: Array<Record<string, unknown>>
    incidents: Array<Record<string, unknown>>
  }
  const result = {
    ok: true,
    server: { up: true, url: ref.base },
    config: { sources: read.config.sources.length, channels: read.config.channels.length, routes: read.config.routes.length, port: process.env.WATCHER_PORT ?? read.config.port ?? 7717 },
    summary: sum,
    sources: wall.sources,
    channels: wall.channels,
    incidents: wall.incidents.length
  }
  out.json(result)
  out.line(`${out.bold('EZO Watcher')}  ${ref.base}  ${sum.stale ? out.warn('stale sources') : out.ok('up')}`)
  out.line(`firing ${sum.firing} (unattended ${sum.unattended}, acknowledged ${sum.acknowledged}, parked ${sum.parked})  worst ${out.severity(sum.worst)}  page ${sum.bySeverity.page} warning ${sum.bySeverity.warning} info ${sum.bySeverity.info}`)
  out.section('sources')
  out.table(
    wall.sources.map((s) => ({
      id: String(s.id),
      kind: String(s.kind),
      state: String(s.state),
      lastOk: ageOf(typeof s.lastOk === 'string' ? s.lastOk : null),
      firing: String(s.firing ?? 0),
      rules: String(s.rules ?? 0),
      error: typeof s.error === 'string' ? s.error : ''
    })),
    [
      { key: 'id', label: 'source', max: 24 },
      { key: 'kind', label: 'kind', max: 18 },
      { key: 'state', label: 'state', max: 8 },
      { key: 'lastOk', label: 'last ok', max: 8 },
      { key: 'firing', label: 'firing', max: 6 },
      { key: 'rules', label: 'rules', max: 5 },
      { key: 'error', label: 'error', max: 40 }
    ]
  )
  out.section('channels')
  out.table(
    wall.channels.map((c) => ({
      id: String(c.id),
      type: String(c.type),
      enabled: c.enabled === false ? 'no' : 'yes',
      lastTest: typeof c.lastTest === 'string' ? c.lastTest : '-'
    })),
    [
      { key: 'id', label: 'channel', max: 24 },
      { key: 'type', label: 'type', max: 10 },
      { key: 'enabled', label: 'enabled', max: 7 },
      { key: 'lastTest', label: 'last test', max: 14 }
    ]
  )
  out.md(`# ${read.config.brand?.name ?? 'EZO Watcher'} status`)
  out.md('')
  out.md(`- Server: ${ref.base} (up)`)
  out.md(`- Firing: ${sum.firing} (unattended ${sum.unattended}, acknowledged ${sum.acknowledged}, parked ${sum.parked}); worst: ${sum.worst}`)
  out.md(`- Stale sources: ${sum.stale ? 'yes' : 'no'}`)
  out.md('')
  out.md('## Sources')
  out.md(markdownTable(wall.sources.map((s) => ({ id: String(s.id), kind: String(s.kind), state: String(s.state), lastOk: ageOf(typeof s.lastOk === 'string' ? s.lastOk : null) })), [
    { key: 'id', label: 'source' },
    { key: 'kind', label: 'kind' },
    { key: 'state', label: 'state' },
    { key: 'lastOk', label: 'last ok' }
  ]))
  return 0
}

export async function runIncidents(args: ParsedArgs, out: Output): Promise<number> {
  const project = resolveProject(args.dir)
  const read = readConfig(project)
  if (!read.ok) throw new CliError(read.error.code, read.error.message, { next: read.error.next })
  const ref = serverRef(args, read.config)
  const answer = await requestJson(`${ref.base}/api/state`, { headers: ref.headers })
  requireServer(answer, ref.base, '/api/state')
  const wall = answer!.body as { generatedAt: string; incidents: Array<Record<string, unknown>> }
  const severity = flagValue(args, 'severity')
  const service = flagValue(args, 'service')
  const limit = numberFlag(args, 'limit', { min: 1, max: 1000 }) ?? 50
  const all = args.switches.get('all') === true
  // `--open` is the explicit spelling of the default: the live incidents, parked ones left out. `--all` keeps parked too, and an
  // explicit `--open` wins over a stray `--all` so a script never gets a parked row it did not ask for.
  const open = args.switches.get('open') === true
  const incidents = wall.incidents
    .filter((i) => (all && !open) || (i.state as { firing?: boolean })?.firing !== false)
    // The wall displays a humanized service ("App" for the id "app") and the caller may type either;
    // compare service names without case, the same way the events tile merges them.
    .filter((i) => severity === undefined || String(i.severity).toLowerCase() === severity.toLowerCase())
    .filter((i) => service === undefined || String(i.service).toLowerCase() === service.toLowerCase())
    .slice(0, limit)
  const result = { ok: true, generatedAt: wall.generatedAt, count: incidents.length, incidents }
  out.json(result)
  out.line(`${out.bold('incidents')} ${ref.base}  ${incidents.length} shown (generated ${wall.generatedAt})`)
  out.table(
    incidents.map((i) => {
      const state = (i.state ?? {}) as { attention?: string; firing?: boolean }
      const alerts = Array.isArray(i.alerts) ? i.alerts.length : 0
      return {
        severity: String(i.severity),
        service: String(i.service),
        rule: String(i.rule),
        instance: typeof i.instance === 'string' ? i.instance : '',
        since: ageOf(typeof i.startsAt === 'string' ? i.startsAt : null),
        attention: String(state.attention ?? (state.firing === false ? 'parked' : 'none')),
        alerts: String(alerts),
        key: String(i.key)
      }
    }),
    [
      { key: 'severity', label: 'severity', max: 9 },
      { key: 'service', label: 'service', max: 20 },
      { key: 'rule', label: 'rule', max: 28 },
      { key: 'instance', label: 'instance', max: 16 },
      { key: 'since', label: 'since', max: 7 },
      { key: 'attention', label: 'attention', max: 10 },
      { key: 'alerts', label: 'alerts', max: 6 },
      { key: 'key', label: 'key', max: 40 }
    ]
  )
  out.md(`# Incidents (${incidents.length})`)
  out.md('')
  out.md(markdownTable(incidents.map((i) => ({ severity: String(i.severity), service: String(i.service), rule: String(i.rule), since: ageOf(typeof i.startsAt === 'string' ? i.startsAt : null), key: String(i.key) })), [
    { key: 'severity', label: 'severity' },
    { key: 'service', label: 'service' },
    { key: 'rule', label: 'rule' },
    { key: 'since', label: 'since' },
    { key: 'key', label: 'key' }
  ]))
  return 0
}

export async function runTestAlert(args: ParsedArgs, out: Output): Promise<number> {
  const project = resolveProject(args.dir)
  const read = readConfig(project)
  if (!read.ok) throw new CliError(read.error.code, read.error.message, { next: read.error.next })
  const ref = serverRef(args, read.config)
  const only = flagValues(args, 'channel')
  const ids = only.length > 0 ? only : read.config.channels.map((c) => c.id)
  if (ids.length === 0) {
    throw new CliError('test-alert.no-channel', 'the config has no channel to test', { next: 'watcher add channel webhook --id hook --url-env WATCHER_WEBHOOK_URL' })
  }
  const unknown = ids.filter((id) => !read.config.channels.some((c) => c.id === id))
  if (unknown.length > 0) {
    throw new CliError('test-alert.unknown-channel', `no such channel: ${unknown.join(', ')}`, { next: `Configured channels: ${read.config.channels.map((c) => c.id).join(', ')}` })
  }
  const results: Array<{ channel: string; endpoint: string; ok: boolean; status: string; latencyMs: number }> = []
  for (const channel of ids) {
    const endpoint = '/api/test-notify'
    const answer = await requestJson(`${ref.base}${endpoint}`, {
      method: 'POST',
      headers: { ...ref.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ channel })
    })
    if (answer === null) {
      throw new CliError('server.down', `nothing answers at ${ref.base}`, { next: 'Start it: `watcher run --detach`.' })
    }
    if (answer.status === 401) {
      throw new CliError('server.auth', `${ref.base}${endpoint} answered 401`, { next: 'Set WATCHER_ADMIN_TOKEN in .watcher/.env to the server\'s value.' })
    }
    if (answer.status !== 200) {
      throw new CliError('test-alert.failed', `${ref.base}${endpoint} answered HTTP ${answer.status} for channel ${channel}`, { next: 'Read .watcher/data/watcher.log.' })
    }
    const body = (answer.body ?? {}) as { ok?: unknown; status?: unknown; latencyMs?: unknown }
    results.push({
      channel,
      endpoint,
      ok: body.ok === true,
      status: typeof body.status === 'string' ? body.status : body.ok === true ? 'sent' : 'failed',
      latencyMs: typeof body.latencyMs === 'number' ? body.latencyMs : 0
    })
  }
  const ok = results.every((r) => r.ok)
  out.json({ ok, results })
  out.line(`${ok ? out.ok('test alert sent') : out.bad('test alert failed')}  ${ref.base}`)
  out.table(
    results.map((r) => ({ channel: r.channel, ok: r.ok ? 'yes' : 'no', status: r.status, latencyMs: String(r.latencyMs), endpoint: r.endpoint })),
    [
      { key: 'channel', label: 'channel', max: 24 },
      { key: 'ok', label: 'ok', max: 3 },
      { key: 'status', label: 'status', max: 20 },
      { key: 'latencyMs', label: 'ms', max: 7 },
      { key: 'endpoint', label: 'endpoint', max: 24 }
    ]
  )
  out.md(`# Test alert`)
  out.md('')
  out.md(markdownTable(results.map((r) => ({ channel: r.channel, ok: r.ok ? 'yes' : 'no', status: r.status, ms: String(r.latencyMs) })), [
    { key: 'channel', label: 'channel' },
    { key: 'ok', label: 'ok' },
    { key: 'status', label: 'status' },
    { key: 'ms', label: 'ms' }
  ]))
  return ok ? 0 : 1
}

function assertClient(client: string): void {
  if (client !== 'claude' && client !== 'cursor' && client !== 'codex') {
    throw new CliError('mcp-config.unknown-client', `--client must be claude, cursor or codex, not ${JSON.stringify(client)}`, {
      exitCode: 64,
      next: 'Example: watcher mcp-config --client claude'
    })
  }
}

/** A project path as one shell argument: the stdio form is pasted into a shell, and a path may have a space. */
function shellArgument(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`
}

/**
 * The executable and arguments that start THIS CLI: the node that is running it plus its own `bin/watcher.mjs`.
 * A client started with this talks to the install the user actually has, never to a package name npm could
 * resolve to a stale cached copy (the live-run finding: `npx ezo-watcher` resolved a version with no `mcp` verb).
 */
export function runningCliInvocation(): { command: string; args: string[] } {
  const bin = join(packageRoot(), 'bin', 'watcher.mjs')
  if (existsSync(bin)) return { command: process.execPath, args: [bin] }
  // A package without its bin (a vendored bundle, a test harness): start the module that is running.
  return { command: process.execPath, args: [fileURLToPath(import.meta.url)] }
}

/**
 * The stdio form, which the `mcp-config` verb prints first: the client starts the executable this CLI is running
 * from (node + this install's bin) in the project, and that bridge reads the token from `.watcher/.env` itself.
 * No secret is in this form.
 */
export function mcpStdioConfigFor(client: string, projectDir: string): { kind: 'command' | 'json' | 'toml'; value: string } {
  assertClient(client)
  const cli = runningCliInvocation()
  const argv = [...cli.args, 'mcp', '--dir', projectDir]
  if (client === 'claude') {
    return { kind: 'command', value: `claude mcp add ezo-watcher -- ${shellArgument(cli.command)} ${cli.args.map(shellArgument).join(' ')} mcp --dir ${shellArgument(projectDir)}` }
  }
  if (client === 'cursor') {
    return { kind: 'json', value: JSON.stringify({ mcpServers: { 'ezo-watcher': { command: cli.command, args: argv } } }, null, 2) }
  }
  return {
    kind: 'toml',
    value: `[mcp_servers.ezo-watcher]\ncommand = ${JSON.stringify(cli.command)}\nargs = [${argv.map((a) => JSON.stringify(a)).join(', ')}]\n`
  }
}

/** The HTTP form (`<baseUrl>/mcp`), for a Watcher reached directly or behind a Cloudflare Tunnel: the self-hosted remote MCP. */
export function mcpConfigFor(client: string, url: string, token: string | null): { kind: 'command' | 'json' | 'toml'; value: string } {
  assertClient(client)
  const bearer = token ?? '$WATCHER_MCP_TOKEN'
  if (client === 'claude') {
    return {
      kind: 'command',
      value: `claude mcp add --transport http ezo-watcher ${url} --header "Authorization: Bearer ${bearer}"`
    }
  }
  if (client === 'cursor') {
    const auth = token ?? '${env:WATCHER_MCP_TOKEN}'
    return {
      kind: 'json',
      value: JSON.stringify({ mcpServers: { 'ezo-watcher': { url, headers: { Authorization: `Bearer ${auth}` } } } }, null, 2)
    }
  }
  return {
    kind: 'toml',
    value: `[mcp_servers.ezo-watcher]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "WATCHER_MCP_TOKEN"\n`
  }
}

export async function runMcpConfig(args: ParsedArgs, out: Output): Promise<number> {
  const client = flagValue(args, 'client') ?? 'claude'
  const project = resolveProject(args.dir)
  const read = readConfig(project)
  const ref = serverRef(args, read.ok ? read.config : null)
  const explicit = flagValue(args, 'url')?.replace(/\/+$/, '')
  const url = explicit ? (explicit.endsWith('/mcp') ? explicit : `${explicit}/mcp`) : `${ref.base}/mcp`
  const token = args.showSecret ? process.env.WATCHER_MCP_TOKEN ?? null : null
  const stdio = mcpStdioConfigFor(client, project.dir)
  const http = mcpConfigFor(client, url, token)
  const envPath = project.envPath
  const result = {
    ok: true,
    client,
    url,
    tokenEnv: 'WATCHER_MCP_TOKEN',
    secretShown: args.showSecret,
    /** The stdio form first: a client that starts a process talks to the running Watcher through the bridge. */
    stdio: stdio.value,
    /** Both registrations with their kind, for a script that wants one or the other. */
    forms: { stdio: { kind: stdio.kind, value: stdio.value }, http: { kind: http.kind, value: http.value } },
    ...(existsSync(envPath) ? { envFile: envPath } : {})
  }
  out.json(result)
  out.line(`${out.bold('MCP')} ${client} -> ${project.dir} (stdio) and ${url} (HTTP)`)
  out.line('')
  out.line(out.bold('stdio: local process, first'))
  out.line(stdio.value)
  out.line('')
  out.line(out.bold('HTTP: remote or shared, second'))
  out.line(http.value)
  if (!args.showSecret) out.line('')
  if (!args.showSecret) out.line(out.dim('The token value is not printed. Add --show-secret to print it.'))
  out.md(`# MCP: ${client}`)
  out.md('')
  out.md('## stdio (local process, first)')
  out.md('```')
  out.md(stdio.value)
  out.md('```')
  out.md('')
  out.md('## HTTP (remote or shared, second)')
  out.md('```')
  out.md(http.value)
  out.md('```')
  return 0
}
