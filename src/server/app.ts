// The HTTP surface. The wall and /api are open on a loopback bind; with WATCHER_ADMIN_TOKEN set they need a login (src/server/auth.ts), and main.ts
// refuses an off-loopback bind without one. Everything else keeps the auth it always had: ingest carries its per-source token or a signed-webhook
// HMAC, ack links carry an HMAC, /mcp carries WATCHER_MCP_TOKEN, and every state-changing call from a browser must be same-origin.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  LOGIN_JS,
  LoginLimiter,
  adminAuthorized,
  adminBearerMatches,
  adminClearCookie,
  adminExemptPath,
  adminSessionCookie,
  adminSessionValue,
  adminTokenMatches,
  adminTokenOf,
  hostHeaderIsLoopback,
  loginClientOf,
  loginPage,
  LOGIN_CSS,
  proxyRefusal,
  safeNextPath
} from './auth.ts'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import type { Engine } from './engine.ts'
import type { SqlitePushStore } from './stores.ts'
import type { NetdataWebhookConfig, WatchConfig, WebhookSourceConfig } from './config.ts'
import type { Observation } from '../shared/types.ts'
import type { AlertRecheck } from '../shared/recheck.ts'
import { BadPayload, verifyWebhookRequest } from './sources/webhook.ts'
import { heartbeatSource } from './sources/heartbeat.ts'
import type { HeartbeatSourceConfig } from './sources/heartbeat.ts'
import type { Db } from './db.ts'
import type { Rechecker } from './recheck.ts'
import { RecheckStore, parseOutcome, pushedSendersOf, requestable } from './push-recheck.ts'
import { findNoticeKey, verifyAckSignature } from './notify/message.ts'
import { FALLBACK_NAME, NOTIFICATION_NAME, actorName, cleanName } from '../shared/who.ts'
import { REASON_MAX, checkOptionalText, checkPark } from '../shared/agent.ts'
import { summaryOf } from '../shared/summary.ts'
import { ALERT_REF, cardOf } from '../shared/card.ts'
import { createMcpHandler } from './mcp/index.ts'
import { VERIFY_MAX_TIMEOUT_SEC, VERIFY_MIN_TIMEOUT_SEC, fixContextOf, verifyFix } from './mcp/fix-context.ts'
import type { FleetView } from '../shared/fleet.ts'
import { instanceInfo, manifestWithBrand, pageWithInstance } from './instance.ts'

export interface AppDeps {
  engine: Engine
  cfg: WatchConfig
  env: NodeJS.ProcessEnv
  db: Db
  push: SqlitePushStore
  ackSecret: string
  webDir: string
  /** Normalise a webhook body into an Observation (sources/webhook.ts). `netdata` is the source's Netdata adapter config, when it has one. */
  normalizeWebhook: (payload: unknown, ctx: { source: string; headerSource?: string; netdata?: NetdataWebhookConfig }) => Observation
  testChannel: (id: string) => Promise<{ ok: boolean; status: string; latencyMs: number }>
  /** Wake the notifier now (after an ingest or an ack) instead of waiting for the next tick. */
  nudge: () => void
  /** On-demand re-poll of the pull sources (src/server/recheck.ts). Absent: the endpoints answer 503. */
  recheck?: Rechecker
  /** The fleet metrics snapshot (the netdata-fleet source's `view`). Absent: GET /api/fleet answers 503. */
  fleet?: () => FleetView
  vapidPublicKey: string | null
  now: () => number
  /** One line to the operator log. Never a token. Absent: the console. */
  log?: (line: string) => void
  /** The sender of an outgoing request (a channel test). Absent: the global fetch. */
  fetch?: typeof fetch
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

const cspFor = (embedOrigins: string[]): string =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors 'self' ${embedOrigins.join(' ')}`
  ].join('; ')

/** An alert key as `alertKey()` writes it: the origin (a source id), a colon and 8 hex digits. */
const ALERT_ID = ALERT_REF

/**
 * The MCP Streamable HTTP Origin check (spec 2025-06-18, Security Warning item 1). A request with no Origin passes (a CLI or an
 * agent is not a browser); one with an Origin must name this Watcher (`http(s)://<Host>`, or its configured public baseUrl) or a
 * configured embed origin. `null` means the request may proceed.
 */
export function mcpOriginRefusal(
  origin: string | undefined,
  host: string | undefined,
  baseUrl: string | undefined,
  embedOrigins: readonly string[]
): { error: string; code: string; detail: string } | null {
  if (origin === undefined || origin.trim() === '') return null
  const candidate = origin.replace(/\/+$/, '')
  const allowed = new Set<string>()
  for (const entry of embedOrigins) allowed.add(entry.replace(/\/+$/, ''))
  if (baseUrl) {
    try {
      allowed.add(new URL(baseUrl).origin)
    } catch {
      // a malformed baseUrl is the config validator's job, not this check's
    }
  }
  if (host) {
    allowed.add(`https://${host}`)
    allowed.add(`http://${host}`)
  }
  if (candidate.toLowerCase() === 'null' || !allowed.has(candidate)) {
    return {
      error: 'origin not allowed',
      code: 'mcp.origin-rejected',
      detail: 'The Origin header must name this Watcher (or a configured embedOrigin); a browser from another site cannot drive /mcp.'
    }
  }
  return null
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** A Bearer header against the expected token, compared as two SHA-256 digests so neither the content nor the length of the token shows in the time taken. */
function bearerMatches(header: string, expected: string): boolean {
  if (expected === '' || !header.startsWith('Bearer ')) return false
  const digest = (v: string): Buffer => createHash('sha256').update(v).digest()
  return timingSafeEqual(digest(header.slice(7)), digest(expected))
}

/** Read a request body but stop at `limit` bytes, so an oversized POST never sits whole in a small process. null = over the limit. */
async function readCapped(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > limit) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createApp(d: AppDeps): Hono {
  const app = new Hono()
  // The embed host may frame the embed view and read /api/summary: `embedOrigins` in the config, and WATCHER_EMBED_ORIGINS (comma separated) adds more.
  const embedOrigins = [...(d.cfg.embedOrigins ?? []), ...(d.env.WATCHER_EMBED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)]
  const CSP = cspFor(embedOrigins)
  // The pushed senders' schedule and re-check requests: all in the database, so this and the re-checker's own handle agree.
  const requests = new RecheckStore(d.db, d.cfg, d.now)
  const log = d.log ?? ((line: string) => console.log(JSON.stringify({ t: new Date(d.now()).toISOString(), msg: line })))
  // Which Watcher this is (src/server/instance.ts): the brand and the optional views it backs. Read once: both come from the config.
  const instance = instanceInfo(d.cfg)

  app.use('*', async (c, next) => {
    await next()
    c.header('Content-Security-Policy', CSP)
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Server-Time', new Date(d.now()).toISOString())
  })

  // ---- admin auth (src/server/auth.ts) ----------------------------------------------------------------------------------------------
  // With WATCHER_ADMIN_TOKEN set, the wall and /api need a login: a session cookie for a browser, `Authorization: Bearer <token>` for an API
  // client. The paths that carry their own auth (adminExemptPath: /healthz, /ingest/*, /mcp, the signed ack and notice links, the login page) are
  // left alone. Registered before every route, so a handler cannot be reached around it. Without the token the server is open, as a loopback one
  // always was; main.ts is what refuses an off-loopback bind with no token.
  const adminToken = adminTokenOf(d.env)
  // A cookie is Secure only when the public URL is https: a loopback http deployment would otherwise never see its own cookie again.
  const secureCookie = (d.cfg.baseUrl ?? '').startsWith('https:')
  const loginLimiter = new LoginLimiter(d.now)
  const wantsJson = (c: Context): boolean => (c.req.header('content-type') ?? '').includes('application/json')
  if (adminToken !== '') {
    app.use('*', async (c, next) => {
      if (adminExemptPath(c.req.path) || adminAuthorized(c.req.raw.headers, d.ackSecret, adminToken, d.now())) return next()
      c.header('Cache-Control', 'no-store')
      if (c.req.path.startsWith('/api/') || (c.req.method !== 'GET' && c.req.method !== 'HEAD')) {
        c.header('WWW-Authenticate', 'Bearer realm="ezo-watcher"')
        return c.json({ error: 'unauthorized' }, 401)
      }
      const target = c.req.path + (new URL(c.req.url).search || '')
      return c.redirect(`/login?next=${encodeURIComponent(target)}`, 302)
    })
  }

  // With no WATCHER_ADMIN_TOKEN the wall would be open to whoever can reach the port — which on loopback is only this machine, and
  // through a hand-run tunnel is the internet. A request a proxy or tunnel forwarded is refused unless the operator set the token;
  // the paths that carry their own auth (/ingest, /mcp, /healthz, the signed links) keep it and are exempt.
  if (adminToken === '') {
    app.use('*', async (c, next) => {
      if (adminExemptPath(c.req.path)) return next()
      const refusal = proxyRefusal(c.req.raw.headers, new URL(c.req.url).host)
      if (refusal) {
        c.header('Cache-Control', 'no-store')
        return c.json(refusal.body, 403)
      }
      return next()
    })
  }

  // The sign-in form: GET shows it (or the wall, when already signed in), POST checks the token and sets the session cookie.
  app.get('/login', (c) => {
    const next = safeNextPath(c.req.query('next'))
    if (adminToken === '') return c.redirect('/', 302)
    if (adminAuthorized(c.req.raw.headers, d.ackSecret, adminToken, d.now())) return c.redirect(next, 302)
    c.header('Cache-Control', 'no-store')
    return c.html(loginPage(instance.brand.name, next))
  })
  // The page's one stylesheet. It carries no secret and is served like an asset, so the sign-in page needs no inline style (the CSP forbids one).
  app.get('/login.css', (c) => {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.body(LOGIN_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' })
  })
  // It carries the hash route a deep link opened with into the form's `next`, because a fragment never reaches the server.
  app.get('/login.js', (c) => {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.body(LOGIN_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' })
  })
  app.post('/login', async (c) => {
    if (adminToken === '') return c.redirect('/', 302)
    c.header('Cache-Control', 'no-store')
    const client = loginClientOf(c.req.raw.headers)
    const json = wantsJson(c)
    let form: Record<string, unknown> = {}
    try {
      form = json ? ((await c.req.json()) as Record<string, unknown>) : (await c.req.parseBody()) as Record<string, unknown>
    } catch {
      form = {}
    }
    if (typeof form !== 'object' || form === null || Array.isArray(form)) form = {}
    const next = safeNextPath(typeof form.next === 'string' ? form.next : c.req.query('next'))
    const refused = (status: 400 | 401 | 429, message: string): Response => {
      if (json) return c.json({ error: status === 429 ? 'too many attempts' : 'unauthorized' }, status)
      return c.html(loginPage(instance.brand.name, next, message), status)
    }
    const wait = loginLimiter.retryAfterSec(client)
    if (loginLimiter.blocked(client)) {
      c.header('Retry-After', String(wait))
      return refused(429, `Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.`)
    }
    const submitted = typeof form.token === 'string' ? form.token : ''
    if (!adminTokenMatches(submitted, adminToken)) {
      loginLimiter.fail(client)
      return refused(401, 'That token is not right.')
    }
    loginLimiter.clear(client)
    c.header('Set-Cookie', adminSessionCookie(adminSessionValue(d.ackSecret, adminToken, d.now()), secureCookie))
    return c.redirect(next, 303)
  })
  // Signing out clears the cookie. GET as well as POST: a link in a browser is the whole feature, and the only effect is ending this session.
  const logout = (c: Context): Response => {
    c.header('Set-Cookie', adminClearCookie(secureCookie))
    c.header('Cache-Control', 'no-store')
    return c.redirect(adminToken === '' ? '/' : '/login', 303)
  }
  app.get('/logout', logout)
  app.post('/logout', logout)

  // Browsers send Origin on every state-changing request; one that is not ours is a cross-site request.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !c.req.path.startsWith('/api/ack')) {
      const origin = c.req.header('origin')
      if (origin && new URL(origin).host !== c.req.header('host')) return c.json({ error: 'cross-site request refused' }, 403)
    }
    await next()
  })

  app.get('/healthz', (c) => c.json({ ok: true }))

  // The brand and the optional views this server backs. The page the server serves already carries it (a meta tag); the dev server's page asks here.
  app.get('/api/instance', (c) => {
    c.header('Cache-Control', 'no-cache')
    return c.json(instance)
  })

  app.get('/api/state', (c) => {
    const state = d.engine.wall()
    const { generatedAt: _generatedAt, ...stable } = state
    const etag = `"${createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 20)}"`
    c.header('ETag', etag)
    c.header('Cache-Control', 'no-cache')
    if (c.req.header('if-none-match') === etag) return c.body(null, 304)
    return c.json(state)
  })

  // The counts a chat panel shows on its status pill while the panel is closed (src/shared/summary.ts: no text, no host). Readable cross-origin by
  // the configured embed origins only, no credentials; the firewall is still the gate, so it adds no port and changes no auth.
  const readableByChat = (c: Context): void => {
    const origin = c.req.header('origin')
    c.header('Vary', 'Origin')
    if (origin && embedOrigins.includes(origin)) c.header('Access-Control-Allow-Origin', origin)
    c.header('Cache-Control', 'no-store')
  }
  app.get('/api/summary', (c) => {
    readableByChat(c)
    return c.json(summaryOf(d.engine.wall()))
  })

  // The card the embed host unfurls under a message that links to an incident (src/shared/card.ts): title, severity, state, service, since, who has it,
  // the link. Readable cross-origin by the same origins as /api/summary, no credentials, no labels, no description. The ref is an incident key or an
  // alert id (<origin>:<fp8>, the id the alert posts link with). An answer for a ref the Watcher has never heard of is 404, with the CORS headers so the
  // page can tell.
  app.get('/api/incident-card/:ref', (c) => {
    readableByChat(c)
    const ref = c.req.param('ref')
    let key = ref
    if (ALERT_ID.test(ref)) {
      const at = ref.lastIndexOf(':')
      const row = d.db.prepare('SELECT incident_key FROM alerts WHERE key = ?').get(`${ref.slice(0, at)}:${ref.slice(at + 1).toLowerCase()}`) as { incident_key: string } | undefined
      if (!row) return c.json({ error: 'not found' }, 404)
      key = row.incident_key
    }
    const card = cardOf({ key, ...d.engine.cardSource(key), baseUrl: d.cfg.baseUrl })
    return card ? c.json(card) : c.json({ error: 'not found' }, 404)
  })

  app.get('/api/incidents/:key', (c) => {
    const key = c.req.param('key')
    const detail = d.engine.incidentDetail(key)
    const notifications = d.db
      .prepare('SELECT at, route_id, channel_id, kind, ok, status, latency_ms FROM results WHERE incident_key = ? ORDER BY id DESC LIMIT 20')
      .all(key)
    if (!detail.incident && detail.alerts.length === 0) return c.json({ error: 'not found' }, 404)
    // `pushed`: for each alert, the senders that push it, when they report next and where the latest re-check request stands (src/shared/recheck.ts), so
    // the sheet can say when the sender runs next without a press. An addition to the alert object: an older wall ignores it.
    const alerts = detail.alerts.map((a) => ({ ...a, pushed: pushedSendersOf({ cfg: d.cfg, store: requests }, a) }))
    return c.json({ ...detail, alerts, notifications })
  })

  app.get('/api/alerts/:key', (c) => {
    const detail = d.engine.alertDetail(c.req.param('key'))
    return detail ? c.json(detail) : c.json({ error: 'not found' }, 404)
  })

  app.get('/api/history', (c) => {
    const hours = Math.min(24 * 30, Math.max(1, Number(c.req.query('hours') ?? d.cfg.historyHours)))
    return c.json({ hours, rows: d.engine.history(hours) })
  })

  // The engine's self-check (src/server/engine.ts, Engine.doctor(): DoctorReport), read by the Doctor view and by the CLI. Admin auth, like the rest
  // of /api. The method is the sibling's (#49): this line compiles once that lands in the parent tree, as the pull merges both.
  app.get('/api/doctor', (c) => { c.header('Cache-Control', 'no-store'); return c.json(d.engine.doctor()) })

  // Fleet metrics: every Netdata Cloud node's CPU, memory, load and root disk now and over the last hour (src/shared/fleet.ts). Read-only, held in memory
  // by the netdata-fleet source and refreshed by its poll, so a request costs nothing. 503 when the source is not configured on this host.
  app.get('/api/fleet', (c) => {
    if (!d.fleet) return c.json({ error: 'fleet metrics are not configured on this host' }, 503)
    c.header('Cache-Control', 'no-store')
    return c.json(d.fleet())
  })

  // Who did it. The Watcher has no login, so the caller names itself: the JSON body's `by` (a string of at most NAME_MAX characters) wins, then
  // the x-watch-user header (percent-encoded, which is how the wall sends it), and a caller that names nobody is "this browser", never "wall".
  type Body = { by?: unknown; minutes?: unknown; state?: unknown; until?: unknown; note?: unknown; ref?: unknown }
  const bodyOf = async (c: Context): Promise<Body> => {
    const raw = (await c.req.json().catch(() => null)) as unknown
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Body) : {}
  }
  const actorOf = (c: Context, body: { by?: unknown }): string => {
    const named = cleanName(body.by)
    return named !== '' && named.toLowerCase() !== 'wall' ? named : actorName(c.req.header('x-watch-user'))
  }

  app.post('/api/incidents/:key/ack', async (c) => {
    const body = await bodyOf(c)
    const ok = d.engine.ack(c.req.param('key'), actorOf(c, body))
    d.nudge()
    return ok ? c.json({ ok }) : c.json({ error: 'not firing' }, 404)
  })
  app.post('/api/incidents/:key/unack', async (c) => {
    const body = await bodyOf(c)
    d.engine.unack(c.req.param('key'), actorOf(c, body))
    d.nudge()
    return c.json({ ok: true })
  })
  app.post('/api/incidents/:key/silence', async (c) => {
    const body = await bodyOf(c)
    const minutes = Math.min(24 * 60, Math.max(1, Number(body.minutes ?? 60)))
    const ok = d.engine.silence(c.req.param('key'), minutes, actorOf(c, body))
    return ok ? c.json({ ok, minutes }) : c.json({ error: 'not firing' }, 404)
  })

  // Park by hand, for any source: take a firing incident off the live wall for at most 72 h (src/shared/incident.ts PARK_MAX_HOURS) once it is fixed or judged, without
  // `resolve`'s reopen loop. Body { by, state: fixed_undeployed | deferred | awaiting_source, until: ISO 8601 with a zone, note (required, at most 500), ref? (at most 64) }.
  // A bad body is a 400 naming the field (a `until` past 72 h is refused, never shortened), an incident that is not firing a 404. A second park replaces the first.
  app.post('/api/incidents/:key/park', async (c) => {
    const body = await bodyOf(c)
    const checked = checkPark(body, d.now())
    if (!checked.ok) return c.json({ error: checked.error }, 400)
    const key = c.req.param('key')
    const by = actorOf(c, body)
    const r = d.engine.park(key, { state: checked.state, until: checked.until, by, note: checked.note, ref: checked.ref })
    if (!r.ok) return c.json({ error: 'not firing' }, 404)
    d.nudge()
    return c.json({ ok: true, key, by, state: checked.state, until: checked.until, replaced: r.replaced })
  })
  // End a park set by hand now: the incident is back in its tier, unattended, and its clock starts here. Body { by, note? }. 404 when not firing, 409 when it was not parked by
  // hand (a park an alert's annotations state ends when they stop stating it) or its park has already ended.
  app.post('/api/incidents/:key/unpark', async (c) => {
    const body = await bodyOf(c)
    const n = checkOptionalText(body.note, 'note', REASON_MAX)
    if (!n.ok) return c.json({ error: n.error }, 400)
    const key = c.req.param('key')
    const r = d.engine.unpark(key, actorOf(c, body), n.text)
    d.nudge()
    if (r.ok) return c.json({ ok: true, key, at: r.at })
    return r.error === 'not firing' ? c.json({ error: 'not firing' }, 404) : c.json({ error: r.error === 'park ended' ? `its park already ended at ${r.endedAt}` : 'not parked by hand' }, 409)
  })

  // The fix loop's two reads and its awaited verification (src/server/mcp/fix-context.ts). They are under the admin gate like the
  // rest of /api: the brief names the source's config (env-var names only), and the verification writes the confirmation event.
  // `GET .../fix-context` answers one bounded brief; `POST .../recheck` is one round of re-checks of the incident's firing alerts;
  // `POST .../verify` is the round plus the wait and the confirm that `watcher recheck <key> --wait` and the MCP `verify_fix` use.
  app.get('/api/incidents/:key/fix-context', (c) => {
    c.header('Cache-Control', 'no-store')
    const r = fixContextOf(c.req.param('key'), { engine: d.engine, cfg: d.cfg, nowMs: d.now })
    return r.ok ? c.json(r.brief) : c.json({ error: r.error }, 404)
  })
  app.post('/api/incidents/:key/recheck', async (c) => {
    if (!d.recheck) return c.json({ error: 're-check is not available' }, 503)
    const key = c.req.param('key')
    const detail = d.engine.incidentDetail(key)
    if (!detail.incident && detail.alerts.length === 0) return c.json({ error: 'not found' }, 404)
    const body = await bodyOf(c)
    const named = cleanName(body.by)
    const by = named !== '' && named.toLowerCase() !== 'wall' ? named : 'watcher CLI'
    const firing = detail.alerts.filter((a) => a.resolvedAt === null)
    const answers = (
      await Promise.all(firing.slice(0, 10).map((a) => d.recheck!.alert(a.key, { via: 'wall', by })))
    ).filter((x): x is AlertRecheck => x !== null)
    c.header('Cache-Control', 'no-store')
    return c.json({
      key,
      at: new Date(d.now()).toISOString(),
      alerts: answers,
      resolved: !d.engine.isFiring(key),
      stillFiring: d.engine.incidentDetail(key).alerts.filter((a) => a.resolvedAt === null).length
    })
  })
  app.post('/api/incidents/:key/verify', async (c) => {
    if (!d.recheck) return c.json({ error: 're-check is not available' }, 503)
    const body = await bodyOf(c)
    const rawTimeout = (body as { timeoutSec?: unknown }).timeoutSec
    if (rawTimeout !== undefined && (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout))) {
      return c.json({ error: `timeoutSec must be a number from ${VERIFY_MIN_TIMEOUT_SEC} to ${VERIFY_MAX_TIMEOUT_SEC}` }, 400)
    }
    const named = cleanName(body.by)
    const by = named !== '' && named.toLowerCase() !== 'wall' ? named : 'watcher CLI'
    const r = await verifyFix(
      { engine: d.engine, recheck: d.recheck, nowMs: d.now, log },
      c.req.param('key'),
      by,
      { timeoutSec: rawTimeout as number | undefined }
    )
    c.header('Cache-Control', 'no-store')
    return r.ok ? c.json(r.result) : c.json({ error: r.error }, 404)
  })

  // On-demand re-check: poll the pull sources now. One poll per source at most every RECHECK_GAP_SEC, and a click while a poll runs
  // shares it (src/server/recheck.ts). Same-origin only, like every state-changing call; nothing here writes except through the
  // engine's own ingest.
  app.post('/api/recheck', async (c) => {
    if (!d.recheck) return c.json({ error: 're-check is not available' }, 503)
    c.header('Cache-Control', 'no-store')
    return c.json(await d.recheck.all())
  })
  app.post('/api/recheck/:key', async (c) => {
    if (!d.recheck) return c.json({ error: 're-check is not available' }, 503)
    c.header('Cache-Control', 'no-store')
    // A pushing sender that takes requests is asked on behalf of whoever the wall says is pressing, "wall" when it says nobody.
    const named = actorName(c.req.header('x-watch-user'))
    const answer = await d.recheck.alert(c.req.param('key'), { via: 'wall', by: named === FALLBACK_NAME ? 'wall' : named })
    return answer ? c.json(answer) : c.json({ error: 'not found' }, 404)
  })

  // The one-tap acknowledge carried by notification actions: authenticated by the HMAC, not by the caller.
  const ackLink = (c: Context) => {
    const k = c.req.query('k') ?? ''
    const s = c.req.query('s') ?? ''
    if (!k || !verifyAckSignature(d.ackSecret, k, s)) return c.json({ error: 'bad signature' }, 403)
    const ok = d.engine.ack(k, NOTIFICATION_NAME)
    d.nudge()
    return c.json({ ok })
  }
  app.post('/api/ack', ackLink)
  app.get('/api/ack', ackLink)

  // The click target of the content-free notice on a public ntfy server: /go/<HMAC of the incident key>. It opens the incident on the
  // wall when the token is one this server issued, and the wall otherwise. Always a redirect, never an echo of the token.
  app.get('/go/:token', (c) => {
    const rows = d.db.prepare('SELECT DISTINCT incident_key FROM alerts').all() as Array<{ incident_key: string }>
    const key = findNoticeKey(d.ackSecret, c.req.param('token'), rows.map((r) => r.incident_key))
    c.header('Cache-Control', 'no-store')
    return c.redirect(key ? `/#/i/${encodeURIComponent(key)}` : '/', 302)
  })

  // The per-alert link: /a/<origin>:<fp8>, the alert's own key (origin and the first 8 hex of its fingerprint). It opens the alert's incident on
  // the wall, and the wall for an id it does not know. The id names no alert text, only where the alert came from and a hash, so the URL is safe to
  // post. Always a redirect, never an echo.
  app.get('/a/:id', (c) => {
    const id = c.req.param('id')
    const at = id.lastIndexOf(':')
    const key = ALERT_ID.test(id) ? `${id.slice(0, at)}:${id.slice(at + 1).toLowerCase()}` : ''
    const row = key ? (d.db.prepare('SELECT incident_key FROM alerts WHERE key = ?').get(key) as { incident_key: string } | undefined) : undefined
    c.header('Cache-Control', 'no-store')
    // ?embed=1 (the chat panel) lands in the embed view, with the parent's scheme carried over
    const theme = c.req.query('theme')
    const base = c.req.query('embed') === '1' ? `/embed${theme === 'dark' || theme === 'light' ? `?theme=${theme}` : ''}` : '/'
    return c.redirect(row ? `${base}#/i/${encodeURIComponent(row.incident_key)}` : base, 302)
  })

  app.get('/api/notifications', (c) => {
    const results = d.db
      .prepare('SELECT at, incident_key, route_id, channel_id, kind, ok, status, latency_ms FROM results ORDER BY id DESC LIMIT 40')
      .all()
    return c.json({
      channels: d.engine.channelProofs(),
      routes: d.cfg.routes,
      quietHours: d.cfg.quietHours,
      results,
      push: { publicKey: d.vapidPublicKey, subscribers: d.push.list().length }
    })
  })

  app.post('/api/notifications/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { channel?: string }
    if (!body.channel || !d.cfg.channels.some((x) => x.id === body.channel)) return c.json({ error: 'unknown channel' }, 400)
    const r = await d.testChannel(body.channel)
    return c.json(r)
  })

  // The CLI's test message (`watcher notify --test`): every configured channel, or the one `?channel=id` names, each through d.testChannel exactly as
  // the wall's Notifications page does, so a channel's proof of life is the same whichever door is used. Admin auth, like the rest of /api, so it is
  // the token a script signs in with; no browser cookie is needed. A host with no channels is a 409 naming that, not an empty success.
  app.post('/api/test-notify', async (c) => {
    const only = c.req.query('channel')
    const ids = d.cfg.channels.map((x) => x.id)
    if (only !== undefined && !ids.includes(only)) return c.json({ error: `unknown channel ${only}` }, 404)
    const targets = only === undefined ? ids : [only]
    if (targets.length === 0) return c.json({ error: 'no channels are configured on this host' }, 409)
    c.header('Cache-Control', 'no-store')
    const results: Array<{ channel: string; ok: boolean; status: string; latencyMs: number }> = []
    for (const id of targets) results.push({ channel: id, ...(await d.testChannel(id)) })
    return c.json({ ok: results.every((r) => r.ok), results })
  })

  app.post('/api/push/subscribe', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null
    if (!b?.endpoint || !b.keys?.p256dh || !b.keys.auth || !/^https:\/\//.test(b.endpoint)) return c.json({ error: 'bad subscription' }, 400)
    d.push.add({ endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } }, c.req.header('user-agent') ?? '', new Date(d.now()).toISOString())
    return c.json({ ok: true })
  })
  app.post('/api/push/unsubscribe', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { endpoint?: string } | null
    if (b?.endpoint) d.push.remove(b.endpoint)
    return c.json({ ok: true })
  })

  // The webhook source an /ingest request names, once its credential is right: the source, or the answer to send instead (404 for an id that is not a
  // webhook source, 401 for a bad credential). A source accepts either credential it is configured for: the Bearer token named by `tokenEnv`, or the
  // signed-webhook HMAC its `verify` block names (GitHub's X-Hub-Signature-256, Stripe-Signature, a generic HMAC header), verified over the exact
  // bytes the sender signed. `rawBody` is those bytes; null on a route that takes no body or never verifies one (the re-check requests).
  const webhookSource = (c: Context, rawBody: Buffer | null): { source: WebhookSourceConfig } | { fail: Response } => {
    const source = d.cfg.sources.find((s) => s.type === 'webhook' && s.id === c.req.param('source'))
    if (!source || source.type !== 'webhook') return { fail: c.json({ error: 'unknown source' }, 404) }
    const expected = source.tokenEnv ? (d.env[source.tokenEnv] ?? '') : ''
    if (expected !== '' && adminBearerMatches(c.req.header('authorization'), expected)) return { source }
    if (source.verify && rawBody !== null) {
      const secret = d.env[source.verify.secretEnv] ?? ''
      const verdict = verifyWebhookRequest(rawBody, c.req.raw.headers, source.verify, [secret], Math.floor(d.now() / 1000))
      if (verdict.ok) return { source }
    }
    return { fail: c.json({ error: 'unauthorized' }, 401) }
  }

  // Re-check requests for a pushing sender (src/server/push-recheck.ts). The same Bearer token as the push, registered before /ingest/:source and the
  // static fallback so neither can answer them. A source without `recheckRequests` in the config answers 404.
  // GET: the open requests, oldest first, at most 20; the first read of one claims it and it comes back until closed or expired.
  app.get('/ingest/:source/recheck-requests', (c) => {
    const found = webhookSource(c, null)
    if ('fail' in found) return found.fail
    if (!requestable(d.cfg, found.source.id)) return c.json({ error: 'this source takes no re-check requests' }, 404)
    c.header('Cache-Control', 'no-store')
    return c.json({ requests: requests.poll(found.source.id) })
  })
  // POST: the sender's answer to one request: { outcome: ran | dispatched | failed | unsupported, note?: string }. 204 on success.
  app.post('/ingest/:source/recheck-requests/:id', async (c) => {
    const found = webhookSource(c, null)
    if ('fail' in found) return found.fail
    if (!requestable(d.cfg, found.source.id)) return c.json({ error: 'this source takes no re-check requests' }, 404)
    const raw = await readCapped(c.req.raw, 16_384)
    if (raw === null) return c.json({ error: 'body too large' }, 413)
    let body: unknown = null
    try {
      body = JSON.parse(raw) as unknown
    } catch {
      return c.json({ error: 'bad body', detail: 'not JSON' }, 400)
    }
    const answer = parseOutcome(body)
    if (!answer) return c.json({ error: 'bad body', detail: 'outcome must be ran, dispatched, failed or unsupported, and note text' }, 400)
    if (!requests.answer(found.source.id, c.req.param('id'), answer.outcome, answer.note)) return c.json({ error: 'unknown request' }, 404)
    return c.body(null, 204)
  })

  // A scheduled job's ping (src/server/sources/heartbeat.ts): GET|POST /ingest/heartbeat/<source id>, then /start, /fail or /<exit-code>, with the source's
  // token as a Bearer or ?token= (healthchecks.io's paths). The answer carries the source's whole state, so an ok ping resolves its own incident and a
  // failing one raises it. An id that is not a heartbeat source is a 404 and a wrong token is a 401, like every other ingest.
  const heartbeatPing = (c: Context, action: string | undefined): Response => {
    const source = d.cfg.sources.find((s): s is HeartbeatSourceConfig => s.type === 'heartbeat' && s.id === c.req.param('id'))
    if (!source) return c.json({ error: 'unknown source' }, 404)
    const heartbeat = heartbeatSource(source, {
      env: d.env,
      fetch: d.fetch ?? fetch,
      nowIso: () => new Date(d.now()).toISOString(),
      serviceMap: d.cfg.serviceMap,
      log
    })
    const answer = heartbeat.handle(action, c.req.query('token'), c.req.header('authorization'))
    if (answer.observation) {
      d.engine.ingest(answer.observation)
      d.engine.recordSource(source.id, true, null)
      d.nudge()
    }
    return c.json(answer.body, answer.status as 200 | 401 | 404)
  }
  app.all('/ingest/heartbeat/:id', (c) => heartbeatPing(c, undefined))
  app.all('/ingest/heartbeat/:id/:action', (c) => heartbeatPing(c, c.req.param('action')))

  // Alertmanager v4, Grafana and Netdata webhooks. Needs the webhook source's Bearer token, or a signature its `verify` block accepts. The body is
  // read as bytes before the credential is checked: a signed-webhook HMAC is over the exact bytes, and Hono hands a body to the parser only once.
  app.post('/ingest/:source', async (c) => {
    if (Number(c.req.header('content-length') ?? '0') > 1_048_576) return c.json({ error: 'body too large' }, 413)
    const rawBody = Buffer.from(await c.req.arrayBuffer())
    if (rawBody.byteLength > 1_048_576) return c.json({ error: 'body too large' }, 413)
    const found = webhookSource(c, rawBody)
    if ('fail' in found) return found.fail
    const { source } = found
    const raw = rawBody.toString('utf8')
    try {
      const payload = JSON.parse(raw) as unknown
      const obs = d.normalizeWebhook(payload, { source: source.id, headerSource: c.req.header('x-alert-source'), netdata: source.netdata })
      d.engine.ingest(obs)
      d.engine.recordSource(source.id, true, null)
      // The sender may say when it reports next: kept when it is in range, ignored otherwise, and never a reason to refuse the push.
      if (typeof payload === 'object' && payload !== null && 'nextReportAt' in payload) requests.setNextReportAt(source.id, (payload as { nextReportAt?: unknown }).nextReportAt)
      d.nudge()
      return c.json({ ok: true, firing: obs.firing.length, resolved: obs.resolved.length, ...(obs.checks ? { checks: obs.checks.cells.length } : {}) })
    } catch (err) {
      if (err instanceof BadPayload) return c.json({ error: 'bad payload', detail: err.message }, 400)
      if (err instanceof SyntaxError) return c.json({ error: 'bad payload' }, 400)
      throw err
    }
  })

  // The MCP server (src/server/mcp): Streamable HTTP, stateless, behind `Authorization: Bearer <WATCHER_MCP_TOKEN>`. Every request without the token
  // is a 401, including when this host has none configured. Registered before the static fallback, which would otherwise answer it.
  const mcp = createMcpHandler(
    {
      engine: d.engine,
      db: d.db,
      cfg: d.cfg,
      nowMs: d.now,
      recheck: d.recheck,
      nudge: d.nudge,
      log
    },
    () => d.env.WATCHER_MCP_TOKEN
  )
  app.all('/mcp', async (c) => {
    // MCP Streamable HTTP, Security Warning item 1: "Servers MUST validate the Origin header on all incoming connections to
    // prevent DNS rebinding attacks" (modelcontextprotocol.io/specification/2025-06-18/basic/transports, retrieved 2026-11-04).
    // A request with no Origin (a CLI or an agent) passes on its token; a browser Origin must be this Watcher or an embed origin.
    const refusal = mcpOriginRefusal(c.req.header('origin'), c.req.header('host') ?? new URL(c.req.url).host, d.cfg.baseUrl, embedOrigins)
    if (refusal) {
      c.header('Cache-Control', 'no-store')
      return c.json(refusal, 403)
    }
    return mcp(c.req.raw)
  })

  // Static app shell, with a single-page fallback for hash-less deep links.
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/ingest/')) return c.json({ error: 'not found' }, 404)
    const rel = normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, '')
    let file = join(d.webDir, rel)
    if (!file.startsWith(d.webDir + sep) && file !== d.webDir) return c.json({ error: 'not found' }, 404)
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(d.webDir, 'index.html')
    if (!existsSync(file)) return c.text('app not built', 503)
    const ext = extname(file)
    c.header('Content-Type', MIME[ext] ?? 'application/octet-stream')
    const immutable = file.includes(`${sep}assets${sep}`)
    c.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
    if (file.endsWith('sw.js')) c.header('Service-Worker-Allowed', '/')
    // The app shell and the manifest carry this Watcher's name (src/server/instance.ts); every other file is served as built.
    if (file === join(d.webDir, 'index.html')) return c.body(pageWithInstance(readFileSync(file, 'utf8'), instance))
    if (file === join(d.webDir, 'manifest.webmanifest')) return c.body(manifestWithBrand(readFileSync(file, 'utf8'), instance.brand))
    return c.body(readFileSync(file))
  })

  return app
}
