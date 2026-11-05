// `watcher add`: the only way a source or a channel should reach .watcher/config.json. Every write
// goes through the server's own `validateConfig`, so the CLI cannot accept a document the server
// would refuse at boot, and no secret ever reaches the config: a credential is named by the env var
// that holds it, and the value goes to .watcher/.env (0600) only — `--secret-value` when given, or a
// freshly minted secret for an inbound ping/push token the project shares with itself (heartbeat,
// webhook), so the first ping cannot be a 401 for a token nobody ever generated (#94).
//
// The kind list is not a hardcoded allowlist. The source registry (POLLED in src/server) decides
// which kinds the server polls, and this module adds a builder for each kind it knows how to
// assemble; a kind that has no builder yet (the sources root's tcp-probe, heartbeat, domain-expiry)
// is still accepted whenever `validateConfig` accepts the assembled document. That is deliberate:
// the CLI ships before every source kind does, and a config written today must keep working when
// the kind lands.

import type { ParsedArgs } from './util.ts'
import { CliError, flagValue, flagValues, jsonFlag, numberFlag, requireFlag, slugify, usageError } from './util.ts'
import type { Output } from './output.ts'
import {
  cliVersion,
  managedHash,
  newSecret,
  packageRoot,
  readConfig,
  readEnvVars,
  resolveProject,
  writeConfig,
  writeEnvVars
} from './project.ts'
import { POLLED } from '../server/source-registry.ts'
import { validateConfig } from '../server/config.ts'

export const ADD_SPEC = {
  valueFlags: [
    'dir', 'output', 'id', 'service', 'url', 'host', 'port', 'expect-json', 'expect-status', 'slow-ms',
    'interval', 'poll-sec', 'fail-after', 'token-env', 'stale-after-sec', 'presence-ttl-sec',
    'recheck-pickup-sec', 'origin', 'timeout-ms', 'public-url', 'org', 'projects', 'project', 'web-url',
    'space-id', 'room-id', 'fleet-nodes', 'every', 'schedule', 'grace', 'timezone', 'name', 'domain', 'url-env',
    'server', 'topic-env', 'api-key-env', 'from-env', 'to-env', 'from', 'provider',
    'public-key-env', 'private-key-env', 'subject', 'header', 'secret-value', 'set', 'path',
    'self-server', 'self-url-env', 'self-topic-env', 'self-token-env', 'primary-env', 'base-url',
    'found-at', 'read', 'mount', 'pid-file', 'warn-days', 'page-days',
    // declared so an inline secret is refused with a next, not an unknown-flag error
    'token', 'api-key', 'password', 'secret', 'webhook-secret'
  ],
  switchFlags: ['dry-run', 'help', 'replace', 'optional', 'tls'],
  subVerbs: ['channel']
} as const

/** The same id rule the server enforces for probe targets: safe in a URL, a filename and a log line. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface BuildContext {
  id: string
  service: string
  args: ParsedArgs
  /** The id made env-var-safe: `prod` -> `API_PROD`. */
  envId: string
}

type Builder = (ctx: BuildContext) => Record<string, unknown>

/** The source kinds this module can assemble today. Anything else goes through the generic builder. */
export const SOURCE_BUILDERS: Record<string, Builder> = {
  'http-probe': (ctx) => {
    const target: Record<string, unknown> = { id: ctx.id, service: ctx.service, url: requireFlag(ctx.args, 'url', 'the URL the probe GETs') }
    const expectJson = jsonFlag(ctx.args, 'expect-json')
    if (expectJson) target.expectJson = expectJson
    const expectStatus = numberFlag(ctx.args, 'expect-status', { min: 100, max: 599 })
    if (expectStatus !== undefined) target.expectStatus = expectStatus
    const slowMs = numberFlag(ctx.args, 'slow-ms', { min: 1 })
    if (slowMs !== undefined) target.slowMs = slowMs
    const source: Record<string, unknown> = { id: ctx.id, type: 'http-probe', targets: [target] }
    commonSourceFlags(ctx, source)
    return source
  },
  'tcp-probe': (ctx) => {
    const target: Record<string, unknown> = { id: ctx.id, service: ctx.service, host: requireFlag(ctx.args, 'host', 'the host whose port is dialled'), port: requireFlagNumber(ctx.args, 'port', 1, 65535) }
    if (ctx.args.switches.get('tls') === true) target.tls = true
    const source: Record<string, unknown> = { id: ctx.id, type: 'tcp-probe', targets: [target] }
    commonSourceFlags(ctx, source)
    return source
  },
  heartbeat: (ctx) => {
    // The server's heartbeat config takes `every`/`grace` as DURATION STRINGS ("30s", "5m", "2h",
    // "1d") and `schedule` as a five-field crontab, exactly one of every/schedule. Numbers are
    // refused here with the shape, not written as `everySec` (the pre-#36 CLI bug).
    const every = flagValue(ctx.args, 'every')
    const schedule = flagValue(ctx.args, 'schedule')
    if (every === undefined && schedule === undefined) {
      throw usageError('add.heartbeat-needs-cadence', 'a heartbeat needs --every <duration> or --schedule "<cron>"', 'Example: watcher add heartbeat --id nightly --every 24h --grace 5m')
    }
    if (every !== undefined && schedule !== undefined) {
      throw usageError('add.heartbeat-two-cadences', 'a heartbeat takes --every or --schedule, not both', 'Pick one: --every 24h, or --schedule "0 4 * * *" --timezone America/Chicago')
    }
    const source: Record<string, unknown> = { id: ctx.id, type: 'heartbeat' }
    if (every !== undefined) source.every = durationString(ctx.args, 'every', every)
    if (schedule !== undefined) {
      const cron = schedule.trim().split(/\s+/)
      if (cron.length !== 5) throw usageError('usage.bad-cron', `--schedule must be a five-field crontab, not ${JSON.stringify(schedule)}`, 'Example: --schedule "0 4 * * *"')
      source.schedule = cron.join(' ')
    }
    const timezone = flagValue(ctx.args, 'timezone')
    if (timezone !== undefined) {
      if (schedule === undefined) throw usageError('add.heartbeat-timezone', '--timezone only applies to --schedule', 'Drop --timezone, or use --schedule "<cron>" --timezone America/Chicago')
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone })
      } catch {
        throw usageError('usage.bad-timezone', `--timezone must be an IANA zone such as America/Chicago, not ${JSON.stringify(timezone)}`, 'Example: --timezone America/Chicago')
      }
      source.timezone = timezone
    }
    const grace = flagValue(ctx.args, 'grace')
    if (grace !== undefined) source.grace = durationString(ctx.args, 'grace', grace)
    const name = flagValue(ctx.args, 'name')
    if (name !== undefined && name.trim() !== '') source.name = name.trim()
    const tokenEnv = flagValue(ctx.args, 'token-env')
    source.tokenEnv = tokenEnv ?? `${ctx.envId}_TOKEN`
    copyIfSet(ctx, source, 'service', flagValue(ctx.args, 'service'))
    return source
  },
  webhook: (ctx) => {
    const source: Record<string, unknown> = { id: ctx.id, type: 'webhook', tokenEnv: secretEnvName(ctx, 'token-env') }
    const stale = numberFlag(ctx.args, 'stale-after-sec', { min: 1 })
    if (stale !== undefined) source.staleAfterSec = stale
    const ttl = numberFlag(ctx.args, 'presence-ttl-sec', { min: 1 })
    if (ttl !== undefined) source.presenceTtlSec = ttl
    const pickup = numberFlag(ctx.args, 'recheck-pickup-sec', { min: 30, max: 3600 })
    if (pickup !== undefined) source.recheckRequests = { pickupWithinSec: pickup }
    return source
  },
  feed: (ctx) => {
    const source: Record<string, unknown> = {
      id: ctx.id,
      type: 'feed',
      url: requireFlag(ctx.args, 'url', 'the URL that answers the push body'),
      tokenEnv: secretEnvName(ctx, 'token-env')
    }
    copyIfSet(ctx, source, 'origin', flagValue(ctx.args, 'origin'))
    copyNumber(ctx, source, 'pollSec', numberFlag(ctx.args, 'poll-sec', { min: 1 }))
    copyNumber(ctx, source, 'timeoutMs', numberFlag(ctx.args, 'timeout-ms', { min: 100, max: 60_000 }))
    return source
  },
  sentry: (ctx) => {
    const url = flagValue(ctx.args, 'url') ?? 'https://sentry.io'
    const projects = parsePairs([...flagValues(ctx.args, 'project'), ...flagValues(ctx.args, 'projects')].filter((p) => p !== '').join(','))
    const source: Record<string, unknown> = {
      id: ctx.id,
      type: 'sentry',
      url,
      webUrl: flagValue(ctx.args, 'web-url') ?? url,
      org: requireFlag(ctx.args, 'org', 'the Sentry organization slug'),
      tokenEnv: secretEnvName(ctx, 'token-env'),
      pollSec: numberFlag(ctx.args, 'poll-sec', { min: 1, fallback: 120 }),
      projects
    }
    return source
  },
  grafana: (ctx) => {
    const source: Record<string, unknown> = {
      id: ctx.id,
      type: 'grafana',
      url: requireFlag(ctx.args, 'url', 'the Grafana base URL'),
      tokenEnv: secretEnvName(ctx, 'token-env'),
      pollSec: numberFlag(ctx.args, 'poll-sec', { min: 1, fallback: 30 })
    }
    copyIfSet(ctx, source, 'publicUrl', flagValue(ctx.args, 'public-url'))
    return source
  },
  vmalert: (ctx) => ({
    id: ctx.id,
    type: 'vmalert',
    url: requireFlag(ctx.args, 'url', 'the VictoriaMetrics base URL'),
    pollSec: numberFlag(ctx.args, 'poll-sec', { min: 1, fallback: 30 })
  }),
  'netdata-cloud': (ctx) => ({
    id: ctx.id,
    type: 'netdata-cloud',
    url: flagValue(ctx.args, 'url') ?? 'https://app.netdata.cloud',
    tokenEnv: secretEnvName(ctx, 'token-env'),
    spaceId: requireFlag(ctx.args, 'space-id', 'the Netdata Cloud space id'),
    roomId: requireFlag(ctx.args, 'room-id', 'the Netdata Cloud room id'),
    fleetNodes: parseList(requireFlag(ctx.args, 'fleet-nodes', 'comma-separated hostnames')),
    pollSec: numberFlag(ctx.args, 'poll-sec', { min: 1, fallback: 60 })
  }),
  'netdata-fleet': (ctx) => ({
    id: ctx.id,
    type: 'netdata-fleet',
    url: flagValue(ctx.args, 'url') ?? 'https://app.netdata.cloud',
    tokenEnv: secretEnvName(ctx, 'token-env'),
    spaceId: requireFlag(ctx.args, 'space-id', 'the Netdata Cloud space id'),
    roomId: requireFlag(ctx.args, 'room-id', 'the Netdata Cloud room id'),
    fleetNodes: parseList(requireFlag(ctx.args, 'fleet-nodes', 'comma-separated hostnames')),
    pollSec: numberFlag(ctx.args, 'poll-sec', { min: 1, fallback: 60 })
  }),
  host: (ctx) => {
    // The machine this Watcher runs on: load per core, memory available, free space per mount and, when given, one process by pid file.
    const source: Record<string, unknown> = { id: ctx.id, type: 'host' }
    const mounts = flagValues(ctx.args, 'mount')
    if (mounts.length > 0) source.mounts = mounts
    copyIfSet(ctx, source, 'service', flagValue(ctx.args, 'service'))
    copyIfSet(ctx, source, 'pidFile', flagValue(ctx.args, 'pid-file'))
    copyNumber(ctx, source, 'pollSec', numberFlag(ctx.args, 'poll-sec', { min: 1 }))
    return source
  },
  'domain-expiry': (ctx) => {
    const domains = flagValues(ctx.args, 'domain')
    if (domains.length === 0) throw usageError('add.domain-needed', 'a domain-expiry source needs --domain <name>', 'Example: watcher add domain-expiry --id domains --domain example.com')
    const source: Record<string, unknown> = { id: ctx.id, type: 'domain-expiry', domains }
    copyNumber(ctx, source, 'warnDays', numberFlag(ctx.args, 'warn-days', { min: 1, max: 3650 }))
    copyNumber(ctx, source, 'pageDays', numberFlag(ctx.args, 'page-days', { min: 0, max: 3650 }))
    copyNumber(ctx, source, 'pollSec', numberFlag(ctx.args, 'poll-sec', { min: 1 }))
    return source
  }
}

/** A kind the sources root has not shipped a builder for: assemble the common fields and let validateConfig judge. */
function genericBuilder(kind: string): Builder {
  return (ctx) => {
    const source: Record<string, unknown> = { id: ctx.id, type: kind }
    copyIfSet(ctx, source, 'url', flagValue(ctx.args, 'url'))
    copyNumber(ctx, source, 'pollSec', numberFlag(ctx.args, 'poll-sec', { min: 1 }))
    const tokenEnv = flagValue(ctx.args, 'token-env')
    if (tokenEnv) source.tokenEnv = tokenEnv
    return source
  }
}

/** Flags every polled source shares. */
function commonSourceFlags(ctx: BuildContext, source: Record<string, unknown>): void {
  const every = numberFlag(ctx.args, 'interval', { min: 1 })
  const poll = numberFlag(ctx.args, 'poll-sec', { min: 1 })
  const chosen = poll ?? every
  if (chosen !== undefined) source.pollSec = chosen
  const failAfter = numberFlag(ctx.args, 'fail-after', { min: 1, max: 20 })
  if (failAfter !== undefined) source.failAfter = failAfter
}

function copyIfSet(_ctx: BuildContext, target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined && value !== '') target[key] = value
}

function copyNumber(_ctx: BuildContext, target: Record<string, unknown>, key: string, value: number | undefined): void {
  if (value !== undefined) target[key] = value
}

/**
 * A duration the server's heartbeat accepts: 1-7 digits and a unit, "30s", "5m", "2h", "1d". A bare
 * number is refused with the shape, because "86400" (or the old everySec spelling) is not what the
 * validator reads.
 */
export function durationString(args: ParsedArgs, flag: string, raw: string): string {
  const text = raw.trim()
  if (!/^\d{1,7}(s|m|h|d)$/.test(text) || text.startsWith('0')) {
    throw usageError('usage.bad-duration', `--${flag} must be a duration like 30s, 5m, 2h or 1d, not ${JSON.stringify(raw)}`, `Example: --${flag} 5m`)
  }
  return text
}

/** Seconds as the shortest duration string the server accepts, for scan's heartbeat suggestions. */
export function durationOfSeconds(seconds: number): string {
  const sec = Math.max(1, Math.round(seconds))
  if (sec % 86_400 === 0 && sec / 86_400 <= 9_999_999) return `${sec / 86_400}d`
  if (sec % 3_600 === 0 && sec / 3_600 <= 9_999_999) return `${sec / 3_600}h`
  if (sec % 60 === 0 && sec / 60 <= 9_999_999) return `${sec / 60}m`
  return `${Math.min(sec, 9_999_999)}s`
}

function requireFlagNumber(args: ParsedArgs, name: string, min: number, max: number): number {
  const v = numberFlag(args, name, { min, max })
  if (v === undefined) throw usageError('usage.missing-flag', `--${name} is required`, `Add --${name} <number from ${min} to ${max}>.`)
  return v
}

function parseList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
}

function parsePairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of parseList(raw)) {
    const at = pair.indexOf('=')
    if (at <= 0 || at === pair.length - 1) throw usageError('add.bad-pair', `expected slug=tile, got ${JSON.stringify(pair)}`, 'Example: --projects web=web,api=api')
    out[pair.slice(0, at)] = pair.slice(at + 1)
  }
  if (Object.keys(out).length === 0) throw usageError('add.bad-pair', 'no project given', 'Example: --projects web=web')
  return out
}

function applySet(target: Record<string, unknown>, pair: string): void {
  const at = pair.indexOf('=')
  if (at <= 0) throw usageError('add.bad-set', `--set needs path=value, got ${JSON.stringify(pair)}`, 'Example: --set pollSec=30 or --set targets.0.host=db.example.com')
  const path = pair.slice(0, at)
  const rawValue = pair.slice(at + 1)
  let value: unknown = rawValue
  try {
    value = JSON.parse(rawValue) as unknown
  } catch {
    value = rawValue
  }
  const steps = path.split('.')
  let node: Record<string, unknown> | unknown[] = target
  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i]
    if (Array.isArray(node) && /^\d+$/.test(step)) {
      const index = Number(step)
      if (typeof node[index] !== 'object' || node[index] === null) node[index] = {}
      node = node[index] as Record<string, unknown>
    } else if (typeof node === 'object' && node !== null) {
      const rec = node as Record<string, unknown>
      if (typeof rec[step] !== 'object' || rec[step] === null) rec[step] = {}
      node = rec[step] as Record<string, unknown>
    }
  }
  const last = steps[steps.length - 1]
  if (Array.isArray(node) && /^\d+$/.test(last)) node[Number(last)] = value
  else if (typeof node === 'object' && node !== null) (node as Record<string, unknown>)[last] = value
}

/** The env var that holds a source's secret: --token-env, or `<ID>_TOKEN` when only --secret-value supplies a value. */
function secretEnvName(ctx: BuildContext, flag: string): string {
  const explicit = flagValue(ctx.args, flag)
  if (explicit) return explicit
  const supplied = flagValue(ctx.args, 'secret-value')
  if (supplied !== undefined) return `${ctx.envId}_TOKEN`
  throw usageError('add.token-env-needed', `this kind needs --token-env <ENV_VAR_NAME> (the name, never the value)`, `Example: --token-env ${ctx.envId}_TOKEN --secret-value <value>`)
}

// ---- channels ----------------------------------------------------------------------------------------

export const CHANNEL_BUILDERS: Record<string, Builder> = {
  file: (ctx) => {
    // No credential, no network: one JSON line per notification appended to a path under the project.
    const channel: Record<string, unknown> = { id: ctx.id, type: 'file' }
    const path = flagValue(ctx.args, 'path')
    if (path !== undefined && path.trim() !== '') channel.path = path.trim()
    return channel
  },
  webhook: (ctx) => {
    const channel: Record<string, unknown> = { id: ctx.id, type: 'webhook', urlEnv: requireFlag(ctx.args, 'url-env', 'the env var holding the webhook URL') }
    const headers = flagValues(ctx.args, 'header')
    if (headers.length > 0) {
      const map: Record<string, string> = {}
      for (const h of headers) {
        const at = h.indexOf(':')
        if (at <= 0) throw usageError('add.bad-header', `--header needs Name:value, got ${JSON.stringify(h)}`, 'Example: --header X-Api-Key:secret')
        map[h.slice(0, at).trim()] = h.slice(at + 1).trim()
      }
      channel.headers = map
    }
    return channel
  },
  ntfy: (ctx) => {
    const channel: Record<string, unknown> = {
      id: ctx.id,
      type: 'ntfy',
      server: flagValue(ctx.args, 'server') ?? 'https://ntfy.sh',
      topicEnv: secretEnvName(ctx, 'topic-env')
    }
    const tokenEnv = flagValue(ctx.args, 'token-env')
    if (tokenEnv) channel.tokenEnv = tokenEnv
    const primaryEnv = flagValue(ctx.args, 'primary-env')
    if (primaryEnv) channel.primaryEnv = primaryEnv
    const selfUrlEnv = flagValue(ctx.args, 'self-url-env')
    const selfTopicEnv = flagValue(ctx.args, 'self-topic-env')
    if (selfUrlEnv || selfTopicEnv) {
      channel.self = {
        urlEnv: selfUrlEnv ?? 'WATCHER_NTFY_SELF_URL',
        topicEnv: selfTopicEnv ?? 'WATCHER_NTFY_SELF_TOPIC',
        tokenEnv: flagValue(ctx.args, 'self-token-env') ?? 'WATCHER_NTFY_SELF_TOKEN'
      }
    }
    return channel
  },
  email: (ctx) => ({
    id: ctx.id,
    type: 'email',
    provider: 'resend',
    apiKeyEnv: secretEnvName(ctx, 'api-key-env'),
    from: requireFlag(ctx.args, 'from', 'the From address (not a secret)'),
    toEnv: requireFlag(ctx.args, 'to-env', 'the env var holding the comma-separated recipients')
  }),
  sms: (ctx) => ({
    id: ctx.id,
    type: 'sms',
    provider: flagValue(ctx.args, 'provider') ?? 'telnyx',
    apiKeyEnv: secretEnvName(ctx, 'api-key-env'),
    fromEnv: requireFlag(ctx.args, 'from-env', 'the env var holding the sender number'),
    toEnv: requireFlag(ctx.args, 'to-env', 'the env var holding the comma-separated recipients')
  }),
  webpush: (ctx) => ({
    id: ctx.id,
    type: 'webpush',
    publicKeyEnv: requireFlag(ctx.args, 'public-key-env', 'the env var holding the VAPID public key'),
    privateKeyEnv: requireFlag(ctx.args, 'private-key-env', 'the env var holding the VAPID private key'),
    subject: flagValue(ctx.args, 'subject') ?? 'mailto:you@example.com'
  })
}

// ---- the verb ----------------------------------------------------------------------------------------

export interface BuiltAdd {
  isChannel: boolean
  kind: string
  id: string
  replace: boolean
  optional: boolean
  built: Record<string, unknown>
  ctx: BuildContext
}

/** Parse an `add` argument list into the document it would write. Pure: no project is read and nothing is written, so a doc test
 * can call it to prove a documented command names its required flags. */
export function buildAdd(args: ParsedArgs): BuiltAdd {
  const isChannel = args.sub === 'channel'
  const kind = args.positionals[0]
  if (!kind) {
    throw usageError(
      'usage.missing-kind',
      isChannel ? 'add channel needs a channel type' : 'add needs a source kind',
      isChannel ? `watcher add channel <${Object.keys(CHANNEL_BUILDERS).join('|')}> --id <id> …` : 'watcher add http-probe --id api --url https://api.example.com/healthz'
    )
  }
  const id = requireFlag(args, 'id', 'the source or channel id every surface uses')
  if (!SAFE_ID.test(id)) throw usageError('add.bad-id', `id ${JSON.stringify(id)} is not safe: letters, digits, dots, dashes and underscores, at most 64`, 'Example: --id prod')
  refuseInlineSecret(args)
  const replace = args.switches.get('replace') === true
  const optional = args.switches.get('optional') === true
  if (isChannel && optional) throw usageError('add.optional-channel', '--optional is a source flag: a channel without its credential is already left out and reported', 'Drop --optional, or add it to a source: watcher add <kind> --id <id> --optional')

  const builders: Record<string, Builder> = isChannel ? CHANNEL_BUILDERS : SOURCE_BUILDERS
  if (isChannel && !builders[kind]) {
    throw usageError('add.unknown-channel', `unknown channel type ${JSON.stringify(kind)}`, `Use one of: ${Object.keys(CHANNEL_BUILDERS).join(', ')}`)
  }
  const ctx: BuildContext = {
    id,
    service: flagValue(args, 'service') ?? id,
    args,
    envId: id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  }
  const builder = builders[kind] ?? genericBuilder(kind)
  const built = builder(ctx)
  // --set is a path into the built document for every kind (docs use it for host mounts), so it applies after the builder.
  for (const pair of flagValues(args, 'set')) applySet(built, pair)
  // `discovered` (#29) is a source-level provenance note, never a channel field.
  if (!isChannel) {
    if (optional) built.optional = true
    const foundAt = flagValue(args, 'found-at')
    const read = flagValue(args, 'read')
    if (foundAt !== undefined || read !== undefined) {
      built.discovered = { ...(foundAt !== undefined ? { foundAt } : {}), ...(read !== undefined ? { read } : {}) }
    }
  }
  return { isChannel, kind, id, replace, optional, built, ctx }
}

/** Parse-only validation, for the docs test: the same parse and the same builder, no project read, no write. */
export function validateAdd(args: ParsedArgs): void {
  buildAdd(args)
}

export async function runAdd(args: ParsedArgs, out: Output): Promise<number> {
  const project = resolveProject(args.dir)
  const { isChannel, kind, id, replace, built } = buildAdd(args)

  const readResult = readConfig(project)
  if (!readResult.ok) throw new CliError(readResult.error.code, readResult.error.message, { next: readResult.error.next })
  const raw = readResult.raw
  const sources = (raw.sources ?? []) as Array<Record<string, unknown>>
  const channels = (raw.channels ?? []) as Array<Record<string, unknown>>
  const routes = (raw.routes ?? []) as Array<Record<string, unknown>>

  const clashSource = sources.findIndex((x) => x.id === id)
  const clashChannel = channels.findIndex((x) => x.id === id)
  const clash = clashSource >= 0 ? sources[clashSource] : clashChannel >= 0 ? channels[clashChannel] : null
  if (clash && !replace) {
    throw new CliError('add.duplicate-id', `id ${id} is already used by a ${String(clash.type)} in ${project.configPath}`, {
      next: `Re-run with --replace to rewrite that entry, or pick another id: watcher add ${isChannel ? 'channel ' : ''}${kind} --id ${id}-2 …`
    })
  }
  const replaced = clash !== null

  let nextRoutes = routes
  if (isChannel) {
    if (clashSource >= 0) sources.splice(clashSource, 1)
    if (clashChannel >= 0) channels[clashChannel] = built
    else channels.push(built)
    if (routes.length === 0) {
      nextRoutes = [{
        id: 'default',
        match: {},
        receivers: [id],
        mode: 'ladder',
        groupWaitSec: 0,
        groupIntervalSec: 120,
        repeatIntervalSec: 1800,
        sendResolved: true
      }]
    }
  } else {
    if (clashChannel >= 0) channels.splice(clashChannel, 1)
    if (clashSource >= 0) sources[clashSource] = built
    else sources.push(built)
  }
  const candidate: Record<string, unknown> = { ...raw, sources, channels, routes: nextRoutes }
  candidate._meta = { writer: 'watcher', version: cliVersion(), sha256: managedHash(candidate) }

  if (!args.dryRun) {
    const written = writeConfig(project, candidate)
    if (!written.ok) throw new CliError(written.error.code, written.error.message, { next: written.error.next })
  } else {
    const checked = validateConfig(candidate)
    if (!checked.ok) throw new CliError('config.invalid', checked.errors.join('; '), { next: 'Fix the fields named above and run the command again.' })
  }

  // --secret-value: the value goes to .watcher/.env (0600) and nowhere else.
  const secretValue = flagValue(args, 'secret-value')
  let secretName: string | null = null
  let secretGenerated = false
  if (secretValue !== undefined) {
    secretName = firstEnvName(built)
    if (!secretName) {
      throw new CliError('add.no-secret-slot', `${kind} names no env var to hold --secret-value`, {
        next: 'Pass the value through an env var yourself: add it to .watcher/.env and reference it with --token-env <NAME>.'
      })
    }
    if (!args.dryRun) writeEnvVars(project.envPath, { [secretName]: secretValue })
  } else {
    // A ping/push token is a secret this project shares with itself: heartbeat and webhook authenticate an
    // INBOUND request, so the Watcher and its own sender only have to agree on the value. When .watcher/.env
    // holds none yet, mint it here (the same shape `init` writes), so the first ping is not a 401. A token
    // the CLI only READS (sentry, grafana, netdata, feed) belongs to the vendor and is never minted.
    const mintName = mintableTokenName(isChannel, kind, built)
    if (mintName !== null && !hasEnvValue(project.envPath, mintName)) {
      secretName = mintName
      secretGenerated = true
      if (!args.dryRun) writeEnvVars(project.envPath, { [mintName]: newSecret() })
    }
  }
  if (args.dryRun && secretName !== null) out.note(`would write ${secretName}${secretGenerated ? ' (generated)' : ''} to .watcher/.env (0600)`)

  // A heartbeat is the one kind whose reader is the job itself: print the exact URLs it pings, built from its token env var.
  const pings = !isChannel && kind === 'heartbeat' ? heartbeatPings(raw, id, typeof built.tokenEnv === 'string' ? built.tokenEnv : `${id.toUpperCase()}_TOKEN`) : null
  const summary = {
    ok: true,
    dryRun: args.dryRun,
    wrote: isChannel ? 'channel' : 'source',
    replaced,
    id,
    kind,
    configPath: project.configPath,
    ...(secretName ? { secretEnv: secretName } : {}),
    ...(secretGenerated ? { secretGenerated: true } : {}),
    ...(pings ? { ping: pings.ok, pingFail: pings.fail, pingExit: pings.exit } : {}),
    ...(isChannel && routes.length === 0 ? { defaultRoute: 'default' } : {}),
    next: ['watcher doctor']
  }
  out.json(summary)
  out.line(`${out.ok(replaced ? 'replaced' : 'added')} ${isChannel ? 'channel' : 'source'} ${out.bold(id)} (${kind}) to ${project.configPath}`)
  if (isChannel && routes.length === 0) out.line(`route   default -> ${id} (the first channel becomes the default route)`)
  if (secretName) out.line(`secret  ${secretName} ${secretGenerated ? 'generated and ' : ''}written to .watcher/.env (0600); the value is not in the config`)
  if (pings) {
    out.line(`ping    ${pings.ok}`)
    out.line(`        curl -fsS -m 10 "${pings.ok}"   # in the job, after a successful run`)
    out.line(`        curl -fsS -m 10 "${pings.fail}"   # after a failed run`)
    out.line(`        curl -fsS -m 10 "${pings.exit}"   # with the job's exit code (0 is a success)`)
  }
  out.line(`next    watcher doctor${isChannel ? '' : ' --live'}${args.dryRun ? '   (dry run: the config was not changed)' : ''}`)
  return 0
}

/** The URLs a heartbeat's job pings: this Watcher's public base URL (else loopback and its port), the source id, and the token env var by reference. */
function heartbeatPings(raw: Record<string, unknown>, id: string, tokenEnv: string): { ok: string; fail: string; exit: string } {
  let origin = 'http://127.0.0.1:7717'
  try {
    if (typeof raw.baseUrl === 'string') origin = new URL(raw.baseUrl).origin
  } catch {
    // the config validator owns baseUrl; a bad one is refused before this runs
  }
  const url = (action: string): string => `${origin}/ingest/heartbeat/${id}${action}?token=$${tokenEnv}`
  return { ok: url(''), fail: url('/fail'), exit: url('/<exit-code>') }
}

/** The token env var `add` can mint a value for, or null: an inbound source's token, under a name an env file can hold. */
function mintableTokenName(isChannel: boolean, kind: string, built: Record<string, unknown>): string | null {
  // heartbeat and webhook both authenticate a request INTO this Watcher; the value only has to match inside this project.
  if (isChannel || (kind !== 'heartbeat' && kind !== 'webhook')) return null
  const name = built.tokenEnv
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null
}

/** True when .watcher/.env already holds a non-empty value for `name`. */
function hasEnvValue(envPath: string, name: string): boolean {
  const value = readEnvVars(envPath).get(name)
  return value !== undefined && value !== ''
}

function firstEnvName(built: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(built)) {
    if (key.endsWith('Env') && typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value
  }
  if (typeof built.self === 'object' && built.self !== null) {
    for (const [key, value] of Object.entries(built.self as Record<string, unknown>)) {
      if (key.endsWith('Env') && typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value
    }
  }
  return null
}

/** An inline secret flag is refused with the one flag that does write a secret, and where it writes it. */
function refuseInlineSecret(args: ParsedArgs): void {
  for (const name of ['token', 'api-key', 'password', 'secret', 'webhook-secret']) {
    const value = flagValue(args, name)
    if (value === undefined) continue
    throw usageError(
      'add.inline-secret',
      `--${name} would put a secret on the command line (and in shell history); the config stores env-var NAMES, never values`,
      `Use --secret-value <value>: it writes the value to .watcher/.env (0600) and the name into the config.`
    )
  }
}

/** The source kinds to offer in help: what the server polls, what this module can build, and the documented kinds still landing. */
export function listSourceKinds(): string[] {
  const kinds = new Set<string>([...Object.keys(SOURCE_BUILDERS), ...Object.keys(POLLED), 'tcp-probe', 'heartbeat', 'domain-expiry'])
  return [...kinds].sort()
}

/** The channel types to offer in help. */
export function listChannelTypes(): string[] {
  return Object.keys(CHANNEL_BUILDERS)
}

/** The package root, re-exported for the help text (a watcher installed globally still finds its own docs). */
export function addPackageRoot(): string {
  return packageRoot()
}

/** A suggested id from a URL or a schedule, for scan's proposed commands. */
export function suggestId(text: string): string {
  return slugify(text)
}

// ---- per-kind help -----------------------------------------------------------------------------------

/**
 * The flags each kind takes, for `watcher add <kind> --help`. The skill and the references defer to
 * this list as authoritative, so it is part of the CLI's contract, not decoration.
 */
export const SOURCE_KIND_FLAGS: Record<string, string[]> = {
  'http-probe': ['--id <id>', '--url <url>', '--expect-json \'{"path":"value"}\'', '--expect-status <n>', '--slow-ms <ms>', '--poll-sec <s>', '--fail-after <n>', '--service <tile>', '--found-at <file:line>', '--read "<what the route proves>"'],
  'tcp-probe': ['--id <id>', '--host <host>', '--port <n>', '--tls', '--poll-sec <s>', '--fail-after <n>', '--service <tile>'],
  heartbeat: ['--id <id>', '--every <duration: 30s|5m|2h|1d>', '--schedule "<five-field cron>"', '--timezone <IANA zone>', '--grace <duration>', '--name <name>', '--token-env <ENV_NAME> (minted into .watcher/.env when it has no value)', '--service <tile>', '--secret-value <value>'],
  webhook: ['--id <id>', '--token-env <ENV_NAME> (minted into .watcher/.env when it has no value)', '--stale-after-sec <s>', '--presence-ttl-sec <s>', '--recheck-pickup-sec <s>', '--secret-value <value>'],
  feed: ['--id <id>', '--url <url>', '--token-env <ENV_NAME>', '--origin <name>', '--poll-sec <s>', '--timeout-ms <ms>', '--secret-value <value>'],
  sentry: ['--id <id>', '--org <slug>', '--project slug=tile (repeatable)', '--projects slug=tile,slug=tile', '--url <api url>', '--web-url <ui url>', '--token-env <ENV_NAME>', '--poll-sec <s>', '--secret-value <value>'],
  grafana: ['--id <id>', '--url <url>', '--token-env <ENV_NAME>', '--public-url <url>', '--poll-sec <s>', '--secret-value <value>'],
  vmalert: ['--id <id>', '--url <url>', '--poll-sec <s>'],
  'netdata-cloud': ['--id <id>', '--space-id <id>', '--room-id <id>', '--fleet-nodes a,b', '--token-env <ENV_NAME>', '--url <api url>', '--poll-sec <s>', '--secret-value <value>'],
  'netdata-fleet': ['--id <id>', '--space-id <id>', '--room-id <id>', '--fleet-nodes a,b', '--token-env <ENV_NAME>', '--url <api url>', '--poll-sec <s>', '--secret-value <value>'],
  'domain-expiry': ['--id <id>', '--domain <name> (repeatable)', '--warn-days <n>', '--page-days <n>', '--poll-sec <s>'],
  host: ['--id <id>', '--mount <path> (repeatable, default /)', '--pid-file <path>', '--poll-sec <s>', '--service <tile>']
}

export const CHANNEL_KIND_FLAGS: Record<string, string[]> = {
  file: ['--id <id>', '--path <file> (default .watcher/data/alerts.jsonl)'],
  webhook: ['--id <id>', '--url-env <ENV_NAME>', '--header Name:value (repeatable)'],
  ntfy: ['--id <id>', '--server <url>', '--topic-env <ENV_NAME>', '--token-env <ENV_NAME>', '--primary-env <ENV_NAME>', '--self-url-env <ENV_NAME>', '--self-topic-env <ENV_NAME>', '--self-token-env <ENV_NAME>', '--secret-value <value>'],
  email: ['--id <id>', '--from <address>', '--to-env <ENV_NAME>', '--api-key-env <ENV_NAME>', '--secret-value <value>'],
  sms: ['--id <id>', '--provider telnyx|quo', '--from-env <ENV_NAME>', '--to-env <ENV_NAME>', '--api-key-env <ENV_NAME>', '--secret-value <value>'],
  webpush: ['--id <id>', '--public-key-env <ENV_NAME>', '--private-key-env <ENV_NAME>', '--subject <mailto:...>']
}

/** The help block for one add kind, or null when the kind is not a built-in one. */
export function kindHelp(kind: string, isChannel: boolean): string[] | null {
  const table = isChannel ? CHANNEL_KIND_FLAGS : SOURCE_KIND_FLAGS
  const flags = table[kind]
  if (!flags) return null
  return isChannel
    ? [...flags, '--replace    rewrite an existing channel with this id (instead of refusing a duplicate)']
    : [
        ...flags,
        '--optional   a source whose credential is absent is skipped (source.credential-skip), never a doctor failure',
        '--replace    rewrite an existing source or channel with this id (instead of refusing a duplicate)'
      ]
}
