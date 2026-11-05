// http-probe source: Watch's own uptime prober. Every poll GETs each target once and reads three things: whether it answered as it should
// (ProbeDown), how long it took (ProbeSlow) and, for an https target, how long its certificate has left (CertExpiring). The class names are the
// ones node-2's api-uptime prober pushes, so a probe looks the same on the wall whichever prober ran it. skills/ezo-watcher/references/sources.md "http-probe".
//
// One GET per target per poll, with no redirect followed: a 3xx is a failure unless the target expects that status, because a health route that
// starts redirecting (to a login page, to a parked domain) is not healthy. The status must be the expected one (200 unless said) and each
// `expectJson` dotted path must equal its value. The whole answer is timed and bounded by the target's timeout; the body is read to at most 1 MiB
// and never quoted: a failure names the status, the time or the one path that differed.
//
// Assertions and provenance. Every predicate a target makes is written down in words (`probeAssertions`: "status 200", "body.ok = true") and
// travels on the target's cells as `RuleCell.asserts`, so the wall can tell a probe that proves a dependency from one that proves only that a
// process answered (nominal 200) and the Sources page can count the asserting cells (`SourceStatus.asserted`). The judgement itself is one pure
// function, `evaluateProbe(target, answer)`: it reads a recorded answer (status, headers, bodyText) and nothing else, which is the seam
// `watcher doctor --prove` uses to mutate the last good answer and show the assertion going red (`proveProbe`) instead of asking the target again.
//
// Damping. ProbeDown pages only after `failAfter` failed polls in a row (default 3); before that the target's cell reads pending and nothing
// fires. The first success resolves it. ProbeSlow is the warning for `failAfter` polls in a row slower than `slowMs`; one fast poll resolves it, and
// a failed poll measures no speed, so it leaves ProbeSlow as it was. The streaks live in this process: after a restart a target counts from zero,
// and an alert it had raised stays firing until a success resolves it (a failing poll never resolves anything).
//
// The certificate is read with node:tls (the peer certificate's valid_to), at most once an hour per host and port, and with verification off for
// that read alone: an expired or untrusted certificate is still read, and the GET (which does verify) fails on it as ProbeDown. Under
// `certWarnDays` (14) is a warning, under `certPageDays` (3) a page; each tier is its own alert (like the gateway runway), so a warning that becomes a
// page is a new alert and the other tier resolves. A certificate that cannot be read leaves both as they were.
//
// Plain http goes only to a loopback, RFC 1918 or 100.64.0.0/10 address (config.ts plainHttpAllowed); everything else is https.

import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Alert, ChecksPush, Observation, ProbeAnswer, ProbeObservation, Severity } from '../../shared/types.ts'
import type { HttpProbeSourceConfig, HttpProbeTargetConfig } from '../config.ts'
import { makeAlert } from '../derive.ts'
import { DEFAULT_ASSERTION, parseChecks } from './checks.ts'
import type { PolledSource, SourceDeps } from './types.ts'
import { clip, isRecord, markResolved, readBodyCapped, requestFailure } from './shared.ts'

/** The alertnames (classes), node-2's api-uptime names. Each is also a check per target, so a quiet tile shows a solid cell per class. */
export const PROBE_RULES = {
  down: 'ProbeDown',
  slow: 'ProbeSlow',
  cert: 'CertExpiring'
} as const

export const HTTP_PROBE_DEFAULTS = {
  pollSec: 60,
  failAfter: 3,
  expectStatus: 200,
  timeoutMs: 10_000,
  certWarnDays: 14,
  certPageDays: 3
} as const

/** The most of a body a probe reads: a health answer is a few hundred bytes. */
export const PROBE_MAX_BODY_BYTES = 1_048_576
/** A certificate is read again after this long. */
export const CERT_CACHE_MS = 3600_000
const DAY_MS = 86_400_000

// ---- one GET ----------------------------------------------------------------------------------------

export interface ProbeResult {
  ok: boolean
  /** The status the target answered, when it answered. */
  status: number | null
  /** The whole answer, headers and body, in ms. */
  ms: number
  /** One line safe to show: "HTTP 200 in 41ms", or what failed. Never the body. */
  detail: string
  /** Every assertion the target makes, in words; the same list whether the poll passed or failed. */
  asserts: string[]
  /** The answer as it was read, when one arrived: the last good one is kept in memory for `doctor --prove`. */
  answer?: ProbeAnswer
}

/** A value from the JSON body by dotted path (`db.kind`); undefined when a step is missing. A list is stepped into by index (`items.0.id`). */
export function valueAt(json: unknown, path: string): unknown {
  let at: unknown = json
  for (const step of path.split('.')) {
    if (Array.isArray(at) && /^\d+$/.test(step)) at = at[Number(step)]
    else if (isRecord(at) && Object.hasOwn(at, step)) at = at[step]
    else return undefined
  }
  return at
}

/** What a path held, in a few words: never more than a short value, and never an object's contents. */
function shown(v: unknown): string {
  if (v === undefined) return 'missing'
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'a list'
  if (typeof v === 'object') return 'an object'
  return clip(JSON.stringify(v) ?? String(v), 40)
}

/**
 * The assertions a probe target makes, in words, the status one first: `["status 200", "body.db.kind = \"postgres\""]`. This is the vocabulary a
 * cell carries (`RuleCell.asserts`) and the doctor counts (`SourceStatus.asserted`): a list holding nothing but the default `status 200` is a
 * bare probe, one that cannot go red for a dependency being down (doctor code source.bare-200).
 */
export function probeAssertions(t: HttpProbeTargetConfig): string[] {
  const expect = t.expectStatus ?? HTTP_PROBE_DEFAULTS.expectStatus
  const out = [`status ${expect}`]
  for (const [path, want] of Object.entries(t.expectJson ?? {})) out.push(`body.${path} = ${JSON.stringify(want)}`)
  return out
}

/** The judgement of one answer (`evaluateProbe`). */
export interface ProbeEvaluation {
  ok: boolean
  /** The assertions that failed, in the words `asserts` uses (or the requirement that could not be read). */
  failed: string[]
  /** Every assertion the target made for this answer, in words. */
  asserts: string[]
  /** The judged part of the one-line detail, separator included (", but ok is false, expected true"); '' when ok. `probeTarget` puts the timing head in front. */
  detail: string
}

/**
 * Judge one answer against one target. Pure: no clock, no network, and no state beyond the target, so `doctor --prove` can re-run it on a mutated
 * copy of a recorded answer. The status must be the expected one (a redirect fails unless expected) and each `expectJson` path must equal its value.
 */
export function evaluateProbe(t: HttpProbeTargetConfig, answer: ProbeAnswer): ProbeEvaluation {
  const expect = t.expectStatus ?? HTTP_PROBE_DEFAULTS.expectStatus
  const asserts = probeAssertions(t)
  if (answer.status !== expect) {
    const redirect = answer.status >= 300 && answer.status < 400 ? ' (a redirect, not followed)' : ''
    return { ok: false, asserts, failed: [asserts[0]], detail: `${redirect}, expected ${expect}` }
  }
  if (!t.expectJson) return { ok: true, asserts, failed: [], detail: '' }
  if (answer.bodyText === null) return { ok: false, asserts, failed: ['a body of at most 1 MiB'], detail: ', but the body is over 1 MiB' }
  let json: unknown
  try {
    json = JSON.parse(answer.bodyText)
  } catch {
    return { ok: false, asserts, failed: ['a body that is JSON'], detail: ', but the body is not JSON' }
  }
  for (const [path, want] of Object.entries(t.expectJson)) {
    const got = valueAt(json, path)
    if (got !== want) return { ok: false, asserts, failed: [`body.${path} = ${JSON.stringify(want)}`], detail: `, but ${path} is ${shown(got)}, expected ${JSON.stringify(want)}` }
  }
  return { ok: true, asserts, failed: [], detail: '' }
}

/** One mutation of a recorded answer, and what the judgement made of it. */
export interface ProveRun {
  /** What was changed, in words ("status 503", "body.ok = false"). */
  mutation: string
  /** True: the mutated answer stayed green, which is what a proof must not do. */
  ok: boolean
  /** The assertions the mutation reddened. */
  failed: string[]
}

export interface ProveOutcome {
  /**
   * True when every assertion the target makes was shown to fail: each body path the target declares went red under a mutation of its value (or the
   * status alone did, for a target that asserts no body path).
   */
  red: boolean
  runs: ProveRun[]
}

/** A value that is not `want`, of the same JSON type: what a proof writes in its place. */
function otherValue(want: string | number | boolean): string | number | boolean {
  if (typeof want === 'boolean') return !want
  if (typeof want === 'number') return want + 1
  return `${want}?`
}

/** A copy of `bodyText` with `path` set to `otherValue(want)`, or null when the path cannot be written. */
function withValue(bodyText: string | null, path: string, want: string | number | boolean): string | null {
  if (bodyText === null) return null
  let json: unknown
  try {
    json = JSON.parse(bodyText)
  } catch {
    return null
  }
  const steps = path.split('.')
  const last = steps.pop() as string
  let at: unknown = json
  for (const step of steps) {
    if (Array.isArray(at) && /^\d+$/.test(step)) at = at[Number(step)]
    else if (isRecord(at) && Object.hasOwn(at, step)) at = at[step]
    else return null
  }
  if (Array.isArray(at) && /^\d+$/.test(last) && Number(last) < at.length) at[Number(last)] = otherValue(want)
  else if (isRecord(at) && Object.hasOwn(at, last)) at[last] = otherValue(want)
  else return null
  return JSON.stringify(json)
}

/**
 * Prove a target's assertion by mutating its last good answer, never by asking the target again (pure: no clock, no network). The status is moved
 * to one the target does not expect, and each `expectJson` path to a value it does not hold; every mutated answer is judged by `evaluateProbe`.
 * `red` is true only when every body assertion the target declares was reddened by its own mutation: a status that fails proves the endpoint
 * answers, not that the body is judged. A body path the recorded answer cannot be written at (the config changed since the poll) leaves `red`
 * false: the assertion has not been shown to fail (doctor code source.assertion-not-red). A target with no recorded answer proves nothing.
 */
export function proveProbe(t: HttpProbeTargetConfig, observation: ProbeAnswer | null): ProveOutcome {
  if (!observation) return { red: false, runs: [] }
  const runs: ProveRun[] = []
  const expect = t.expectStatus ?? HTTP_PROBE_DEFAULTS.expectStatus
  const other = expect === 503 ? 500 : 503
  const judge = (mutation: string, answer: ProbeAnswer): void => {
    const ev = evaluateProbe(t, answer)
    runs.push({ mutation, ok: ev.ok, failed: ev.failed })
  }
  judge(`status ${other}`, { ...observation, status: other })
  const bodyPaths = Object.entries(t.expectJson ?? {})
  for (const [path, want] of bodyPaths) {
    const mutation = `body.${path} = ${JSON.stringify(otherValue(want))}`
    const bodyText = withValue(observation.bodyText, path, want)
    if (bodyText === null) runs.push({ mutation, ok: true, failed: [] })
    else judge(mutation, { ...observation, bodyText })
  }
  // A target with body assertions proves itself by the body runs only; a bare one has nothing but the status to go red.
  const bodyRuns = runs.slice(1)
  const red = bodyPaths.length === 0 ? runs[0].ok === false : bodyRuns.every((r) => !r.ok)
  return { red, runs }
}

/**
 * True when a probe URL points at the Watcher's own port: the probe then proves that the Watcher answers, not that the project does (doctor code
 * source.self-probe). Compared by port and a loopback name, or against the server's own `baseUrl` (a tunnel names it from outside).
 */
export function isSelfProbe(url: string, own: { port?: number; host?: string; baseUrl?: string }): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  if (own.baseUrl) {
    try {
      const b = new URL(own.baseUrl)
      if (b.hostname === u.hostname && Number(b.port || (b.protocol === 'https:' ? 443 : 80)) === port) return true
    } catch {
      // an unparseable baseUrl is the config check's business, not the probe's
    }
  }
  if (!own.port || port !== own.port) return false
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const bound = (own.host ?? '').replace(/^\[|\]$/g, '')
  if (bound !== '' && bound !== '0.0.0.0' && bound !== '::' && host === bound) return true
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
}

/**
 * GET one target and judge the answer. Never throws: every way it can fail comes back as a result. `clock` times it (monotonic ms); `fetchImpl`
 * is the host's fetch, so a test can stand in for the network. The judgement is `evaluateProbe` on the answer as read; the timing head is this
 * function's own.
 */
export async function probeTarget(fetchImpl: typeof fetch, t: HttpProbeTargetConfig, clock: () => number = () => performance.now()): Promise<ProbeResult> {
  const timeoutMs = t.timeoutMs ?? HTTP_PROBE_DEFAULTS.timeoutMs
  const asserts = probeAssertions(t)
  const started = clock()
  const took = (): number => Math.max(0, Math.round(clock() - started))
  let res: Response
  let bodyText: string | null
  try {
    res = await fetchImpl(t.url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: t.expectJson ? 'application/json' : '*/*', 'User-Agent': 'ezo-watcher-probe' }
    })
    bodyText = await readBodyCapped(res, PROBE_MAX_BODY_BYTES)
  } catch (err) {
    return { ok: false, status: null, ms: took(), detail: `no answer: ${requestFailure(err, timeoutMs)}`, asserts }
  }
  const ms = took()
  const answer: ProbeAnswer = { status: res.status, headers: Object.fromEntries(res.headers.entries()), bodyText }
  const ev = evaluateProbe(t, answer)
  const head = `HTTP ${res.status} in ${ms}ms`
  return { ok: ev.ok, status: res.status, ms, detail: ev.ok ? head : clip(`${head}${ev.detail}`, 230), asserts: ev.asserts, answer }
}

// ---- the certificate --------------------------------------------------------------------------------

/** When a host's certificate stops being valid, epoch ms; throws an Error whose message is safe to show. The seam a test replaces. */
export type CertReader = (host: string, port: number, timeoutMs: number) => Promise<number>

/** The real reader: one TLS handshake, verification off for this read only (an expired certificate must still be read), then the peer's valid_to. */
export function readPeerCert(host: string, port: number, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let done = false
    const socket = tlsConnect({ host, port, rejectUnauthorized: false, ...(isIP(host) === 0 ? { servername: host } : {}) })
    const finish = (err: Error | null, ms?: number): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      if (err) reject(err)
      else resolve(ms as number)
    }
    const timer = setTimeout(() => finish(new Error(`timed out after ${Number((timeoutMs / 1000).toFixed(1))} s`)), timeoutMs)
    timer.unref?.()
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      const ms = cert && typeof cert.valid_to === 'string' ? Date.parse(cert.valid_to) : Number.NaN
      finish(Number.isFinite(ms) ? null : new Error('the server sent no certificate'), ms)
    })
    socket.once('error', (err: NodeJS.ErrnoException) => finish(new Error(err.code && /^[A-Z0-9_]{2,64}$/.test(err.code) ? err.code : 'network error')))
  })
}

export type CertResult = { ok: true; validToMs: number } | { ok: false; detail: string }

/** The host and port an https URL's certificate is read from; null for anything else. */
export function certEndpoint(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return null
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 443) }
  } catch {
    return null
  }
}

// ---- the poll's arithmetic --------------------------------------------------------------------------

/** One target's poll, with the streaks already counted. */
export interface TargetReading {
  target: HttpProbeTargetConfig
  probe: ProbeResult
  /** Failed polls in a row, this one counted; 0 after a success. */
  fails: number
  /** Polls in a row slower than `slowMs`, this one counted; 0 after a fast one. null when this poll timed nothing (it failed, or the target has no slowMs). */
  slows: number | null
  /** The certificate, for an https target; null for an http one. */
  cert: CertResult | null
}

export interface ProbeContext {
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

/**
 * One poll's readings as the Observation. Pure: no clock, no network. ProbeDown fires once `fails` reaches `failAfter` and resolves on a success;
 * ProbeSlow fires once `slows` reaches it and resolves on a fast poll; CertExpiring fires the tier the days left fall in and resolves the other.
 * A reading that could not be taken (a pending streak, a failed poll's speed, an unread certificate) fires and resolves nothing.
 */
export function normalizeHttpProbe(readings: TargetReading[], cfg: HttpProbeSourceConfig, ctx: ProbeContext): Observation {
  const failAfter = cfg.failAfter ?? HTTP_PROBE_DEFAULTS.failAfter
  const pollSec = cfg.pollSec ?? HTTP_PROBE_DEFAULTS.pollSec
  const nowMs = Date.parse(ctx.nowIso)
  const firing: Alert[] = []
  const resolved: Alert[] = []
  const list: Array<Record<string, unknown>> = []

  for (const { target: t, probe, fails, slows, cert } of readings) {
    const expect = t.expectStatus ?? HTTP_PROBE_DEFAULTS.expectStatus
    // the wall tile: the target's own, else the source's id (one probe source watches one tile unless it says otherwise)
    const service = t.service ?? cfg.id
    const https = certEndpoint(t.url) !== null
    // a loopback or private URL is not something a person can open from the wall
    const link = https ? t.url : undefined
    const build = (rule: string, severity: Extract<Severity, 'page' | 'warning'>, words: { summary: string; description: string; value: string }, raw: unknown, tier = ''): Alert =>
      makeAlert(
        {
          origin: cfg.id,
          fingerprint: sha('http-probe', cfg.id, t.id, rule, tier),
          rule,
          labels: { alertname: rule, severity, service, instance: t.id, url: t.url },
          annotations: { summary: clip(words.summary, 220), description: words.description, ...(severity === 'page' ? { page_reason: clip(words.summary, 220) } : {}) },
          startsAt: ctx.nowIso,
          ...(link ? { generatorURL: link, links: { generator: link } } : {}),
          value: clip(words.value, 120),
          via: { source: cfg.id, kind: 'http-probe', lastSeen: ctx.nowIso, ...(link ? { url: link } : {}) },
          // the probe's judgement, never the answer's body: the body stays in memory for `doctor --prove` and is not written to an alert's raw payload
          raw: { target: t.id, url: t.url, probe: { ok: probe.ok, status: probe.status, ms: probe.ms, detail: probe.detail, asserts: probe.asserts }, fails, slows, cert }
        },
        ctx.serviceMap,
        ctx.nowIso
      )
    const cell = (rule: string, state: 'ok' | 'pending' | 'failing' | 'skipped', detail: string, asserts: string[]): void => {
      list.push({
        id: rule,
        instance: t.id,
        service,
        state,
        ...(state === 'skipped' ? {} : { lastRunAt: ctx.nowIso }),
        detail: clip(detail, 230),
        asserts,
        ...(link ? { url: link } : {})
      })
    }

    // ProbeDown
    const json = t.expectJson ? Object.keys(t.expectJson) : []
    const down = (): Alert =>
      build(
        PROBE_RULES.down,
        'page',
        {
          summary: `${t.id} is down: ${probe.detail}`,
          description:
            `Watch GETs ${t.url} every ${pollSec} s and expects HTTP ${expect}${json.length > 0 ? ` with ${json.join(', ')} as configured` : ''}, without following a redirect. ` +
            `It has failed ${fails} poll${fails === 1 ? '' : 's'} in a row; it pages after ${failAfter} and resolves on the first success.`,
          value: probe.detail
        },
        { probe }
      )
    if (probe.ok) {
      resolved.push(markResolved(down(), ctx.nowIso))
      cell(PROBE_RULES.down, 'ok', probe.detail, probe.asserts)
    } else if (fails >= failAfter) {
      firing.push(down())
      cell(PROBE_RULES.down, 'failing', `${probe.detail} (${fails} failed polls in a row)`, probe.asserts)
    } else {
      cell(PROBE_RULES.down, 'pending', `${probe.detail} (failure ${fails} of ${failAfter} before it pages)`, probe.asserts)
    }

    // ProbeSlow, only for a target with a slowMs
    if (t.slowMs !== undefined) {
      const slowMs = t.slowMs
      const slow = (): Alert =>
        build(
          PROBE_RULES.slow,
          'warning',
          {
            summary: `${t.id} is slow: ${probe.ms}ms, over ${slowMs}ms on ${slows ?? 0} polls in a row`,
            description: `Watch times the whole answer of GET ${t.url}. Over ${slowMs}ms on ${failAfter} polls in a row is this warning; one poll under it resolves it.`,
            value: `${probe.ms}ms, over ${slowMs}ms`
          },
          { probe }
        )
      const slowAssert = `answer under ${slowMs}ms`
      if (slows === null) cell(PROBE_RULES.slow, 'skipped', 'not timed: the probe failed', [slowAssert])
      else if (slows >= failAfter) {
        firing.push(slow())
        cell(PROBE_RULES.slow, 'failing', `${probe.detail}, over ${slowMs}ms on ${slows} polls in a row`, [slowAssert])
      } else if (slows > 0) cell(PROBE_RULES.slow, 'pending', `${probe.detail}, over ${slowMs}ms (${slows} of ${failAfter})`, [slowAssert])
      else {
        resolved.push(markResolved(slow(), ctx.nowIso))
        cell(PROBE_RULES.slow, 'ok', `${probe.detail}, under ${slowMs}ms`, [slowAssert])
      }
    }

    // CertExpiring, only for an https target
    if (cert) {
      const warnDays = t.certWarnDays ?? HTTP_PROBE_DEFAULTS.certWarnDays
      const pageDays = t.certPageDays ?? HTTP_PROBE_DEFAULTS.certPageDays
      const certAssert = `certificate valid for at least ${warnDays} days`
      if (!cert.ok) cell(PROBE_RULES.cert, 'skipped', `certificate not read: ${cert.detail}`, [certAssert])
      else {
        const left = cert.validToMs - nowMs
        const host = certEndpoint(t.url)?.host ?? t.url
        const when = `${daysText(left)} (${dateOf(cert.validToMs)})`
        const certAlert = (tier: Extract<Severity, 'page' | 'warning'>): Alert =>
          build(
            PROBE_RULES.cert,
            tier,
            {
              summary: left <= 0 ? `The certificate of ${host} has expired (${dateOf(cert.validToMs)})` : `The certificate of ${host} expires in ${when}`,
              description:
                `Watch reads the certificate ${host} serves at most once an hour. Under ${warnDays} days left is a warning and under ${pageDays} days a page; ` +
                'renewing it (certbot) resolves this at the next read.',
              value: left <= 0 ? `expired ${dateOf(cert.validToMs)}` : `expires in ${when}`
            },
            { validTo: new Date(cert.validToMs).toISOString() },
            tier
          )
        const tier: Extract<Severity, 'page' | 'warning'> | null = left < pageDays * DAY_MS ? 'page' : left < warnDays * DAY_MS ? 'warning' : null
        if (tier) {
          firing.push(certAlert(tier))
          resolved.push(markResolved(certAlert(tier === 'page' ? 'warning' : 'page'), ctx.nowIso))
          cell(PROBE_RULES.cert, 'failing', left <= 0 ? `certificate expired ${dateOf(cert.validToMs)}` : `certificate expires in ${when}`, [certAssert])
        } else {
          resolved.push(markResolved(certAlert('page'), ctx.nowIso), markResolved(certAlert('warning'), ctx.nowIso))
          cell(PROBE_RULES.cert, 'ok', `certificate valid for ${when}`, [certAssert])
        }
      }
    }
  }

  const checks: ChecksPush | undefined = list.length > 0 ? parseChecks({ staleAfterSec: Math.max(300, pollSec * 4), complete: true, list }, { origin: cfg.id, source: cfg.id, now: ctx.nowIso }) : undefined
  return { source: cfg.id, kind: 'http-probe', at: ctx.nowIso, firing, resolved, complete: false, ...(checks ? { checks } : {}) }
}

// ---- the source -------------------------------------------------------------------------------------

/**
 * The source. `readCert` is the certificate seam (the real TLS reader by default) and `clock` times each GET, so a test controls both. The poll
 * itself never throws: a target that cannot be reached is that target's ProbeDown, never a missed poll of the prober.
 */
export function createHttpProbeSource(cfg: HttpProbeSourceConfig, deps: SourceDeps, readCert: CertReader = readPeerCert, clock?: () => number): PolledSource {
  const streaks = new Map<string, { fails: number; slows: number }>()
  /** host:port to the read in flight or done, and when it started. A failed read is dropped, so the next poll tries again. */
  const certs = new Map<string, { atMs: number; read: Promise<CertResult> }>()
  /**
   * The last good answer of each target, in this process only: never written to the database. It is what `doctor --prove` mutates, so a failed
   * poll leaves it alone (a target that has answered once can be proved until it answers again).
   */
  const lastGood = new Map<string, ProbeObservation>()

  function certOf(t: HttpProbeTargetConfig, nowMs: number): Promise<CertResult> | null {
    const at = certEndpoint(t.url)
    if (!at) return null
    const key = `${at.host}:${at.port}`
    const held = certs.get(key)
    if (held && nowMs - held.atMs < CERT_CACHE_MS) return held.read
    const read = readCert(at.host, at.port, t.timeoutMs ?? HTTP_PROBE_DEFAULTS.timeoutMs).then(
      (validToMs): CertResult => ({ ok: true, validToMs }),
      (err: unknown): CertResult => {
        certs.delete(key)
        return { ok: false, detail: err instanceof Error ? clip(err.message, 120) : 'network error' }
      }
    )
    certs.set(key, { atMs: nowMs, read })
    return read
  }

  async function poll(): Promise<Observation> {
    const nowIso = deps.nowIso()
    const nowMs = Date.parse(nowIso)
    const readings = await Promise.all(
      cfg.targets.map(async (t): Promise<TargetReading> => {
        const [probe, cert] = await Promise.all([probeTarget(deps.fetch, t, clock), certOf(t, nowMs)])
        const s = streaks.get(t.id) ?? { fails: 0, slows: 0 }
        s.fails = probe.ok ? 0 : s.fails + 1
        let slows: number | null = null
        if (t.slowMs !== undefined && probe.ok) {
          s.slows = probe.ms > t.slowMs ? s.slows + 1 : 0
          slows = s.slows
        }
        streaks.set(t.id, s)
        if (probe.ok && probe.answer) lastGood.set(t.id, { source: cfg.id, target: t.id, at: nowIso, ...probe.answer })
        return { target: t, probe, fails: s.fails, slows, cert }
      })
    )
    const obs = normalizeHttpProbe(readings, cfg, { nowIso, serviceMap: deps.serviceMap })
    return lastGood.size > 0 ? { ...obs, probes: [...lastGood.values()] } : obs
  }

  return { id: cfg.id, kind: 'http-probe', name: 'HTTP probes', pollSec: cfg.pollSec ?? HTTP_PROBE_DEFAULTS.pollSec, poll }
}
