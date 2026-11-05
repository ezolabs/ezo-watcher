// domain-expiry source: Watch reads each domain's own registrar expiry over RDAP, so a domain that lapses is visible even while its certificate
// still looks fine. http-probe's CertExpiring covers the certificate; nothing else covered the registration it belongs to.
//
// RDAP is the IANA protocol whois was replaced with: `GET https://rdap.org/domain/<domain>` bootstraps to the registry's own server (for a .com,
// rdap.verisign.com) and answers JSON whose `events` list carries the `expiration` entry. The lookup is one GET per domain per poll, every 12
// hours by default: a registrar expiry moves on the scale of days, and rdap.org is a shared public service. gTLD records answer this; a TLD
// whose registry publishes no expiration event leaves that domain's cell without data (skipped) rather than guessing from whois.
//
// The tiers are CertExpiring's, one order of magnitude out: under `warnDays` (default 30) left is the DomainExpiring warning, under `pageDays`
// (default 7) a page, and one tier resolves the other. An expired domain still pages, with "has expired" in the words. A lookup that fails
// (the registry down, rate-limiting, a 404 for a domain it does not hold) fires and resolves nothing: a failed read is not evidence of expiry,
// and the cell reads "no data" with the reason, so a blind lookup is visible on the wall.

import { createHash } from 'node:crypto'
import type { Alert, ChecksPush, Observation, Severity } from '../../shared/types.ts'
import type { DomainExpirySourceConfig } from '../config.ts'
import { makeAlert } from '../derive.ts'
import { parseChecks } from './checks.ts'
import type { PolledSource, SourceDeps } from './types.ts'
import { REQUEST_TIMEOUT_MS, clip, isRecord, markResolved, readBodyCapped, requestFailure } from './shared.ts'

export const DOMAIN_EXPIRY_DEFAULTS = {
  pollSec: 43_200,
  warnDays: 30,
  pageDays: 7
} as const

/** The alert class: the same word the certificate signal uses, for a different thing that expires. */
export const DOMAIN_RULES = { expiring: 'DomainExpiring' } as const

/** What each cell proves beyond "the poll ran" (RuleCell.asserts): the predicate a red cell falsifies. */
export const DOMAIN_ASSERTS = {
  /** The registry record's expiration is more than the page threshold of days away. */
  expires: (pageDays: number): string => `rdap:expires>${pageDays}d`
} as const

/** The most of an RDAP record a lookup reads. A record is tens of kilobytes; a megabyte is already not one. */
export const RDAP_MAX_BODY_BYTES = 1_048_576

const DAY_MS = 86_400_000

// ---- one lookup -----------------------------------------------------------------------------------

/** RDAP's bootstrap redirects to the registry that holds the domain; the URL is stable and public, so it is also the alert's evidence link. */
export const RDAP_BASE = 'https://rdap.org/domain/'

export function rdapUrl(domain: string): string {
  return `${RDAP_BASE}${encodeURIComponent(domain)}`
}

export type DomainExpiryResult = { ok: true; expiresAtMs: number } | { ok: false; detail: string }

/**
 * GET one domain's registry record and read its `expiration` event. Never throws: every way it can fail comes back as a result naming what
 * happened, never the record's body. `fetchImpl` is the host's fetch, so a test stands in for the network with a recorded record.
 */
export async function readDomainExpiry(fetchImpl: typeof fetch, domain: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<DomainExpiryResult> {
  let res: Response
  try {
    res = await fetchImpl(rdapUrl(domain), {
      headers: { Accept: 'application/rdap+json', 'User-Agent': 'ezo-watcher-probe' },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    return { ok: false, detail: `no answer: ${requestFailure(err, timeoutMs)}` }
  }
  if (!res.ok) return { ok: false, detail: `RDAP answered HTTP ${res.status}` }
  let body: string | null
  try {
    body = await readBodyCapped(res, RDAP_MAX_BODY_BYTES)
  } catch {
    return { ok: false, detail: 'the RDAP record could not be read' }
  }
  if (body === null) return { ok: false, detail: 'the RDAP record is over 1 MiB' }
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, detail: 'the RDAP record is not JSON' }
  }
  if (!isRecord(json)) return { ok: false, detail: 'the RDAP record is not an object' }
  let expiration: Record<string, unknown> | undefined
  if (Array.isArray(json.events)) {
    for (const event of json.events) {
      if (isRecord(event) && event.eventAction === 'expiration') {
        expiration = event
        break
      }
    }
  }
  if (!expiration) return { ok: false, detail: 'the RDAP record has no expiration event' }
  const at = typeof expiration.eventDate === 'string' ? Date.parse(expiration.eventDate) : Number.NaN
  if (!Number.isFinite(at) || at <= 0) return { ok: false, detail: 'the RDAP expiration date is not a time' }
  return { ok: true, expiresAtMs: at }
}

// ---- the poll's arithmetic ------------------------------------------------------------------------

/** One domain's lookup, this poll. */
export interface DomainReading {
  domain: string
  expiry: DomainExpiryResult
}

export interface DomainExpiryContext {
  nowIso: string
  serviceMap: SourceDeps['serviceMap']
}

const sha = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)

const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** "12 days", "1 day", "under a day", and "expired" for a date already past. */
function daysText(ms: number): string {
  if (ms <= 0) return 'expired'
  const days = Math.floor(ms / DAY_MS)
  return days === 0 ? 'under a day' : `${days} day${days === 1 ? '' : 's'}`
}

/** "every 12 h" for a whole number of hours, else "every 90 s". */
function everyText(pollSec: number): string {
  return pollSec % 3600 === 0 ? `every ${pollSec / 3600} h` : `every ${pollSec} s`
}

/** The predicate a cell proves, attached to the cell after parseChecks (and repeated in the list entry, for a parseChecks that keeps it). */
function assertedCells(checks: ChecksPush, byRuleAndName: ReadonlyMap<string, string[]>): void {
  for (const cell of checks.cells) {
    const asserts = byRuleAndName.get(`${cell.checkId ?? ''}\u0000${cell.name}`)
    if (asserts) cell.asserts = asserts
  }
}

/**
 * One poll's readings as the Observation. Pure: no clock, no network. DomainExpiring fires the tier the days left fall in and resolves the other;
 * a lookup that could not be read fires and resolves nothing and its cell reads "no data" with the reason.
 */
export function normalizeDomainExpiry(readings: DomainReading[], cfg: DomainExpirySourceConfig, ctx: DomainExpiryContext): Observation {
  const pollSec = cfg.pollSec ?? DOMAIN_EXPIRY_DEFAULTS.pollSec
  const warnDays = cfg.warnDays ?? DOMAIN_EXPIRY_DEFAULTS.warnDays
  const pageDays = cfg.pageDays ?? DOMAIN_EXPIRY_DEFAULTS.pageDays
  const service = cfg.service ?? cfg.id
  const nowMs = Date.parse(ctx.nowIso)
  const firing: Alert[] = []
  const resolved: Alert[] = []
  const list: Array<Record<string, unknown>> = []
  const asserted = new Map<string, string[]>()

  for (const { domain, expiry } of readings) {
    const d = domain.toLowerCase()
    const link = rdapUrl(d)
    const build = (severity: Extract<Severity, 'page' | 'warning'>, words: { summary: string; description: string; value: string }, raw: unknown, tier = ''): Alert =>
      makeAlert(
        {
          origin: cfg.id,
          fingerprint: sha('domain-expiry', cfg.id, d, DOMAIN_RULES.expiring, tier),
          rule: DOMAIN_RULES.expiring,
          labels: { alertname: DOMAIN_RULES.expiring, severity, service, instance: d, domain: d },
          annotations: { summary: clip(words.summary, 220), description: words.description, ...(severity === 'page' ? { page_reason: clip(words.summary, 220) } : {}) },
          startsAt: ctx.nowIso,
          generatorURL: link,
          links: { generator: link },
          value: clip(words.value, 120),
          via: { source: cfg.id, kind: 'domain-expiry', lastSeen: ctx.nowIso, url: link },
          raw
        },
        ctx.serviceMap,
        ctx.nowIso
      )
    const asserts = [DOMAIN_ASSERTS.expires(pageDays)]
    const cell = (state: 'ok' | 'failing' | 'skipped', detail: string): void => {
      const rule = DOMAIN_RULES.expiring
      list.push({ id: rule, instance: d, service, state, ...(state === 'skipped' ? {} : { lastRunAt: ctx.nowIso }), detail: clip(detail, 230), url: link, asserts })
      asserted.set(`${rule}\u0000${d}`, asserts)
    }
    if (!expiry.ok) {
      cell('skipped', `RDAP lookup failed: ${expiry.detail}`)
      continue
    }
    const left = expiry.expiresAtMs - nowMs
    const when = `${daysText(left)} (${dateOf(expiry.expiresAtMs)})`
    const alert = (tier: Extract<Severity, 'page' | 'warning'>): Alert =>
      build(
        tier,
        {
          summary: left <= 0 ? `The domain ${d} has expired (${dateOf(expiry.expiresAtMs)})` : `The domain ${d} expires in ${when}`,
          description:
            `Watch asks the registry's RDAP record for ${d} ${everyText(pollSec)}. Under ${warnDays} days left is a warning and under ${pageDays} days a page; ` +
            'renewing it with the registrar resolves this at the next lookup.',
          value: left <= 0 ? `expired ${dateOf(expiry.expiresAtMs)}` : `expires in ${when}`
        },
        { domain: d, expires: new Date(expiry.expiresAtMs).toISOString(), daysLeft: Math.floor(left / DAY_MS) },
        tier
      )
    const tier: Extract<Severity, 'page' | 'warning'> | null = left < pageDays * DAY_MS ? 'page' : left < warnDays * DAY_MS ? 'warning' : null
    if (tier) {
      firing.push(alert(tier))
      resolved.push(markResolved(alert(tier === 'page' ? 'warning' : 'page'), ctx.nowIso))
      cell('failing', left <= 0 ? `expired ${dateOf(expiry.expiresAtMs)}` : `expires in ${when}`)
    } else {
      resolved.push(markResolved(alert('page'), ctx.nowIso), markResolved(alert('warning'), ctx.nowIso))
      cell('ok', `expires in ${when}`)
    }
  }

  let checks: ChecksPush | undefined
  if (list.length > 0) {
    checks = parseChecks({ staleAfterSec: Math.max(300, pollSec * 4), complete: true, list }, { origin: cfg.id, source: cfg.id, now: ctx.nowIso })
    assertedCells(checks, asserted)
  }
  return { source: cfg.id, kind: 'domain-expiry', at: ctx.nowIso, firing, resolved, complete: false, ...(checks ? { checks } : {}) }
}

// ---- the source -----------------------------------------------------------------------------------

/**
 * The source. `deps.fetch` is the network seam, so a test answers with a recorded RDAP record. The poll itself never throws: a domain that cannot
 * be read is that domain's "no data" cell, never a missed poll of the source.
 */
export function createDomainExpirySource(cfg: DomainExpirySourceConfig, deps: SourceDeps): PolledSource {
  async function poll(): Promise<Observation> {
    const nowIso = deps.nowIso()
    const readings = await Promise.all(
      cfg.domains.map(async (domain): Promise<DomainReading> => ({ domain, expiry: await readDomainExpiry(deps.fetch, domain.toLowerCase()) }))
    )
    return normalizeDomainExpiry(readings, cfg, { nowIso, serviceMap: deps.serviceMap })
  }

  return { id: cfg.id, kind: 'domain-expiry', name: 'Domain expiry', pollSec: cfg.pollSec ?? DOMAIN_EXPIRY_DEFAULTS.pollSec, poll }
}
