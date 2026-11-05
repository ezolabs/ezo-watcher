// The notifier executor: ask planSends what is due, send it, and write the notification log. The decisions
// live in plan.ts; this file owns time, channels and the store. See plan.ts for the Alertmanager sources.

import type { QuietHoursConfig, RouteConfig } from '../config.ts'
import { errorName } from './channels/common.ts'
import { CircuitBreaker, skippedResult, tripsCircuit, wasSkipped } from './circuit.ts'
import { buildMessage, testMessage } from './message.ts'
import type { MessageContext } from './message.ts'
import { MAX_ATTEMPTS, MAX_RETRY_AGE_MS, abandonedStatus, backoffMs, closeByLimit, logKey, planAbandons, planSends } from './plan.ts'
import type { CoalescedAlert, PlannedSend, Target } from './plan.ts'
import { COALESCED_PREFIX } from './log.ts'
import { quietState } from './quiet.ts'
import type {
  Channel,
  LogRow,
  Message,
  NotifyStore,
  NotifyView,
  ResolvedView,
  ResultRow,
  SendResult
} from './types.ts'

export interface LadderTiming {
  /** Cap on one attempt. */
  attemptMs: number
  /** Wait before the single retry on the same receiver. */
  retryDelayMs: number
  /** Total time one ladder may spend; no new attempt starts after it. */
  budgetMs: number
  /** Waits before each further try of a record copy that failed in a way worth retrying. The retries run apart from the tick. */
  recordRetryMs: number[]
  sleep(ms: number): Promise<void>
}

export interface NotifierDeps {
  routes: RouteConfig[]
  channels: Map<string, Channel>
  quiet: QuietHoursConfig | null
  store: NotifyStore
  now: () => number
  baseUrl: string
  ackSecret: string
  log?: (line: string) => void
  /** The name this Watch goes by (config `brand.name`), in the test notification. Absent: EZO Watcher. */
  brand?: string
  /** Overrides for tests: attempt cap, retry delay, ladder budget, sleep. */
  timing?: Partial<LadderTiming>
  /**
   * The circuits of the send targets. Share the one the channels were given (the ntfy channel keeps a circuit per server in it); absent, the
   * notifier keeps its own for the channels that have none of their own.
   */
  circuits?: CircuitBreaker
}

export interface Notifier {
  tick(views: NotifyView[], resolved: ResolvedView[]): Promise<ResultRow[]>
  test(channelId: string): Promise<SendResult>
  /** Resolves when every record retry in flight has finished. Tests and a clean shutdown wait on it; a tick never does. */
  settled(): Promise<void>
}

const DEFAULT_TIMING: LadderTiming = {
  attemptMs: 3000,
  retryDelayMs: 1000,
  budgetMs: 20_000,
  recordRetryMs: [2000, 10_000, 30_000],
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

interface Outcome {
  target: Target
  result: SendResult
}

/** Worth another try later: the server is busy or down (429, 5xx), the call timed out, or the network failed. A refusal (400, 401, 404) or a missing credential would only fail again. */
export function retryable(result: SendResult): boolean {
  if (result.ok) return false
  if (result.status === '429' || /^5\d\d$/.test(result.status) || result.status === 'timeout') return true
  return result.status === 'error' && result.detail !== 'missing credential'
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const timing: LadderTiming = { ...DEFAULT_TIMING, ...deps.timing }
  const circuits = deps.circuits ?? new CircuitBreaker(deps.now)
  // Fail at startup, not at 3 a.m., on a bad time zone or clock time.
  quietState(deps.quiet, deps.now())

  /**
   * One send to a channel, unless its circuit is open. The ntfy channel keeps a circuit for each of its two servers (channels/ntfy.ts), so it
   * is not wrapped here: one server refusing must not stop the other. Every other channel is one target and has one circuit, by its id.
   * A test message always goes out: it is someone asking whether the target answers now.
   */
  async function attempt(channelId: string, msg: Message): Promise<SendResult> {
    const channel = deps.channels.get(channelId)
    if (!channel) return { ok: false, status: 'unknown channel', latencyMs: 0 }
    if (channel.type === 'ntfy') return call(channel, msg)
    const key = `channel:${channelId}`
    const until = msg.kind === 'test' ? null : circuits.openUntil(key)
    if (until !== null) return skippedResult(until)
    const result = await call(channel, msg)
    if (tripsCircuit(result)) {
      const wasOpen = circuits.openUntil(key) !== null
      const openUntil = circuits.trip(key, result.retryAfterMs)
      if (!wasOpen) deps.log?.(`notify: ${channelId} answered ${result.status}, circuit open until ${new Date(openUntil).toISOString().slice(11, 19)} UTC`)
      return { ...result, circuitUntil: openUntil }
    }
    return result
  }

  /** One send with its own cap. Never throws and never lets a hung channel hold the tick. */
  async function call(channel: Channel, msg: Message): Promise<SendResult> {
    const started = deps.now()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<SendResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve({ ok: false, status: 'timeout', latencyMs: timing.attemptMs })
      }, timing.attemptMs)
    })
    try {
      return await Promise.race([channel.send(msg, controller.signal), expired])
    } catch (err) {
      return { ok: false, status: 'error', latencyMs: deps.now() - started, detail: errorName(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Receivers in order, each tried once and retried once after a pause; the first success ends it. */
  async function ladder(targets: Target[], msg: Message): Promise<Outcome[]> {
    const deadline = deps.now() + timing.budgetMs
    const outcomes: Outcome[] = []
    for (const target of targets) {
      if (outcomes.length > 0 && deps.now() >= deadline) {
        deps.log?.('notify: ladder budget spent, later receivers not tried')
        break
      }
      let result = await attempt(target.channelId, msg)
      // A refusal that opened a circuit (429, timeout) or a call that was skipped is not asked again a second later.
      const canRetry =
        result.status !== 'unknown channel' && result.circuitUntil === undefined && !tripsCircuit(result) && deps.now() + timing.retryDelayMs < deadline
      if (!result.ok && canRetry) {
        await timing.sleep(timing.retryDelayMs)
        result = await attempt(target.channelId, msg)
      }
      outcomes.push({ target, result })
      if (result.ok) break
    }
    return outcomes
  }

  /** The result row of a send that ended without one more try: given up, no longer owed. The log row already says it; this is what the wall shows. */
  function endRow(at: number, incidentKey: string, routeId: string, channelId: string, kind: ResultRow['kind'], reason: string): ResultRow {
    const row: ResultRow = { at, incidentKey, routeId, channelId, kind, ok: false, status: abandonedStatus(reason), latencyMs: 0 }
    deps.store.addResult(row)
    return row
  }

  /** How long a digest waits after it was given up on: it has no repeat gate of its own, so its route's repeat interval is it. */
  function digestGateMs(send: PlannedSend): number | null {
    return send.stage === 'digest' ? (deps.routes.find((r) => r.id === send.routeId)?.repeatIntervalSec ?? 0) * 1000 : null
  }

  /** Write the log row for one outcome. Returns why the send was given up on when this failure was its last allowed try. */
  function commit(send: PlannedSend, outcome: Outcome): string | null {
    const { target, result } = outcome
    const now = deps.now()
    const prev = deps.store.getLog(target.logKey)
    let row: LogRow
    let ended: string | null = null
    if (result.ok) {
      row = { key: target.logKey, sentAt: now, digest: send.digest, ok: true, attempts: 0, nextAttemptAt: null }
    } else {
      // A closed row ended the rounds of retries before this one: a failure now starts a new round.
      const round = prev !== null && prev.closed === undefined ? prev : null
      const attempts = round?.attempts ?? 0
      const firstFailedAt = round?.firstFailedAt ?? now
      // A call that was skipped because the target's circuit is open is not a try: it waits for the circuit instead of backing off.
      const skipped = wasSkipped(result)
      row = {
        key: target.logKey,
        sentAt: prev?.sentAt ?? 0,
        digest: prev?.digest ?? '',
        ok: prev?.ok ?? false,
        attempts: skipped ? attempts : attempts + 1,
        nextAttemptAt: skipped ? (result.circuitUntil as number) : Math.max(now + backoffMs(attempts), result.circuitUntil ?? 0),
        firstFailedAt
      }
      if (!skipped) deps.log?.(`notify: ${send.kind} ${send.routeId} via ${target.channelId} failed (${result.status})`)
      ended = row.attempts >= MAX_ATTEMPTS ? 'max attempts' : now - firstFailedAt >= MAX_RETRY_AGE_MS ? 'max age' : null
      if (ended !== null) {
        row = closeByLimit(row, ended, send.digest, now, digestGateMs(send))
        deps.log?.(`notify: ${send.kind} ${send.routeId} via ${target.channelId} given up (${ended})`)
      }
    }
    deps.store.putLog(row)
    return ended
  }

  /**
   * A ladder is one unit: when one of its rows is given up on, the others still waiting on a retry (a rung that was skipped for an open
   * circuit has made fewer tries) end with it, so no half of the unit is left retrying.
   */
  function closeUnit(send: PlannedSend, reason: string): ResultRow[] {
    const now = deps.now()
    const rows: ResultRow[] = []
    for (const target of send.targets) {
      const row = deps.store.getLog(target.logKey)
      if (!row || row.closed !== undefined || row.nextAttemptAt === null) continue
      deps.store.putLog(closeByLimit(row, reason, send.digest, now, digestGateMs(send)))
      rows.push(endRow(now, send.incidentKey, send.routeId, target.channelId, send.kind, reason))
    }
    return rows
  }

  function resultRow(send: PlannedSend, channelId: string, result: SendResult): ResultRow {
    const row: ResultRow = {
      at: deps.now(),
      incidentKey: send.incidentKey,
      routeId: send.routeId,
      channelId,
      kind: send.kind,
      ok: result.ok,
      status: result.status,
      latencyMs: result.latencyMs
    }
    deps.store.addResult(row)
    return row
  }

  /**
   * A record copy that failed for a reason that may pass is tried again after 2 s, 10 s and 30 s (longer when the server said Retry-After),
   * apart from the tick: the ladder and the next tick never wait on a record, and a record that never lands only leaves failed rows
   * in the result log and a line in the operator log.
   */
  const retrying = new Set<Promise<void>>()
  async function retryRecord(send: PlannedSend, channelId: string, msg: Message, first: SendResult): Promise<void> {
    let last = first
    for (const delay of timing.recordRetryMs) {
      await timing.sleep(Math.max(delay, last.retryAfterMs ?? 0))
      last = await attempt(channelId, msg)
      resultRow(send, channelId, last)
      if (last.ok) return
      deps.log?.(`notify: record ${send.routeId} via ${channelId} failed again (${last.status})`)
      if (!retryable(last)) return
    }
  }

  /** Record channels get a copy of what went out, outside the ladder and without touching its log rows. */
  async function copies(send: PlannedSend, msg: Message): Promise<ResultRow[]> {
    const ids = send.record.filter((id) => !send.targets.some((t) => t.channelId === id))
    const results = await Promise.all(ids.map((id) => attempt(id, msg)))
    results.forEach((result, i) => {
      if (result.ok) return
      deps.log?.(`notify: record ${send.routeId} via ${ids[i]} failed (${result.status})`)
      if (!retryable(result) || timing.recordRetryMs.length === 0) return
      const run = retryRecord(send, ids[i], msg, result)
        .catch((err) => deps.log?.(`notify: a record retry failed to settle (${errorName(err)})`))
        .finally(() => retrying.delete(run))
      retrying.add(run)
    })
    return results.map((result, i) => resultRow(send, ids[i], result))
  }

  /** A digest that landed owns the incidents it listed: their alert rows say "notified now". */
  function settleDigest(send: PlannedSend, delivered: Target[]): void {
    deps.store.putHeld(send.routeId, [])
    const now = deps.now()
    for (const cover of send.covers) {
      for (const target of delivered) {
        deps.store.putLog({
          key: logKey(cover.incidentKey, send.routeId, target.channelId, 'alert'),
          sentAt: now,
          digest: cover.digest,
          ok: true,
          attempts: 0,
          nextAttemptAt: null
        })
      }
    }
  }

  async function execute(send: PlannedSend): Promise<ResultRow[]> {
    const msg = buildMessage(send.subject, context())
    const outcomes =
      send.mode === 'ladder'
        ? await ladder(send.targets, msg)
        : await Promise.all(send.targets.map(async (target) => ({ target, result: await attempt(target.channelId, msg) })))
    const rows: ResultRow[] = []
    let ended: string | null = null
    for (const outcome of outcomes) {
      const over = commit(send, outcome)
      rows.push(resultRow(send, outcome.target.channelId, outcome.result))
      if (over !== null) {
        ended = over
        rows.push(endRow(deps.now(), send.incidentKey, send.routeId, outcome.target.channelId, send.kind, over))
      }
    }
    if (ended !== null && send.mode === 'ladder') rows.push(...closeUnit(send, ended))
    const delivered = outcomes.filter((o) => o.result.ok).map((o) => o.target)
    if (delivered.length > 0) {
      if (send.clearsHeld) settleDigest(send, delivered)
      rows.push(...(await copies(send, msg)))
    }
    return rows
  }

  function context(): MessageContext {
    return { baseUrl: deps.baseUrl, ackSecret: deps.ackSecret, nowMs: deps.now() }
  }

  /**
   * Before anything is planned: the retries that are over end here, each with a result row that says why ("abandoned: incident resolved",
   * "abandoned: max attempts"), so a retry never runs for an incident that moved on and a queue of old failures never outlives its caps.
   */
  function sweep(views: NotifyView[], resolved: ResolvedView[], nowMs: number): ResultRow[] {
    const pending = deps.store.listPending?.() ?? []
    if (pending.length === 0) return []
    const ended = planAbandons({ pending, routes: deps.routes, views, resolved, nowMs, getHeld: (routeId) => deps.store.getHeld(routeId), getLog: (key) => deps.store.getLog(key) })
    if (ended.length > 0) deps.log?.(`notify: ${ended.length} retries ended (${[...new Set(ended.map((a) => a.reason))].join(', ')})`)
    return ended.map((a) => {
      deps.store.putLog(a.row)
      return endRow(nowMs, a.incidentKey, a.routeId, a.channelId, a.kind, a.reason)
    })
  }

  /**
   * A page alert held back into a summary: its log rows close with "coalesced into <id>", which is what keeps it from being planned again every
   * tick (the repeat gate runs from now) and what the summary counts it by, and one result row says so for the wall.
   */
  function holdBack(held: CoalescedAlert): ResultRow {
    const now = deps.now()
    const status = `${COALESCED_PREFIX}${held.summaryId}`
    for (const target of held.targets) {
      deps.store.putLog({ key: target.logKey, sentAt: now, digest: held.digest, ok: false, attempts: 0, nextAttemptAt: null, closed: status })
    }
    const row: ResultRow = { at: now, incidentKey: held.incidentKey, routeId: held.routeId, channelId: held.targets[0]?.channelId ?? '', kind: 'alert', ok: false, status, latencyMs: 0 }
    deps.store.addResult(row)
    return row
  }

  async function runTick(views: NotifyView[], resolved: ResolvedView[]): Promise<ResultRow[]> {
    const nowMs = deps.now()
    const dropped = sweep(views, resolved, nowMs)
    const plan = planSends({
      routes: deps.routes,
      views,
      resolved,
      nowMs,
      quiet: quietState(deps.quiet, nowMs).quiet,
      getLog: (key) => deps.store.getLog(key),
      getHeld: (routeId) => deps.store.getHeld(routeId)
    })
    for (const h of plan.held) deps.store.putHeld(h.routeId, h.keys)
    const holding = (plan.coalesced ?? []).map(holdBack)
    if (holding.length > 0) deps.log?.(`notify: ${holding.length} page alerts held back into ${new Set(plan.coalesced?.map((c) => c.summaryId)).size} summary`)
    // One send failing to settle (a store error, say) must not hide what the others did.
    const settled = await Promise.allSettled(plan.sends.map(execute))
    return [
      ...dropped,
      ...holding,
      ...settled.flatMap((s) => {
        if (s.status === 'fulfilled') return s.value
        deps.log?.(`notify: a send failed to settle (${errorName(s.reason)})`)
        return []
      })
    ]
  }

  // Ticks run one at a time: a slow ladder must not let the next tick plan the same send again.
  let queue: Promise<unknown> = Promise.resolve()
  return {
    tick(views, resolved) {
      const run = queue.then(() => runTick(views, resolved))
      queue = run.catch(() => undefined)
      return run
    },
    test(channelId) {
      return attempt(channelId, testMessage(deps.baseUrl, deps.brand))
    },
    async settled() {
      while (retrying.size > 0) await Promise.all([...retrying])
    }
  }
}
