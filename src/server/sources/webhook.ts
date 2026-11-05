// Webhook source: one POSTed notification becomes one Observation. Three payloads are accepted. The first two are told apart
// by the fields only Grafana sends:
//  - Alertmanager webhook v4: version "4", groupKey, receiver, alerts[{status, labels, annotations, startsAt,
//    endsAt, generatorURL, fingerprint}].
//  - Grafana webhook: the same alert fields plus orgId and, per alert, silenceURL, dashboardURL, panelURL,
//    values, valueString, imageURL (grafana/alerting templates/template_data.go ExtendedAlert).
//  - Netdata Cloud: no `alerts` list at all, one alert (or one reachability change) per body. sources/netdata.ts reads it.
// A webhook never holds the complete set, so `complete` is false and a missing alert is not a resolution.
// Any of them may also carry `checks`, the sender's check list (sources/checks.ts), alone or beside its alerts.
// The feed source (sources/feed.ts) reads the same body with GET instead of taking it by POST: it parses it here, the one parser, with its own
// origin and kind, and marks the result complete itself (a feed answers with its whole state).

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Alert, AlertLinks, Observation, SourceKind } from '../../shared/types.ts'
import type { NetdataWebhookConfig, WebhookVerifyConfig } from '../config.ts'
import { verifyStripeSignature } from '../stripe-signature.ts'
import { makeAlert } from '../derive.ts'
import { hasChecks, parseChecks } from './checks.ts'
import { normalizeNetdata, payloadKeys } from './netdata.ts'
import type { SourceDeps } from './types.ts'
import { BadPayload, isDeadMansPing, isoOrNull, isRecord, markResolved, ruleNameOf, safeUrl, stringMap, valueText } from './shared.ts'

export { BadPayload }

/** The bridge keeps at most this many alerts of one payload. */
export const MAX_ALERTS = 400

export interface WebhookContext {
  /** The webhook source id from config; also the origin when the sender names none. */
  source: string
  /** X-Alert-Source (dev or prod): api-router names its namespace here. */
  headerSource?: string
  /** The sender, fixed by the config rather than a header (a feed's `origin`). Wins over `headerSource`. */
  origin?: string
  /** The kind the alerts are seen through. Default webhook; a feed passes its own. */
  kind?: Extract<SourceKind, 'webhook' | 'feed'>
  /** The source's Netdata adapter config (the host-disk rule list), when the sender is Netdata Cloud. */
  netdata?: NetdataWebhookConfig
  deps: SourceDeps
}

type Flavor = 'alertmanager' | 'grafana'

const HEADER_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function normalizeWebhook(payload: unknown, ctx: WebhookContext): Observation {
  if (!isRecord(payload)) throw new BadPayload('payload must be a JSON object')
  const now = ctx.deps.nowIso()
  const origin = originOf(ctx)
  // A check list (sources/checks.ts) rides with the sender's alerts or alone; it never changes an alert.
  const checks = hasChecks(payload) ? parseChecks(payload.checks, { origin, source: ctx.source, now }) : undefined
  const kind = ctx.kind ?? 'webhook'
  if (!Array.isArray(payload.alerts)) {
    if (checks) return { source: ctx.source, kind, at: now, firing: [], resolved: [], complete: false, checks }
    // Netdata Cloud sends one alert per body with no list; anything else without a list is still a bad payload.
    const netdata = normalizeNetdata(payload, { source: ctx.source, deps: ctx.deps, grafanaDiskHosts: ctx.netdata?.grafanaDiskHosts, netdataHosts: ctx.netdata?.netdataHosts })
    if (netdata) return netdata
    ctx.deps.log?.(`webhook ${ctx.source}: rejected a body with no alerts list (fields ${payloadKeys(payload)})`)
    throw new BadPayload('payload has no alerts list')
  }
  const flavor = flavorOf(payload, payload.alerts)
  if (!flavor) throw new BadPayload('payload is neither an Alertmanager v4 nor a Grafana webhook')
  const firing: Alert[] = []
  const resolved: Alert[] = []
  const seen = new Set<string>()
  for (const [i, raw] of payload.alerts.entries()) {
    if (firing.length + resolved.length >= MAX_ALERTS) break
    const built = toAlert(raw, i, { flavor, origin, ctx, now })
    if (!built || seen.has(built.alert.key)) continue
    seen.add(built.alert.key)
    const bucket = built.resolved ? resolved : firing
    bucket.push(built.alert)
  }
  return { source: ctx.source, kind, at: now, firing, resolved, complete: false, ...(checks ? { checks } : {}) }
}

function flavorOf(payload: Record<string, unknown>, alerts: unknown[]): Flavor | null {
  if ('orgId' in payload || alerts.some((a) => isRecord(a) && 'silenceURL' in a)) return 'grafana'
  if (payload.version === '4' || typeof payload.groupKey === 'string') return 'alertmanager'
  return null
}

function originOf(ctx: WebhookContext): string {
  if (ctx.origin) return ctx.origin
  const header = ctx.headerSource?.trim()
  return header && HEADER_SOURCE.test(header) ? header : ctx.source
}

interface Built {
  alert: Alert
  resolved: boolean
}

interface Env {
  flavor: Flavor
  origin: string
  ctx: WebhookContext
  now: string
}

function toAlert(raw: unknown, i: number, env: Env): Built | null {
  if (!isRecord(raw)) throw new BadPayload(`alerts[${i}] must be an object`)
  if (raw.status !== 'firing' && raw.status !== 'resolved') {
    throw new BadPayload(`alerts[${i}].status must be firing or resolved`)
  }
  if (!isRecord(raw.labels)) throw new BadPayload(`alerts[${i}].labels must be an object`)
  const labels = stringMap(raw.labels)
  if (isDeadMansPing(labels)) return null
  const annotations = stringMap(raw.annotations)
  const isResolved = raw.status === 'resolved'
  const endsAt = isResolved ? (isoOrNull(raw.endsAt) ?? env.now) : undefined
  const links = linksOf(raw, annotations, env.flavor)
  const alert = makeAlert(
    {
      origin: env.origin,
      fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : undefined,
      rule: ruleNameOf(labels),
      labels,
      annotations,
      startsAt: isoOrNull(raw.startsAt) ?? env.now,
      endsAt,
      generatorURL: safeUrl(raw.generatorURL),
      value: env.flavor === 'grafana' ? valueText(raw.values, raw.valueString) : undefined,
      links,
      via: { source: env.ctx.source, kind: env.ctx.kind ?? 'webhook', lastSeen: env.now },
      raw
    },
    env.ctx.deps.serviceMap,
    env.now
  )
  return { alert: endsAt ? markResolved(alert, endsAt) : alert, resolved: isResolved }
}

function linksOf(raw: Record<string, unknown>, annotations: Record<string, string>, flavor: Flavor): AlertLinks {
  const links: AlertLinks = {}
  const generator = safeUrl(raw.generatorURL)
  if (generator && (flavor === 'grafana' || hasDottedHost(generator))) links.generator = generator
  const runbook = safeUrl(annotations.runbook_url)
  if (runbook) links.runbook = runbook
  if (flavor === 'grafana') {
    const dashboard = safeUrl(raw.dashboardURL)
    const panel = safeUrl(raw.panelURL)
    const silence = safeUrl(raw.silenceURL)
    if (dashboard) links.dashboard = dashboard
    if (panel) links.panel = panel
    if (silence) links.silence = silence
  }
  return links
}

/**
 * An Alertmanager generatorURL is linked only when its host has a dot: an undotted host is an in-cluster service name nobody
 * outside the cluster can open.
 */
function hasDottedHost(url: string): boolean {
  return new URL(url).hostname.includes('.')
}

// ---- signed-webhook verification ----------------------------------------------------------------------------------------------------
// A webhook source's optional `verify` block (src/server/config.ts). GitHub and Stripe cannot set an Authorization header, so they sign the body
// instead: GitHub with X-Hub-Signature-256 (`sha256=<hex>`), Stripe with Stripe-Signature (`t=<sec>,v1=<hex>` over `<t>.<body>`, five minute
// replay window, src/server/stripe-signature.ts), and a generic sender with an HMAC-SHA256 of the body in a header of its own. All three are
// checked over the exact bytes of the request body and compared in constant time; a missing secret refuses the push (it never falls open).

export type WebhookVerifyVerdict = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' | 'stale' | 'no secret' }

/** The header a scheme reads when the config names none. */
export function verifyHeaderOf(cfg: WebhookVerifyConfig): string {
  if (cfg.header) return cfg.header.toLowerCase()
  if (cfg.scheme === 'github') return 'x-hub-signature-256'
  if (cfg.scheme === 'stripe') return 'stripe-signature'
  return 'x-signature-256'
}

/** `HMAC-SHA256(secret, body)` as lowercase hex: what a generic sender puts in its header, and what the tests sign with. */
export function hmacSha256Hex(body: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/** The hex of a `sha256=<hex>` or bare `<hex>` header value, or '' when it is neither. */
function hexOf(header: string, prefixed: boolean): string {
  const m = (prefixed ? /^sha256=([0-9a-fA-F]{64})$/ : /^(?:sha256=)?([0-9a-fA-F]{64})$/).exec(header.trim())
  return m ? m[1].toLowerCase() : ''
}

/**
 * Verify one push. `headers` is the request's headers, `rawBody` its exact bytes, `secrets` the values `secretEnv` resolved to (an empty list and
 * an empty value both refuse). `nowSec` and `toleranceSec` are the Stripe replay window; the other schemes carry no timestamp. Never throws.
 */
export function verifyWebhookRequest(
  rawBody: Buffer | string,
  headers: { get(name: string): string | null },
  cfg: WebhookVerifyConfig,
  secrets: readonly string[],
  nowSec: number,
  toleranceSec = 300
): WebhookVerifyVerdict {
  const keys = secrets.filter((s) => s !== '')
  if (keys.length === 0) return { ok: false, reason: 'no secret' }
  const header = headers.get(verifyHeaderOf(cfg))
  if (!header) return { ok: false, reason: 'missing' }
  if (cfg.scheme === 'stripe') {
    const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')
    const verdict = verifyStripeSignature(text, header, keys, nowSec, toleranceSec)
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason }
  }
  const provided = hexOf(header, cfg.scheme === 'github')
  if (provided === '') return { ok: false, reason: 'malformed' }
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody
  const got = Buffer.from(provided, 'hex')
  let matched = false
  // Every key is tried and every comparison runs, so neither a wrong key nor a right one short-circuits on the first byte that differs.
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(body).digest()
    if (got.length === expected.length && timingSafeEqual(got, expected)) matched = true
  }
  return matched ? { ok: true } : { ok: false, reason: 'mismatch' }
}
