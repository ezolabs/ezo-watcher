// tcp-probe source: Watch's own TCP reachability prober. Every poll opens one connection to each target's host and port and closes it again; a
// target that cannot be connected to is ProbeDown, one that connects slower than slowMs on failAfter polls in a row is ProbeSlow, and a TLS
// target also reports CertExpiring from the peer certificate the same handshake presents.
//
// This is the tcpSocket probe Kubernetes defines beside httpGet, exec and grpc (kubernetes.io, "Configure Liveness, Readiness and Startup
// Probes", retrieved 2026-11-04). It covers the ports that speak no HTTP: postgres, redis, an SMTP relay, a compose service's published port.
// gRPC health checking needs a protocol client (a health-check stub and its protobuf), so it is not covered here; an endpoint that opens a TCP
// port is, and so is a TLS one.
//
// Damping is http-probe's, so the two probers read the same on the wall. ProbeDown pages only after `failAfter` failed connects in a row
// (default 3); before that the target's cell reads pending and nothing fires. The first success resolves it. ProbeSlow is the warning for
// `failAfter` connects in a row slower than `slowMs`; one fast connect resolves it, and a failed connect measures no speed, so it leaves
// ProbeSlow as it was. The streaks live in this process: after a restart a target counts from zero, and an alert it had raised stays firing
// until a success resolves it (a failing poll never resolves anything).
//
// A tls target's handshake does not verify the certificate. The probe asks whether the endpoint answers, not whether this host trusts it, and
// a self-signed certificate is normal on an internal port; refusing one here would report a healthy postgres as ProbeDown. The certificate is
// read from the same handshake, so an expired one is CertExpiring (under certWarnDays, default 14, a warning; under certPageDays, default 3, a
// page), never ProbeDown, and an untrusted one is not a failure at all. A handshake that never completes leaves both certificate tiers as they were.

import { createHash } from 'node:crypto'
import { connect as netConnect, isIP } from 'node:net'
import type { Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { TLSSocket } from 'node:tls'
import type { Alert, ChecksPush, Observation, Severity } from '../../shared/types.ts'
import type { TcpProbeSourceConfig, TcpProbeTargetConfig } from '../config.ts'
import { makeAlert } from '../derive.ts'
import { parseChecks } from './checks.ts'
import { PROBE_RULES } from './http-probe.ts'
import type { PolledSource, SourceDeps } from './types.ts'
import { clip, markResolved, requestFailure } from './shared.ts'

export const TCP_PROBE_DEFAULTS = {
  pollSec: 60,
  failAfter: 3,
  timeoutMs: 10_000,
  certWarnDays: 14,
  certPageDays: 3
} as const

/** What each cell proves beyond "the poll ran" (RuleCell.asserts): the predicate a red cell falsifies. */
export const TCP_ASSERTS = {
  /** A TCP connection completed. */
  connect: 'tcp:connect',
  /** The connect beat the target's slowMs. */
  latency: (slowMs: number): string => `tcp:connect<${slowMs}ms`,
  /** The peer certificate has more than the page threshold of days left. */
  cert: (pageDays: number): string => `tls:expires>${pageDays}d`
} as const

const DAY_MS = 86_400_000

// ---- one connect ----------------------------------------------------------------------------------

/** What a successful connect gives back: for a tls target, when the peer certificate stops being valid (epoch ms), when it could be read. */
export interface TcpConnectResult {
  certValidToMs?: number
}

/**
 * The socket seam: resolve once the connection (and, for a tls target, the handshake) is up, reject with the socket's error. A test replaces
 * it to control the outcome without a network, as it replaces `readCert` for http-probe.
 */
export type TcpConnector = (host: string, port: number, opts: { tls: boolean; timeoutMs: number }) => Promise<TcpConnectResult>

/**
 * The real connector: node:net for a plain target, node:tls for a TLS one, both bounded by `timeoutMs` and closed either way. Verification is
 * off for a TLS handshake (see the header); the peer's valid_to is read from the same handshake, so one connection answers both questions.
 */
export function connectTcp(host: string, port: number, opts: { tls: boolean; timeoutMs: number }): Promise<TcpConnectResult> {
  return new Promise<TcpConnectResult>((resolve, reject) => {
    const at = host.replace(/^\[|\]$/g, '')
    const socket = opts.tls
      ? tlsConnect({ host: at, port, rejectUnauthorized: false, ...(isIP(at) === 0 ? { servername: at } : {}) })
      : netConnect({ host: at, port })
    const tlsSocket = opts.tls ? (socket as TLSSocket) : null
    let done = false
    const finish = (err: Error | null, result?: TcpConnectResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      if (err) reject(err)
      else resolve(result ?? {})
    }
    const timer = setTimeout(() => {
      const err = new Error(`timed out after ${Number((opts.timeoutMs / 1000).toFixed(1))} s`)
      err.name = 'TimeoutError'
      finish(err)
    }, opts.timeoutMs)
    timer.unref?.()
    const ready = (): void => {
      if (!tlsSocket) {
        finish(null, {})
        return
      }
      const cert = tlsSocket.getPeerCertificate()
      const ms = cert && typeof cert.valid_to === 'string' ? Date.parse(cert.valid_to) : Number.NaN
      finish(null, Number.isFinite(ms) ? { certValidToMs: ms } : {})
    }
    if (tlsSocket) tlsSocket.once('secureConnect', ready)
    else (socket as Socket).once('connect', ready)
    // The error object itself carries the socket code (ECONNREFUSED, ENOTFOUND, EPROTO); requestFailure names it without ever showing the host.
    ;(socket as Socket).once('error', (err: NodeJS.ErrnoException) => finish(err))
  })
}

export type CertResult = { ok: true; validToMs: number } | { ok: false; detail: string }

export interface TcpProbeResult {
  ok: boolean
  /** The connect (and, for tls, the handshake), in ms. */
  ms: number
  /** One line safe to show: "TCP connect in 3ms", "TLS connect in 9ms", or what failed. */
  detail: string
  /** The peer certificate, for a tls target; null for a plain one. */
  cert: CertResult | null
}

/**
 * Connect to one target and judge it. Never throws: every way it can fail comes back as a result. `connect` is the socket seam; `clock` times
 * the connect (monotonic ms), so a test controls both.
 */
export async function probeTcp(
  t: TcpProbeTargetConfig,
  connect: TcpConnector = connectTcp,
  clock: () => number = () => performance.now()
): Promise<TcpProbeResult> {
  const timeoutMs = t.timeoutMs ?? TCP_PROBE_DEFAULTS.timeoutMs
  const tls = t.tls === true
  const started = clock()
  const took = (): number => Math.max(0, Math.round(clock() - started))
  try {
    const result = await connect(t.host, t.port, { tls, timeoutMs })
    const ms = took()
    const detail = `${tls ? 'TLS' : 'TCP'} connect in ${ms}ms`
    if (!tls) return { ok: true, ms, detail, cert: null }
    return {
      ok: true,
      ms,
      detail,
      cert: result.certValidToMs !== undefined ? { ok: true, validToMs: result.certValidToMs } : { ok: false, detail: 'the server sent no certificate' }
    }
  } catch (err) {
    const why = requestFailure(err, timeoutMs)
    return { ok: false, ms: took(), detail: `no connection: ${why}`, cert: tls ? { ok: false, detail: why } : null }
  }
}

// ---- the poll's arithmetic ------------------------------------------------------------------------

/** One target's poll, with the streaks already counted. */
export interface TcpTargetReading {
  target: TcpProbeTargetConfig
  probe: TcpProbeResult
  /** Failed connects in a row, this one counted; 0 after a success. */
  fails: number
  /** Connects in a row slower than `slowMs`, this one counted; 0 after a fast one. null when this poll timed nothing (it failed, or the target has no slowMs). */
  slows: number | null
}

export interface TcpProbeContext {
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

/** The predicate a cell proves, attached to the cell after parseChecks (and repeated in the list entry, for a parseChecks that keeps it). */
function assertedCells(checks: ChecksPush, byRuleAndName: ReadonlyMap<string, string[]>): void {
  for (const cell of checks.cells) {
    const asserts = byRuleAndName.get(`${cell.checkId ?? ''}\u0000${cell.name}`)
    if (asserts) cell.asserts = asserts
  }
}

/**
 * One poll's readings as the Observation. Pure: no clock, no network. ProbeDown fires once `fails` reaches `failAfter` and resolves on a success;
 * ProbeSlow fires once `slows` reaches it and resolves on a fast connect; CertExpiring fires the tier the days left fall in and resolves the other.
 * A reading that could not be taken (a pending streak, a failed connect's speed, an unreadable certificate) fires and resolves nothing.
 */
export function normalizeTcpProbe(readings: TcpTargetReading[], cfg: TcpProbeSourceConfig, ctx: TcpProbeContext): Observation {
  const pollSec = cfg.pollSec ?? TCP_PROBE_DEFAULTS.pollSec
  const nowMs = Date.parse(ctx.nowIso)
  const firing: Alert[] = []
  const resolved: Alert[] = []
  const list: Array<Record<string, unknown>> = []
  const asserted = new Map<string, string[]>()

  for (const { target: t, probe, fails, slows } of readings) {
    const failAfter = t.failAfter ?? TCP_PROBE_DEFAULTS.failAfter
    const tls = t.tls === true
    const build = (rule: string, severity: Extract<Severity, 'page' | 'warning'>, words: { summary: string; description: string; value: string }, raw: unknown, tier = ''): Alert =>
      makeAlert(
        {
          origin: cfg.id,
          fingerprint: sha('tcp-probe', cfg.id, t.id, rule, tier),
          rule,
          labels: { alertname: rule, severity, service: t.service, instance: t.id, host: t.host, port: String(t.port) },
          annotations: { summary: clip(words.summary, 220), description: words.description, ...(severity === 'page' ? { page_reason: clip(words.summary, 220) } : {}) },
          startsAt: ctx.nowIso,
          value: clip(words.value, 120),
          via: { source: cfg.id, kind: 'tcp-probe', lastSeen: ctx.nowIso },
          raw: { target: t.id, host: t.host, port: t.port, tls, probe, fails, slows }
        },
        ctx.serviceMap,
        ctx.nowIso
      )
    const cell = (rule: string, state: 'ok' | 'pending' | 'failing' | 'skipped', detail: string, asserts: string[]): void => {
      list.push({ id: rule, instance: t.id, service: t.service, state, ...(state === 'skipped' ? {} : { lastRunAt: ctx.nowIso }), detail: clip(detail, 230), asserts })
      asserted.set(`${rule}\u0000${t.id}`, asserts)
    }

    // ProbeDown
    const down = (): Alert =>
      build(
        PROBE_RULES.down,
        'page',
        {
          summary: `${t.id} is down: ${probe.detail}`,
          description:
            `Watch opens a TCP connection to ${t.host}:${t.port}${tls ? ' (TLS)' : ''} every ${pollSec} s and closes it. ` +
            `It has failed ${fails} connect${fails === 1 ? '' : 's'} in a row; it pages after ${failAfter} and resolves on the first success.`,
          value: probe.detail
        },
        { probe }
      )
    const connectAssert = [TCP_ASSERTS.connect]
    if (probe.ok) {
      resolved.push(markResolved(down(), ctx.nowIso))
      cell(PROBE_RULES.down, 'ok', probe.detail, connectAssert)
    } else if (fails >= failAfter) {
      firing.push(down())
      cell(PROBE_RULES.down, 'failing', `${probe.detail} (${fails} failed connects in a row)`, connectAssert)
    } else {
      cell(PROBE_RULES.down, 'pending', `${probe.detail} (failure ${fails} of ${failAfter} before it pages)`, connectAssert)
    }

    // ProbeSlow, only for a target with a slowMs
    if (t.slowMs !== undefined) {
      const slowMs = t.slowMs
      const slow = (): Alert =>
        build(
          PROBE_RULES.slow,
          'warning',
          {
            summary: `${t.id} is slow: ${probe.ms}ms, over ${slowMs}ms on ${slows ?? 0} connects in a row`,
            description: `Watch times the connect to ${t.host}:${t.port}. Over ${slowMs}ms on ${failAfter} connects in a row is this warning; one connect under it resolves it.`,
            value: `${probe.ms}ms, over ${slowMs}ms`
          },
          { probe }
        )
      const slowAssert = [TCP_ASSERTS.latency(slowMs)]
      if (slows === null) cell(PROBE_RULES.slow, 'skipped', 'not timed: the connect failed', slowAssert)
      else if (slows >= failAfter) {
        firing.push(slow())
        cell(PROBE_RULES.slow, 'failing', `${probe.detail}, over ${slowMs}ms on ${slows} connects in a row`, slowAssert)
      } else if (slows > 0) cell(PROBE_RULES.slow, 'pending', `${probe.detail}, over ${slowMs}ms (${slows} of ${failAfter})`, slowAssert)
      else {
        resolved.push(markResolved(slow(), ctx.nowIso))
        cell(PROBE_RULES.slow, 'ok', `${probe.detail}, under ${slowMs}ms`, slowAssert)
      }
    }

    // CertExpiring, only for a tls target
    const cert = probe.cert
    if (cert) {
      const warnDays = t.certWarnDays ?? TCP_PROBE_DEFAULTS.certWarnDays
      const pageDays = t.certPageDays ?? TCP_PROBE_DEFAULTS.certPageDays
      const certAssert = [TCP_ASSERTS.cert(pageDays)]
      if (!cert.ok) cell(PROBE_RULES.cert, 'skipped', `certificate not read: ${cert.detail}`, certAssert)
      else {
        const left = cert.validToMs - nowMs
        const when = `${daysText(left)} (${dateOf(cert.validToMs)})`
        const certAlert = (tier: Extract<Severity, 'page' | 'warning'>): Alert =>
          build(
            PROBE_RULES.cert,
            tier,
            {
              summary: left <= 0 ? `The certificate of ${t.id} (${t.host}:${t.port}) has expired (${dateOf(cert.validToMs)})` : `The certificate of ${t.id} (${t.host}:${t.port}) expires in ${when}`,
              description:
                `Watch reads the certificate the TLS endpoint at ${t.host}:${t.port} presents, on the same handshake as the probe. Under ${warnDays} days left is a warning ` +
                `and under ${pageDays} days a page; renewing it resolves this at the next read.`,
              value: left <= 0 ? `expired ${dateOf(cert.validToMs)}` : `expires in ${when}`
            },
            { validTo: new Date(cert.validToMs).toISOString() },
            tier
          )
        const tier: Extract<Severity, 'page' | 'warning'> | null = left < pageDays * DAY_MS ? 'page' : left < warnDays * DAY_MS ? 'warning' : null
        if (tier) {
          firing.push(certAlert(tier))
          resolved.push(markResolved(certAlert(tier === 'page' ? 'warning' : 'page'), ctx.nowIso))
          cell(PROBE_RULES.cert, 'failing', left <= 0 ? `certificate expired ${dateOf(cert.validToMs)}` : `certificate expires in ${when}`, certAssert)
        } else {
          resolved.push(markResolved(certAlert('page'), ctx.nowIso), markResolved(certAlert('warning'), ctx.nowIso))
          cell(PROBE_RULES.cert, 'ok', `certificate valid for ${when}`, certAssert)
        }
      }
    }
  }

  let checks: ChecksPush | undefined
  if (list.length > 0) {
    checks = parseChecks({ staleAfterSec: Math.max(300, pollSec * 4), complete: true, list }, { origin: cfg.id, source: cfg.id, now: ctx.nowIso })
    assertedCells(checks, asserted)
  }
  return { source: cfg.id, kind: 'tcp-probe', at: ctx.nowIso, firing, resolved, complete: false, ...(checks ? { checks } : {}) }
}

// ---- the source -----------------------------------------------------------------------------------

/**
 * The source. `connect` is the socket seam (the real node:net/node:tls connector by default) and `clock` times each connect, so a test controls
 * both. The poll itself never throws: a host that cannot be reached is that target's ProbeDown, never a missed poll of the prober.
 */
export function createTcpProbeSource(cfg: TcpProbeSourceConfig, deps: SourceDeps, connect: TcpConnector = connectTcp, clock?: () => number): PolledSource {
  const streaks = new Map<string, { fails: number; slows: number }>()

  async function poll(): Promise<Observation> {
    const nowIso = deps.nowIso()
    const readings = await Promise.all(
      cfg.targets.map(async (t): Promise<TcpTargetReading> => {
        const probe = await probeTcp(t, connect, clock)
        const s = streaks.get(t.id) ?? { fails: 0, slows: 0 }
        s.fails = probe.ok ? 0 : s.fails + 1
        let slows: number | null = null
        if (t.slowMs !== undefined && probe.ok) {
          s.slows = probe.ms > t.slowMs ? s.slows + 1 : 0
          slows = s.slows
        }
        streaks.set(t.id, s)
        return { target: t, probe, fails: s.fails, slows }
      })
    )
    return normalizeTcpProbe(readings, cfg, { nowIso, serviceMap: deps.serviceMap })
  }

  return { id: cfg.id, kind: 'tcp-probe', name: 'TCP probes', pollSec: cfg.pollSec ?? TCP_PROBE_DEFAULTS.pollSec, poll }
}
