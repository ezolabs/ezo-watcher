// Wiring: config -> database -> engine -> polled sources -> notifier -> HTTP.
// One process, one SQLite file, no queue. Timers: each source polls on its own interval; one 5 second tick
// sweeps expired presence, raises or clears source-stale alerts and lets the notifier decide.
//
// Everything this process needs comes from the config file and the environment; there is no .env loader here. The CLI (`watcher`) reads
// `.watcher/.env` before it starts this module, so a server started by `node src/server/main.ts` sees only what its parent exported.

import { serve } from '@hono/node-server'
import { join, resolve } from 'node:path'
import { brandOf, loadConfig } from './config.ts'
import type { ChannelConfig, SourceConfig } from './config.ts'
import { openDb } from './db.ts'
import { Engine } from './engine.ts'
import { PollRunner, createRechecker } from './recheck.ts'
import { createApp } from './app.ts'
import { SqliteNotifyStore, SqlitePushStore } from './stores.ts'
import { makeAlert } from './derive.ts'
import type { FleetSource } from './sources/netdata-fleet.ts'
import { normalizeWebhook } from './sources/webhook.ts'
import { POLLED } from './source-registry.ts'
import type { PolledSource, SourceDeps } from './sources/types.ts'
import { ADMIN_TOKEN_ENV, ADMIN_TOKEN_MIN_CHARS, adminTokenOf, checkedAdminToken } from './auth.ts'
import { createChannel } from './notify/channels/index.ts'
import { CircuitBreaker } from './notify/circuit.ts'
import { createNotifier } from './notify/notifier.ts'
import { usableRoutes } from './notify/match.ts'
import type { Channel } from './notify/types.ts'
import type { Observation } from '../shared/types.ts'
import { noteLine } from '../shared/agent.ts'
import { Telemetry, scheduleHeartbeat } from '../shared/telemetry.ts'

const env = process.env
const cfgPath = resolve(env.WATCHER_CONFIG ?? '.watcher/config.json')
const cfg = loadConfig(cfgPath)
// What this Watcher calls itself (config `brand`): the channels' own titles, the test notification and the source-stale words.
const brand = brandOf(cfg)
const dataDir = resolve(env.WATCHER_DATA_DIR ?? cfg.dataDir ?? '.watcher/data')
const log = (line: string): void => console.log(JSON.stringify({ t: new Date().toISOString(), msg: line }))
const startedAt = Date.now()

// Anonymous telemetry (src/shared/telemetry.ts, docs/telemetry.md): one heartbeat of counts a day, and the type and package
// stack frames of an internal error. DO_NOT_TRACK=1 or WATCHER_TELEMETRY_DISABLED=1 turns it off; the first-run notice, when
// this process is the first to run on the machine, goes to this log. An uncaught exception is kept on disk for the next run
// to send: the monitor listener observes it and leaves Node's crash as it was.
const telemetry = Telemetry.open({ print: (text) => log(text.replace(/\n/g, ' ')) })
process.on('uncaughtExceptionMonitor', (err) => telemetry.captureCrash(err, 'server'))

function requiredEnv(name: string): string {
  const v = env[name]
  if (v === undefined || v === '') {
    throw new Error(`${name} is not set. Run \`watcher init\` to write .watcher/config.json and .watcher/.env, then export ${name} (or start the server with \`watcher serve\`).`)
  }
  return v
}

// The HMAC that signs every acknowledge link. There is no default: a server that invented one would accept links it never issued.
const ackSecret = requiredEnv('WATCHER_ACK_SECRET')
const port = Number(env.WATCHER_PORT ?? cfg.port ?? 7717)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`WATCHER_PORT must be a whole number from 1 to 65535, not ${JSON.stringify(env.WATCHER_PORT)}`)
const host = env.WATCHER_HOST ?? cfg.host ?? '127.0.0.1'

// One admin login for the wall and /api (src/server/auth.ts). A loopback bind without a token stays open, as it always was: only this machine can
// reach the port. Any other bind is reachable from the network, so a server with no login is refused here instead of shipped open.
const adminToken = checkedAdminToken(host, adminTokenOf(env))
if (adminToken !== '' && adminToken.length < ADMIN_TOKEN_MIN_CHARS) log(`admin auth: ${ADMIN_TOKEN_ENV} is shorter than ${ADMIN_TOKEN_MIN_CHARS} characters; use \`openssl rand -hex 32\``)
log(adminToken === '' ? `admin auth: off (bound to ${host}, no ${ADMIN_TOKEN_ENV})` : `admin auth: on; the wall and /api require the admin token`)
// A webhook source whose signing secret is missing cannot accept a signed push; say so once at startup, the way a missing channel secret is said.
for (const s of cfg.sources) {
  if (s.type === 'webhook' && s.verify && !env[s.verify.secretEnv]) log(`webhook source ${s.id}: ${s.verify.secretEnv} is not set, so a signed ${s.verify.scheme} push answers 401`)
}

const db = openDb(join(dataDir, 'watcher.db'))
const engine = new Engine(db, cfg)
engine.prune()
const moved = engine.rekey()
if (moved) log(`${moved} firing alerts moved to the incident the config now gives them`)
const removed = engine.dropRemovedSources()
if (removed.presenceRows) log(`${removed.presenceRows} presence rows of sources no longer in the config dropped: ${removed.resolved} alerts resolved, ${removed.firingEdited} firing alerts lost the removed source from where they were seen`)
const pushStore = new SqlitePushStore(db)
const store = new SqliteNotifyStore(db)

const srcDeps: SourceDeps = { fetch, env, nowIso: () => new Date().toISOString(), serviceMap: cfg.serviceMap, log, brand: brand.name }

/**
 * The credential env vars a source names that this host does not set: its own top-level `*Env` fields, which is every polled
 * kind's credential (`tokenEnv`, a heartbeat's ping token). `primaryEnv` names a target, not a credential, as in the channel
 * check below. A webhook's `verify.secretEnv` is nested and is not read here: a webhook is pushed to, never started below.
 */
function missingSourceSecrets(s: SourceConfig): string[] {
  return Object.entries(s)
    .filter(([key, value]) => key.endsWith('Env') && key !== 'primaryEnv' && typeof value === 'string' && value !== '' && !env[value])
    .map(([, value]) => value as string)
}

/**
 * `optional` on a source (`watcher add … --optional`, src/server/config.ts): its credential may be absent on this host. The
 * same shape src/cli/project.ts's `isRequiredSource` honours, so the server and `watcher doctor` agree on which sources may skip.
 */
function isOptionalSource(s: SourceConfig): boolean {
  const raw = s as unknown as { optional?: unknown; required?: unknown }
  return raw.optional === true || raw.required === false
}

// Sources that poll. A required source whose credential is missing is reported once and counts as erroring.
const sources: PolledSource[] = []
let fleet: FleetSource | null = null
// The nodes the fleet-load rules cover: the netdata-cloud source folds Netdata's own CPU and RAM alerts on them into the fleet rules' incidents.
const loadNodes = cfg.sources.flatMap((s) => (s.type === 'netdata-fleet' ? s.fleetNodes : []))
for (const s of cfg.sources) {
  // source-registry.ts owns which kinds poll: a kind with no factory is pushed or app-driven, never started here.
  const factory = POLLED[s.type]
  if (!factory) continue
  // An optional source whose credential is not on this host is not started at all: it could only log one poll error every cycle
  // for a credential its config already says may be absent, the way a channel with a missing *Env is disabled below. A required
  // source is started as before, so its own poll and `watcher doctor` name the missing value.
  if (isOptionalSource(s)) {
    const missing = missingSourceSecrets(s)
    if (missing.length > 0) {
      const reason = `missing ${missing.join(', ')}`
      engine.skippedSources.set(s.id, reason)
      log(`source ${s.id} not started: ${reason} (optional source)`)
      continue
    }
  }
  try {
    const built = factory(s, srcDeps, { loadNodes })
    sources.push(built.source)
    if (built.fleet) fleet = built.fleet
  } catch (err) {
    log(`source ${s.id} not started: ${(err as Error).message}`)
  }
}

// Channels. A channel whose secret is missing is left out and says so; it never crashes the wall.
const channels = new Map<string, Channel>()
const disabled = new Set<string>()
// One set of circuits for the channels and the notifier: the ntfy channel keeps one per server in it, the notifier one per other channel.
const circuits = new CircuitBreaker(Date.now)
for (const c of cfg.channels as ChannelConfig[]) {
  try {
    // Every credential or recipient a channel names must be present on this host (tokenEnv is optional).
    const missing = Object.entries(c)
      .filter(([k, v]) => k.endsWith('Env') && k !== 'tokenEnv' && k !== 'primaryEnv' && typeof v === 'string' && !env[v])
      .map(([, v]) => v)
    if (missing.length) throw new Error(`missing ${missing.join(', ')}`)
    channels.set(c.id, createChannel(c, { fetch, env, now: Date.now, subscriptions: pushStore, log, circuits, brand: brand.name }))
  } catch (err) {
    disabled.add(c.id)
    engine.disabledChannels.add(c.id)
    log(`channel ${c.id} disabled: ${(err as Error).message}`)
  }
}

// The engine's own notes (a reopen) go to the operator log; a channel that wants them can subscribe here.
engine.onNote = (incidentKey, kind, by, text) => log(`note ${kind} on ${incidentKey}: ${noteLine(kind, by, text, 200)}`)
if (!env.WATCHER_MCP_TOKEN) log('mcp: WATCHER_MCP_TOKEN is not set, so /mcp answers 401 to every request')
const notifier = createNotifier({
  // A route keeps working with the channels this host actually has: a missing credential drops that channel
  // from the route (and from its escalation steps), never the whole route.
  routes: usableRoutes(cfg.routes, (id) => channels.has(id)),
  channels,
  quiet: cfg.quietHours,
  store,
  now: Date.now,
  baseUrl: cfg.baseUrl,
  ackSecret,
  log,
  circuits,
  brand: brand.name
})

const wp = cfg.channels.find((c) => c.type === 'webpush')
const vapidPublicKey = wp && wp.type === 'webpush' ? (env[wp.publicKeyEnv] ?? null) : null

let ticking = false
async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    engine.sweep()
    const at = new Date().toISOString()
    const stale: Observation = {
      source: 'self',
      kind: 'self',
      at,
      firing: engine.staleAlerts((id) =>
        makeAlert(
          {
            origin: 'self',
            fingerprint: `source-stale:${id}`,
            rule: `${id} is not answering`,
            labels: { alertname: 'source-stale', severity: 'warning', source: id, service: 'Watcher sources' },
            annotations: { summary: `${brand.name} has not heard from the source ${id} for ${cfg.staleAfterMisses} polls.` },
            startsAt: at,
            via: { source: 'self', kind: 'self', lastSeen: at },
            raw: { source: id }
          },
          cfg.serviceMap,
          at
        )
      ),
      resolved: [],
      complete: true
    }
    engine.ingest(stale)
    const { views, resolved } = engine.notifyViews()
    await notifier.tick(views, resolved)
  } catch (err) {
    log(`tick failed: ${(err as Error).message}`)
    telemetry.captureError(err, 'server')
  } finally {
    ticking = false
  }
}

// A scheduled poll and an on-demand re-check (POST /api/recheck) poll through one runner, so they ingest and record the same way
// and never run two polls of one source at once (src/server/recheck.ts).
const runner = new PollRunner(engine, log)
const rechecker = createRechecker({ engine, cfg, runner, sources, nudge: () => void tick(), nowMs: Date.now })

function pollLoop(src: PolledSource): void {
  const run = async (): Promise<void> => {
    await runner.scheduled(src)
    setTimeout(() => void run(), src.pollSec * 1000).unref?.()
  }
  void run()
}

for (const s of sources) pollLoop(s)
setInterval(() => void tick(), 5000)
setInterval(() => engine.prune(), 6 * 3600_000).unref()
scheduleHeartbeat(telemetry, () => ({
  uptimeMs: Date.now() - startedAt,
  sourceKinds: cfg.sources.map((s) => s.type),
  channelKinds: cfg.channels.map((c) => c.type),
  severities: engine.wall().incidents.map((i) => i.severity),
  mcp: Boolean(env.WATCHER_MCP_TOKEN)
}))

const app = createApp({
  engine,
  cfg,
  env,
  db,
  push: pushStore,
  ackSecret,
  webDir: resolve(env.WATCHER_WEB_DIR ?? 'dist/web'),
  normalizeWebhook: (payload, ctx) => normalizeWebhook(payload, { ...ctx, deps: srcDeps }),
  testChannel: async (id) => {
    const ch = channels.get(id)
    if (!ch) return { ok: false, status: disabled.has(id) ? 'disabled: missing secret' : 'unknown', latencyMs: 0 }
    const r = await notifier.test(id)
    db.prepare('INSERT INTO results (at, incident_key, route_id, channel_id, kind, ok, status, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      Date.now(),
      '-',
      '-',
      id,
      'test',
      r.ok ? 1 : 0,
      r.status,
      r.latencyMs
    )
    return { ok: r.ok, status: r.status, latencyMs: r.latencyMs }
  },
  nudge: () => void tick(),
  recheck: rechecker,
  fleet: fleet ? () => fleet!.view() : undefined,
  vapidPublicKey,
  now: Date.now,
  fetch,
  log
})

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  log(`listening on ${info.address}:${info.port}, ${sources.length} polled sources, ${channels.size} channels`)
})
