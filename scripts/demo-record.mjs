#!/usr/bin/env node
// Records the hosted demo's data (src/web/demo): runs the real Watcher in-process (config validation, engine, polled sources, notifier, the
// Hono app and the agent tools) on a virtual clock against a scripted, fictional company, then saves the /api answers the web UI reads to
// src/web/demo/fixtures/recording.json. Eight days of Acme's life play out in a few seconds, so History holds real resolved incidents and
// the Notifications log real sends.
//
// Nothing touches the network or this machine: every probe's fetch, socket, certificate and disk reader is a stand-in answering from the
// script below, and the channels are in-process senders. The output is scanned for anything of this host before it is written.
//
//   node scripts/demo-record.mjs     (npm run demo:record) rewrites the recording; commit the result with the change that needed it

import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server/app.ts'
import { brandOf, validateConfig } from '../src/server/config.ts'
import { openDb } from '../src/server/db.ts'
import { makeAlert } from '../src/server/derive.ts'
import { Engine } from '../src/server/engine.ts'
import { verifyFix } from '../src/server/mcp/fix-context.ts'
import { TOOLS } from '../src/server/mcp/tools.ts'
import { CircuitBreaker } from '../src/server/notify/circuit.ts'
import { createNotifier } from '../src/server/notify/notifier.ts'
import { PollRunner, createRechecker } from '../src/server/recheck.ts'
import { RECHECK_GAP_SEC } from '../src/shared/recheck.ts'
import { createDomainExpirySource } from '../src/server/sources/domain-expiry.ts'
import { heartbeatSource } from '../src/server/sources/heartbeat.ts'
import { createHostSource } from '../src/server/sources/host.ts'
import { createHttpProbeSource } from '../src/server/sources/http-probe.ts'
import { createTcpProbeSource } from '../src/server/sources/tcp-probe.ts'
import { normalizeWebhook } from '../src/server/sources/webhook.ts'
import { SqliteNotifyStore, SqlitePushStore } from '../src/server/stores.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'src/web/demo/fixtures/recording.json')

const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H

// The moment the recording ends: the demo shifts every time in it so that this instant is the moment a visitor opens the page.
const T_END = Date.parse('2026-11-05T15:30:00.000Z')
const T_START = T_END - 8 * D

// ---- the virtual clock ------------------------------------------------------------------------------------

let now = T_START
const nowMs = () => now
const nowIso = () => new Date(now).toISOString()
const iso = (ms) => new Date(ms).toISOString()

// ---- the stand-in network --------------------------------------------------------------------------------

// A probe times its request on the clock it is given. Here every answer waits in `held` until the pump releases it, one at a time, with the
// probe clock set to that answer's latency for the one read that follows; every other read is 0, the moment all requests went out. So a
// probe reads exactly the latency the script names however busy this machine is, and the recording comes out the same on every run.
let clockAt = 0
let clockReads = 0
const probeClock = () => {
  clockReads += 1
  const at = clockAt
  clockAt = 0
  return at
}
const held = []
/** An answer the pump releases: `timed` when a probe reads its clock right after it (an RDAP lookup is not timed). */
const later = (ms, timed, settle) => new Promise((resolve, reject) => held.push({ ms, timed, go: () => settle(resolve, reject) }))
const turn = () => new Promise((r) => setImmediate(r))

/** Run `work` (a poll, a request to the app) while releasing the network answers it waits on, until it settles. */
async function pumped(work) {
  let done = false
  const settled = work.finally(() => {
    done = true
  })
  for (;;) {
    for (let i = 0; i < 3; i++) await turn()
    if (held.length === 0) {
      if (done) break
      continue
    }
    const next = held.shift()
    clockAt = next.ms
    const reads = clockReads
    next.go()
    if (!next.timed) continue
    for (let spins = 0; clockReads === reads; spins++) {
      if (spins > 10_000) throw new Error('a probe never read its clock after its answer came back')
      await turn()
    }
  }
  return settled
}

// ---- what happens to Acme ----------------------------------------------------------------------------------

// [start, duration] of every scripted trouble. Infinity: still going when the recording ends.
const TROUBLE = {
  searchSlow: [T_END - 7 * D + 3 * H, 14 * M],
  redisDown: [T_END - 5 * D + 10 * H, 4 * M],
  storefrontDown: [T_END - 3 * D - 9 * H, 6 * M],
  accountsDown: [T_END - 2 * D + 5 * H, 7 * M],
  stripeStaleOld: [T_END - 20 * H, 12 * M],
  checkoutSlow: [T_END - 6 * H, 9 * M],
  stripeStale: [T_END - 3 * H, Infinity],
  diskLow: [T_END - 130 * M, Infinity],
  checkoutDown: [T_END - 23 * M, Infinity]
}
const during = (name, t = now) => t >= TROUBLE[name][0] && t < TROUBLE[name][0] + TROUBLE[name][1]

// The usage rollup pings every hour; the run due at ROLLUP_LATE comes 50 minutes late, and the run after ROLLUP_LAST never comes.
const ROLLUP_LAST = T_END - 110 * M
const ROLLUP_LATE = ROLLUP_LAST - 72 * H
const INVOICE_LAST = T_END - 6 * H - 30 * M
const BACKUP_LAST = T_END - 2 * H - 15 * M

// Step a minute at a time around anything scripted (and for the last three hours), ten minutes through the quiet stretches.
const quietStep = (t) => {
  if (t >= T_END - 3 * H - 15 * M) return false
  const marks = [...Object.values(TROUBLE).map(([at, len]) => [at, Number.isFinite(len) ? at + len : T_END]), [ROLLUP_LATE, ROLLUP_LATE + 50 * M]]
  return !marks.some(([a, b]) => t >= a - 15 * M && t <= b + 45 * M)
}

// ---- the config ---------------------------------------------------------------------------------------------

const target = (id, service, url, extra = {}) => ({ id, service, url, ...extra })

const RAW_CONFIG = {
  baseUrl: 'https://watch.acme.example',
  serviceMap: [],
  sources: [
    {
      id: 'uptime',
      type: 'http-probe',
      pollSec: 60,
      failAfter: 3,
      targets: [
        target('storefront', 'Storefront', 'https://www.acme.example/', { slowMs: 1500 }),
        target('checkout-api', 'Checkout API', 'https://api.acme.example/checkout/readyz', { expectJson: { ok: true, 'db.ok': true }, slowMs: 800 }),
        target('accounts-api', 'Accounts API', 'https://api.acme.example/accounts/healthz', { expectJson: { status: 'ok' } }),
        target('search-api', 'Search', 'https://search.acme.example/healthz', { expectJson: { ok: true, 'index.ready': true }, slowMs: 1200 }),
        target('cdn', 'CDN', 'https://cdn.acme.example/health.txt'),
        target('status-page', 'Status page', 'https://status.acme.example/'),
        target('docs', 'Docs site', 'https://docs.acme.example/'),
        target('admin', 'Admin console', 'https://admin.acme.example/healthz'),
        target('webhooks-out', 'Outbound webhooks', 'https://hooks.acme.example/healthz', { expectJson: { ok: true } })
      ]
    },
    {
      id: 'datastores',
      type: 'tcp-probe',
      pollSec: 60,
      failAfter: 2,
      targets: [
        { id: 'postgres-primary', service: 'Postgres', host: 'db-primary.internal.acme.example', port: 5432 },
        { id: 'postgres-replica', service: 'Postgres', host: 'db-replica.internal.acme.example', port: 5432 },
        { id: 'redis', service: 'Redis', host: 'cache.internal.acme.example', port: 6379 },
        { id: 'rabbitmq', service: 'Message queue', host: 'mq.internal.acme.example', port: 5671, tls: true },
        { id: 'smtp-relay', service: 'Email relay', host: 'smtp.acme.example', port: 465, tls: true }
      ]
    },
    { id: 'usage-rollup', type: 'heartbeat', every: '1h', grace: '10m', tokenEnv: 'ROLLUP_PING_TOKEN', service: 'Billing jobs' },
    { id: 'invoice-run', type: 'heartbeat', every: '1d', grace: '2h', tokenEnv: 'INVOICE_PING_TOKEN', service: 'Billing jobs' },
    { id: 'db-backup', type: 'heartbeat', every: '6h', grace: '30m', tokenEnv: 'BACKUP_PING_TOKEN', service: 'Backups' },
    { id: 'worker-02', type: 'host', pollSec: 60, mounts: ['/', '/var/lib/queue'], service: 'Worker hosts' },
    { id: 'domains', type: 'domain-expiry', domains: ['acme.example', 'acme-status.example'], service: 'Domains' },
    { id: 'payments', type: 'webhook', tokenEnv: 'PAYMENTS_PUSH_TOKEN', staleAfterSec: 900 }
  ],
  channels: [
    { id: 'phones', type: 'ntfy', server: 'https://ntfy.acme.example', topicEnv: 'NTFY_TOPIC' },
    { id: 'team-chat', type: 'webhook', urlEnv: 'CHAT_WEBHOOK_URL' },
    { id: 'oncall-sms', type: 'sms', provider: 'telnyx', apiKeyEnv: 'TELNYX_API_KEY', fromEnv: 'SMS_FROM', toEnv: 'SMS_TO' },
    { id: 'team-email', type: 'email', provider: 'resend', apiKeyEnv: 'RESEND_API_KEY', from: 'watcher@acme.example', toEnv: 'EMAIL_TO' }
  ],
  routes: [
    {
      id: 'pages',
      match: { severity: ['page'] },
      receivers: ['phones', 'team-chat'],
      mode: 'all',
      groupWaitSec: 30,
      groupIntervalSec: 300,
      repeatIntervalSec: 3600,
      escalate: [{ afterSec: 900, receivers: ['oncall-sms'] }],
      sendResolved: true
    },
    {
      id: 'warnings',
      match: { severity: ['warning'] },
      receivers: ['team-chat'],
      record: ['team-email'],
      mode: 'all',
      groupWaitSec: 120,
      groupIntervalSec: 900,
      repeatIntervalSec: 14400,
      muteInQuietHours: true,
      sendResolved: true
    }
  ],
  quietHours: { tz: 'America/Chicago', start: '22:00', end: '07:00' },
  severityCaps: [
    {
      match: { origin: '^usage-rollup$' },
      max: 'warning',
      note: 'A late usage rollup catches up on its next run; it never wakes anyone.'
    }
  ],
  wallGroups: [
    { id: 'customer', label: 'Customer-facing', services: ['Storefront', 'Checkout API', 'Accounts API', 'Search', 'CDN', 'Status page', 'Docs site'] },
    { id: 'money', label: 'Payments and billing', services: ['Payments', 'Billing jobs'] },
    { id: 'data', label: 'Data', services: ['Postgres', 'Redis', 'Message queue', 'Backups'] },
    { id: 'infra', label: 'Infrastructure', services: ['Worker hosts', 'Email relay', 'Outbound webhooks', 'Admin console', 'Domains'] }
  ]
}

// Credentials exist only in this process, so ingest and the ping routes check a real Bearer; none of them reaches the recording.
const ENV = {
  ROLLUP_PING_TOKEN: randomBytes(12).toString('hex'),
  INVOICE_PING_TOKEN: randomBytes(12).toString('hex'),
  BACKUP_PING_TOKEN: randomBytes(12).toString('hex'),
  PAYMENTS_PUSH_TOKEN: randomBytes(12).toString('hex'),
  NTFY_TOPIC: randomBytes(12).toString('hex'),
  CHAT_WEBHOOK_URL: 'https://chat.acme.example/hooks/watcher',
  TELNYX_API_KEY: randomBytes(12).toString('hex'),
  SMS_FROM: 'demo-sms-sender',
  SMS_TO: 'demo-sms-oncall',
  RESEND_API_KEY: randomBytes(12).toString('hex'),
  EMAIL_TO: 'oncall@acme.example'
}
const ACK_SECRET = randomBytes(24).toString('hex')

// ---- the stand-in world -------------------------------------------------------------------------------------

/** A little steady jitter, so latencies read like a real fleet without making the recording differ run to run. */
let seed = 7
const jitter = (span) => {
  seed = (seed * 16807) % 2147483647
  return Math.round(((seed % 1000) / 1000) * span)
}

const json = (body) => ({ status: 200, body: JSON.stringify(body), type: 'application/json' })

function answerFor(url) {
  switch (url) {
    case 'https://www.acme.example/':
      if (during('storefrontDown')) return { ms: 30 + jitter(20), status: 503, body: '<h1>503 Service Unavailable</h1>', type: 'text/html' }
      return { ms: 210 + jitter(160), status: 200, body: '<!doctype html><title>Acme</title>', type: 'text/html' }
    case 'https://api.acme.example/checkout/readyz':
      if (during('checkoutDown')) return { ms: 2900 + jitter(400), status: 503, body: JSON.stringify({ ok: false, db: { ok: false, error: 'connection pool exhausted (20 of 20 in use)' } }), type: 'application/json' }
      if (during('checkoutSlow')) return { ms: 1100 + jitter(500), ...json({ ok: true, db: { ok: true, poolInUse: 17 } }) }
      return { ms: 90 + jitter(80), ...json({ ok: true, db: { ok: true, poolInUse: 4 + jitter(5) } }) }
    case 'https://api.acme.example/accounts/healthz':
      if (during('accountsDown')) return { ms: 15 + jitter(10), status: 502, body: '<html><body>502 Bad Gateway</body></html>', type: 'text/html' }
      return { ms: 70 + jitter(60), ...json({ status: 'ok' }) }
    case 'https://search.acme.example/healthz':
      if (during('searchSlow')) return { ms: 1700 + jitter(700), ...json({ ok: true, index: { ready: true, lagSec: 340 } }) }
      return { ms: 160 + jitter(120), ...json({ ok: true, index: { ready: true, lagSec: 2 } }) }
    case 'https://cdn.acme.example/health.txt':
      return { ms: 25 + jitter(20), status: 200, body: 'ok', type: 'text/plain' }
    case 'https://status.acme.example/':
      return { ms: 120 + jitter(60), status: 200, body: '<!doctype html><title>Acme status</title>', type: 'text/html' }
    case 'https://docs.acme.example/':
      return { ms: 140 + jitter(90), status: 200, body: '<!doctype html><title>Acme docs</title>', type: 'text/html' }
    case 'https://admin.acme.example/healthz':
      return { ms: 60 + jitter(40), status: 200, body: 'ok', type: 'text/plain' }
    case 'https://hooks.acme.example/healthz':
      return { ms: 80 + jitter(50), ...json({ ok: true, queue: { depth: jitter(30) } }) }
    case 'https://rdap.org/domain/acme.example':
      return { ms: 300, ...json({ objectClassName: 'domain', events: [{ eventAction: 'expiration', eventDate: iso(T_END + 241 * D) }] }) }
    case 'https://rdap.org/domain/acme-status.example':
      return { ms: 300, ...json({ objectClassName: 'domain', events: [{ eventAction: 'expiration', eventDate: iso(T_END + 412 * D) }] }) }
    default:
      return null
  }
}

/** The sources' fetch: the scripted answer after its latency, or a failed request for anything the script does not know. */
function fakeFetch(input) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const a = answerFor(url)
  const timed = !url.startsWith('https://rdap.org/')
  if (!a) return later(0, timed, (_, reject) => reject(new TypeError(`fetch failed: ${url} is not part of the demo world`)))
  return later(a.ms, timed, (resolve) => resolve(new Response(a.body, { status: a.status, headers: { 'content-type': a.type } })))
}

/** Certificates: each site's renews every 90 days, so the soonest has a few weeks left. */
const CERT_DAYS = { 'www.acme.example': 61, 'api.acme.example': 47, 'search.acme.example': 73, 'cdn.acme.example': 82, 'status.acme.example': 55, 'docs.acme.example': 66, 'admin.acme.example': 39, 'hooks.acme.example': 58 }
const readCert = async (host) => T_END + (CERT_DAYS[host] ?? 60) * D

function connect(host, port, opts) {
  const ms = host.startsWith('db-') ? 4 + jitter(4) : host.startsWith('smtp') ? 40 + jitter(30) : 2 + jitter(3)
  return later(ms, true, (resolve, reject) => {
    if (host.startsWith('cache.') && during('redisDown')) reject(Object.assign(new Error(`connect ECONNREFUSED ${host}:${port}`), { code: 'ECONNREFUSED' }))
    else resolve(opts.tls ? { certValidToMs: T_END + (host.startsWith('mq.') ? 120 : 44) * D } : {})
  })
}

const GB = 1024 ** 3
async function readHost(_cfg, at) {
  // /var/lib/queue fills as the dead-letter queue stops draining: 22% free a day out, under 10% once the trouble starts.
  const queueFree = during('diskLow') ? 0.081 : Math.max(0.12, 0.22 - 0.004 * Math.max(0, (now - (TROUBLE.diskLow[0] - 24 * H)) / H))
  return {
    at,
    hostname: 'worker-02',
    cores: 8,
    load5: 1.4 + jitter(90) / 100,
    totalBytes: 32 * GB,
    availableBytes: Math.round((13 + jitter(30) / 10) * GB),
    memSource: 'MemAvailable',
    disks: [
      { mount: '/', ok: true, totalBytes: 160 * GB, freeBytes: 96 * GB },
      { mount: '/var/lib/queue', ok: true, totalBytes: 400 * GB, freeBytes: Math.round(queueFree * 400 * GB) }
    ],
    process: null
  }
}

// ---- the Watcher ------------------------------------------------------------------------------------------------

const checked = validateConfig(RAW_CONFIG)
if (!checked.ok) throw new Error(`demo config is invalid:\n${checked.errors.join('\n')}`)
const cfg = checked.config
const brand = brandOf(cfg)
const lines = []
const log = (line) => lines.push(line)

const db = openDb(':memory:')
const engine = new Engine(db, cfg, nowMs)
const pushStore = new SqlitePushStore(db)
const store = new SqliteNotifyStore(db)
const srcDeps = { fetch: fakeFetch, env: ENV, nowIso, serviceMap: cfg.serviceMap, log, brand: brand.name }

const sourceCfg = (id) => cfg.sources.find((s) => s.id === id)
const sources = [
  createHttpProbeSource(sourceCfg('uptime'), srcDeps, readCert, probeClock),
  createTcpProbeSource(sourceCfg('datastores'), srcDeps, connect, probeClock),
  heartbeatSource(sourceCfg('usage-rollup'), srcDeps),
  heartbeatSource(sourceCfg('invoice-run'), srcDeps),
  heartbeatSource(sourceCfg('db-backup'), srcDeps),
  createHostSource(sourceCfg('worker-02'), srcDeps, readHost),
  createDomainExpirySource(sourceCfg('domains'), srcDeps)
]

/** In-process senders: each delivery answers like its provider would, a quick 200 with a believable latency. */
function channel(id, base) {
  return {
    id,
    send: async () => ({ ok: true, status: '200', latencyMs: base + jitter(base) }),
    test: async () => ({ ok: true, status: '200', latencyMs: base + jitter(base) })
  }
}
const channels = new Map([
  ['phones', channel('phones', 180)],
  ['team-chat', channel('team-chat', 240)],
  ['oncall-sms', channel('oncall-sms', 620)],
  ['team-email', channel('team-email', 410)]
])
const notifier = createNotifier({
  routes: cfg.routes,
  channels,
  quiet: cfg.quietHours,
  store,
  now: nowMs,
  baseUrl: cfg.baseUrl,
  ackSecret: ACK_SECRET,
  log,
  circuits: new CircuitBreaker(nowMs),
  brand: brand.name
})

// The 5 second tick of src/server/main.ts, on the virtual clock.
async function tick() {
  engine.sweep()
  const at = nowIso()
  engine.ingest({
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
  })
  const { views, resolved } = engine.notifyViews()
  await notifier.tick(views, resolved)
}

const runner = new PollRunner(engine, log, nowMs)
const rechecker = createRechecker({ engine, cfg, runner, sources, nudge: () => {}, nowMs })

const app = createApp({
  engine,
  cfg,
  env: ENV,
  db,
  push: pushStore,
  ackSecret: ACK_SECRET,
  webDir: join(root, '.tmp', 'demo-record-no-web'),
  normalizeWebhook: (payload, ctx) => normalizeWebhook(payload, { ...ctx, deps: srcDeps }),
  testChannel: async (id) => {
    const r = await notifier.test(id)
    db.prepare('INSERT INTO results (at, incident_key, route_id, channel_id, kind, ok, status, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      nowMs(),
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
  nudge: () => {},
  recheck: rechecker,
  vapidPublicKey: null,
  now: nowMs,
  fetch: fakeFetch,
  log
})

async function call(method, path, body, headers = {}) {
  const res = await pumped(
    Promise.resolve(
      app.request(`http://127.0.0.1:7717${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    )
  )
  const text = await res.text()
  if (res.status >= 400) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`)
  return text === '' ? null : JSON.parse(text)
}

const mcpDeps = { engine, db, cfg, nowMs, recheck: rechecker, nudge: () => {}, log }
async function agent(tool, args) {
  const spec = TOOLS.find((t) => t.name === tool)
  const out = await spec.run(mcpDeps, args)
  if (!out.ok) throw new Error(`${tool} failed: ${out.error}`)
  return out
}

const firingKey = (service) => {
  const i = engine.wall().incidents.find((x) => x.service === service)
  if (!i) throw new Error(`no firing incident on ${service} at ${nowIso()}; the log ends: ${lines.slice(-3).join(' / ')}`)
  return i.key
}

// ---- the senders that push ----------------------------------------------------------------------------------

let stripeOldSent = false
let stripeOldResolved = false
async function pushPayments() {
  const alerts = []
  const stripe = (startsAt, status) => ({
    status,
    labels: { alertname: 'StripeWebhookStale', severity: 'warning', service: 'Payments', instance: 'stripe-events' },
    annotations: {
      summary: 'No Stripe webhook event has been accepted since the endpoint secret was rotated; Stripe is retrying deliveries.',
      description: 'Every delivery to /webhooks/stripe answers 400 "signature mismatch". Stripe retries for up to three days, so no event is lost yet.'
    },
    startsAt: iso(startsAt),
    ...(status === 'resolved' ? { endsAt: nowIso() } : {}),
    generatorURL: 'https://payments.acme.example/admin/health'
  })
  if (during('stripeStaleOld')) {
    stripeOldSent = true
    alerts.push(stripe(TROUBLE.stripeStaleOld[0], 'firing'))
  } else if (stripeOldSent && !stripeOldResolved) {
    stripeOldResolved = true
    alerts.push(stripe(TROUBLE.stripeStaleOld[0], 'resolved'))
  }
  if (during('stripeStale')) alerts.push(stripe(TROUBLE.stripeStale[0], 'firing'))
  const stale = during('stripeStale') || during('stripeStaleOld')
  const checks = {
    staleAfterSec: 900,
    complete: true,
    list: [
      { id: 'StripeWebhookStale', instance: 'stripe-events', service: 'Payments', state: stale ? 'failing' : 'ok', detail: stale ? 'Last event accepted before the secret rotation' : `Last event ${1 + jitter(3)} min ago` },
      { id: 'PayoutReconcile', instance: 'payouts', service: 'Payments', state: 'ok', detail: `Reconciled ${1200 + jitter(150)} payouts, 0 mismatches` },
      { id: 'RefundQueue', instance: 'refunds', service: 'Payments', state: 'ok', detail: `${jitter(3)} refunds waiting` }
    ]
  }
  await call('POST', '/ingest/payments', { version: '4', status: alerts.length ? 'firing' : 'resolved', alerts, checks }, {
    authorization: `Bearer ${ENV.PAYMENTS_PUSH_TOKEN}`
  })
}

const ping = (id, token) => call('POST', `/ingest/heartbeat/${id}`, undefined, { authorization: `Bearer ${token}` })

// ---- the script ------------------------------------------------------------------------------------------------

const tests = {}
const agenda = [
  // People acknowledge the pages they answered; the agent writes up the warnings it took.
  [TROUBLE.redisDown[0] + 3 * M, async () => call('POST', `/api/incidents/${encodeURIComponent(firingKey('Redis'))}/ack`, { by: 'Priya' })],
  [TROUBLE.storefrontDown[0] + 4 * M, async () => call('POST', `/api/incidents/${encodeURIComponent(firingKey('Storefront'))}/ack`, { by: 'Sam' })],
  [TROUBLE.accountsDown[0] + 4 * M, async () => call('POST', `/api/incidents/${encodeURIComponent(firingKey('Accounts API'))}/ack`, { by: 'Sam' })],
  [
    TROUBLE.accountsDown[0] + 6 * M,
    async () =>
      agent('comment', {
        key: firingKey('Accounts API'),
        by: 'claude',
        text: 'The 502s come from the load balancer: both accounts pods were restarting at once after the config reload. Rolled them one at a time; `/healthz` answers again.'
      })
  ],
  [
    T_END - 2 * D + 2 * H,
    async () => {
      for (const id of channels.keys()) tests[id] = await call('POST', '/api/notifications/test', { channel: id })
    }
  ],
  [
    TROUBLE.stripeStale[0] + 40 * M,
    async () => {
      const key = firingKey('Payments')
      await agent('comment', {
        key,
        by: 'claude',
        text: 'Stripe signs deliveries with the rotated endpoint secret, and payments still verifies with the old one, so every delivery answers 400.\n\nThe fix (PAY-318) is merged; it ships with the next payments deploy. Stripe keeps retrying for three days, so nothing is lost meanwhile.'
      })
      await agent('park', {
        key,
        state: 'fixed_undeployed',
        until: iso(TROUBLE.stripeStale[0] + 9 * H),
        by: 'claude',
        note: 'Fix merged, waiting on the payments deploy',
        ref: 'PAY-318'
      })
    }
  ],
  [
    TROUBLE.diskLow[0] + 30 * M,
    async () => {
      const key = firingKey('Worker hosts')
      await agent('acknowledge', { key, by: 'claude', note: 'Freeing space on /var/lib/queue' })
      await agent('comment', {
        key,
        by: 'claude',
        text: '`/var/lib/queue` on worker-02 filled because the dead-letter queue stopped draining after the consumer deploy.\n\n- Paused the replay job and removed 3.2 GB of expired batches\n- Opened OPS-1142 to cap the dead-letter queue\n\nFree space is climbing slowly; I will look again within the hour.'
      })
    }
  ],
  // Someone pressed Re-check now a minute before the end, so every source (the twice-a-day domain lookup too) answered just now.
  [T_END - M, async () => call('POST', '/api/recheck')]
]

// ---- run it -------------------------------------------------------------------------------------------------------

const lastPoll = new Map()
let nextRollup = ROLLUP_LAST - Math.floor((ROLLUP_LAST - T_START) / H) * H
let nextInvoice = INVOICE_LAST - Math.floor((INVOICE_LAST - T_START) / D) * D
let nextBackup = BACKUP_LAST - Math.floor((BACKUP_LAST - T_START) / (6 * H)) * (6 * H)
let nextPush = T_START

while (now <= T_END) {
  while (nextRollup <= now && nextRollup <= ROLLUP_LAST) {
    // The run due at ROLLUP_LATE reports 50 minutes late; the runs after it keep the hourly beat.
    if (nextRollup !== ROLLUP_LATE) await ping('usage-rollup', ENV.ROLLUP_PING_TOKEN)
    nextRollup += H
  }
  if (now >= ROLLUP_LATE + 50 * M && now < ROLLUP_LATE + 51 * M) await ping('usage-rollup', ENV.ROLLUP_PING_TOKEN)
  while (nextInvoice <= now) {
    await ping('invoice-run', ENV.INVOICE_PING_TOKEN)
    nextInvoice += D
  }
  while (nextBackup <= now) {
    await ping('db-backup', ENV.BACKUP_PING_TOKEN)
    nextBackup += 6 * H
  }
  if (nextPush <= now) {
    await pushPayments()
    nextPush = now + 5 * M
  }
  for (const [at, act] of agenda) if (at <= now && !act.done) {
    act.done = true
    await act()
  }
  for (const src of sources) {
    if ((lastPoll.get(src.id) ?? -Infinity) + src.pollSec * 1000 > now) continue
    lastPoll.set(src.id, now)
    await pumped(runner.scheduled(src))
  }
  await tick()
  if (now === T_END) break
  now = Math.min(T_END, now + (quietStep(now) ? 10 * M : M))
}
for (const [at, act] of agenda) if (!act.done) throw new Error(`the script step at ${iso(at)} never ran`)

// ---- what the web UI reads -------------------------------------------------------------------------------------------

const state = await call('GET', '/api/state')
const instance = await call('GET', '/api/instance')
const notifications = await call('GET', '/api/notifications')
const history = (await call('GET', '/api/history?hours=720')).rows
const incidents = {}
for (const key of [...state.incidents.map((i) => i.key), ...history.map((h) => h.incidentKey)]) {
  incidents[key] = await call('GET', `/api/incidents/${encodeURIComponent(key)}`)
}
// What an agent or the CLI reads about a firing incident: the fix brief, the chat card, each alert, and the Watcher's self-check.
const fixContext = {}
const cards = {}
const alerts = {}
for (const i of state.incidents) {
  fixContext[i.key] = await call('GET', `/api/incidents/${encodeURIComponent(i.key)}/fix-context`)
  cards[i.key] = await call('GET', `/api/incident-card/${encodeURIComponent(i.key)}`)
  for (const a of i.alerts) alerts[a.key] = await call('GET', `/api/alerts/${encodeURIComponent(a.key)}`)
}
const doctor = await call('GET', '/api/doctor')
// The re-checks a visitor can press, each past the runner's gap after the last poll, so every one really polls.
const gap = RECHECK_GAP_SEC * S + 2 * S
now = T_END + gap
const wallRecheck = await call('POST', '/api/recheck')
const alertRechecks = {}
for (const i of state.incidents) {
  for (const a of i.alerts) {
    now += gap
    alertRechecks[a.key] = await call('POST', `/api/recheck/${encodeURIComponent(a.key)}`)
  }
}
// The fix loop's re-check of one incident, and its awaited verification (`watcher recheck <key> --wait`, the MCP verify_fix): the
// verification waits on the virtual clock, so its rounds take no real time. Nothing is fixed, so every one times out still firing.
const incidentRechecks = {}
const verifies = {}
for (const i of state.incidents) {
  now += gap
  incidentRechecks[i.key] = await call('POST', `/api/incidents/${encodeURIComponent(i.key)}/recheck`, { by: 'claude' })
  now += gap
  const r = await pumped(verifyFix({ engine, recheck: rechecker, nowMs, log, sleep: async (ms) => void (now += ms) }, i.key, 'agent: claude', { timeoutSec: 30 }))
  if (!r.ok) throw new Error(`verify ${i.key}: ${r.error}`)
  verifies[i.key] = r.result
}

const recording = {
  recordedAt: iso(T_END),
  instance,
  state,
  incidents,
  history,
  notifications,
  rechecks: { wall: wallRecheck, alerts: alertRechecks, incidents: incidentRechecks, verify: verifies },
  tests,
  agent: { fixContext, cards, alerts, doctor }
}

// ---- nothing of this machine in the output ------------------------------------------------------------------------

const text = `${JSON.stringify(recording, null, 1)}\n`
const forbidden = [root, process.env.HOME, userInfo().username, hostname(), '127.0.0.1', 'localhost', ACK_SECRET, ...Object.values(ENV).filter((v) => !v.includes('acme.example'))]
  .filter((s) => typeof s === 'string' && s.length >= 4)
const leaks = forbidden.filter((s) => text.includes(s))
if (leaks.length) throw new Error(`the recording holds ${leaks.length} value(s) of this host or its secrets; not written`)

const expect = (ok, what) => {
  if (!ok) throw new Error(`the recording is not the scenario the demo needs: ${what}`)
}
const tiers = state.incidents.map((i) => `${i.severity}/${i.state.attention}`).sort()
expect(state.incidents.length === 4, `4 firing incidents, got ${state.incidents.length}: ${state.incidents.map((i) => i.title).join('; ')}`)
expect(tiers.join(',') === 'page/none,warning/acked,warning/none,warning/parked', `tiers ${tiers.join(',')}`)
expect(history.length >= 6, `at least 6 resolved incidents, got ${history.length}`)
expect(notifications.results.length >= 10, `at least 10 sends in the log, got ${notifications.results.length}`)

writeFileSync(OUT, text)
console.log(
  `wrote ${OUT.slice(root.length + 1)}: ${state.incidents.length} firing, ${history.length} resolved, ${notifications.results.length} sends, ${Object.keys(alertRechecks).length} alert re-checks`
)
