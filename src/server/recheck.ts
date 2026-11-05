// On-demand re-check: poll the sources now instead of waiting for their interval, so a person can see whether an alert has cleared.
//
// One door. The scheduled loop in main.ts and a re-check both poll through `PollRunner`, and a poll is the same three steps either way:
// the source's `poll()`, `engine.ingest(observation)`, `engine.recordSource(...)`. A re-check therefore resolves and keeps alerts exactly as
// a scheduled poll does, and the notifier sees the result the way it sees a scheduled poll's, on its own tick (a re-check only wakes that
// tick early, as a webhook or an ack already does).
//
// Three limits keep a click from becoming load on a source:
// - one poll per source at a time: a click while a poll is running (scheduled or another click's) joins it;
// - one poll per source in any RECHECK_GAP_SEC: a click inside the gap polls nothing and is answered with the last poll's outcome,
//   and says so (`throttled`). The scheduled polls count toward the gap, so a source is never hit faster than the gap by clicks;
// - a push source (a webhook, the regression sweep, the prober, the alert bridge) cannot be polled at all: its alerts get the sender,
//   when it last reported, what it promised and when it reports next, so the person knows when the alert can next change. A pusher whose
//   source takes `recheckRequests` is asked instead: Re-check on a firing alert leaves it a request (src/server/push-recheck.ts) that the
//   sender picks up and answers, and the answer carries the request's state.
//
// A re-check that fails is told to the person who asked and is not recorded as a missed poll: a click is not a missed schedule, so it
// can never raise the source-stale warning sooner than the scheduled polls would.

import type { WatchConfig } from './config.ts'
import type { Engine } from './engine.ts'
import { RecheckStore, WALL_ASKER, pushedSenderOf, requestable } from './push-recheck.ts'
import type { Asker } from './push-recheck.ts'
import type { PolledSource } from './sources/types.ts'
import { RECHECK_GAP_SEC } from '../shared/recheck.ts'
import type { AlertRecheck, AlertState, PushedSender, RecheckSource, WallRecheck } from '../shared/recheck.ts'

export const RECHECK_GAP_MS = RECHECK_GAP_SEC * 1000

export interface PollOutcome {
  ok: boolean
  error: string | null
  /** When the poll finished, ISO. */
  at: string
}

interface Flight {
  startedBy: 'schedule' | 'recheck'
  promise: Promise<PollOutcome>
}

export interface OnDemandResult {
  outcome: PollOutcome
  /** This call started a poll. */
  ran: boolean
  /** This call joined a poll already running. */
  shared: boolean
  /** Inside the gap: nothing was polled, `outcome` is the last poll's. */
  throttled: boolean
}

export class PollRunner {
  private readonly flights = new Map<string, Flight>()
  private readonly last = new Map<string, { startedMs: number; outcome: PollOutcome }>()

  private readonly engine: Engine
  private readonly log: (line: string) => void
  private readonly nowMs: () => number

  constructor(engine: Engine, log: (line: string) => void, nowMs: () => number = Date.now) {
    this.engine = engine
    this.log = log
    this.nowMs = nowMs
  }

  /** The scheduled poll. Never throttled; joins a poll already running instead of starting a second one. Never rejects. */
  async scheduled(src: PolledSource): Promise<PollOutcome> {
    const joined = this.flights.get(src.id)
    if (!joined) return this.start(src, 'schedule').promise
    const outcome = await joined.promise
    // A poll a click started did not record its failure; the schedule that joined it does, as if it had polled itself.
    if (!outcome.ok && joined.startedBy === 'recheck') this.engine.recordSource(src.id, false, outcome.error)
    return outcome
  }

  /** The on-demand poll: joins one that is running, answers from the last poll inside the gap, else polls. Never rejects. */
  async onDemand(src: PolledSource): Promise<OnDemandResult> {
    const running = this.flights.get(src.id)
    if (running) return { outcome: await running.promise, ran: false, shared: true, throttled: false }
    const last = this.last.get(src.id)
    if (last && this.nowMs() - last.startedMs < RECHECK_GAP_MS) return { outcome: last.outcome, ran: false, shared: false, throttled: true }
    const flight = this.start(src, 'recheck')
    return { outcome: await flight.promise, ran: true, shared: false, throttled: false }
  }

  private start(src: PolledSource, startedBy: Flight['startedBy']): Flight {
    const startedMs = this.nowMs()
    const flight: Flight = {
      startedBy,
      promise: this.poll(src, startedBy).then((outcome) => {
        this.last.set(src.id, { startedMs, outcome })
        this.flights.delete(src.id)
        return outcome
      })
    }
    this.flights.set(src.id, flight)
    return flight
  }

  private async poll(src: PolledSource, startedBy: Flight['startedBy']): Promise<PollOutcome> {
    const done = (ok: boolean, error: string | null): PollOutcome => ({ ok, error, at: new Date(this.nowMs()).toISOString() })
    try {
      const obs = await src.poll()
      this.engine.ingest(obs)
      this.engine.recordSource(src.id, true, null)
      return done(true, null)
    } catch (err) {
      const message = (err as Error).message
      if (startedBy === 'schedule') this.engine.recordSource(src.id, false, message.slice(0, 300))
      this.log(`poll ${src.id} failed: ${message}`)
      return done(false, message.slice(0, 300))
    }
  }
}

export interface Rechecker {
  /** Re-poll every pull source and say what came of it. */
  all(): Promise<WallRecheck>
  /**
   * Re-poll the source that raised one alert and answer with that alert's fresh state; null for a key Watch has never held. A firing alert of a
   * pushing source that takes requests is also asked of that sender: `asker` is who is asking (the wall's own, "wall", unless it says).
   */
  alert(key: string, asker?: Asker): Promise<AlertRecheck | null>
}

export interface RecheckDeps {
  engine: Engine
  cfg: WatchConfig
  runner: PollRunner
  /** The pull sources main started, whatever kinds there are. */
  sources: readonly PolledSource[]
  /** Wake the notifier's tick now, as a webhook ingest does. */
  nudge: () => void
  nowMs: () => number
  /** The re-check requests and the pushed schedule. Absent: one over the engine's own database. */
  store?: RecheckStore
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)]

export function createRechecker(d: RecheckDeps): Rechecker {
  const byId = new Map(d.sources.map((s) => [s.id, s]))
  const iso = (): string => new Date(d.nowMs()).toISOString()
  const store = d.store ?? new RecheckStore(d.engine.db, d.cfg, d.nowMs)

  const asked = async (src: PolledSource): Promise<{ result: RecheckSource; ran: boolean }> => {
    const r = await d.runner.onDemand(src)
    return {
      ran: r.ran,
      result: { id: src.id, kind: src.kind, ok: r.outcome.ok, error: r.outcome.error, checkedAt: r.outcome.at, ran: r.ran, shared: r.shared, throttled: r.throttled }
    }
  }

  return {
    async all() {
      const ids = d.sources.map((s) => s.id)
      const before = d.engine.firingKeysFrom(ids)
      const answers = await Promise.all(d.sources.map(asked))
      if (answers.some((a) => a.ran)) d.nudge()
      return {
        at: iso(),
        sources: answers.map((a) => a.result),
        cleared: d.engine.resolvedAmong(before).length,
        stillFiring: d.engine.firingKeysFrom(ids).length,
        pushed: d.cfg.sources.filter((s) => !byId.has(s.id) && s.type === 'webhook').map((s) => s.id),
        requestable: d.cfg.sources.filter((s) => !byId.has(s.id) && requestable(d.cfg, s.id)).map((s) => s.id)
      }
    },

    async alert(key, asker = WALL_ASKER) {
      const first = d.engine.alertPresence(key)
      if (!first) return null
      const a = first.alert
      const before: AlertState = a.resolvedAt ? 'resolved' : 'firing'
      const seenBy = unique([...a.via.map((v) => v.source), ...first.sources])
      // Watch's own source-stale warning is raised by a source that stopped answering: that source is the one to ask.
      const staleWarning = a.origin === 'self' && a.labels.alertname === 'source-stale'
      const askIds = staleWarning ? [a.labels.source ?? ''] : seenBy
      const polled = askIds.map((id) => byId.get(id)).filter((s): s is PolledSource => !!s)
      // A pusher cannot be polled, so a firing alert it reports is asked of it instead: one request, reused while it is open.
      if (!a.resolvedAt) for (const id of seenBy) if (!byId.has(id)) store.open(id, a, asker)
      const answers = await Promise.all(polled.map(asked))
      if (answers.some((x) => x.ran)) d.nudge()
      const now = d.engine.alertPresence(key)?.alert ?? a
      return {
        key,
        at: iso(),
        before,
        after: now.resolvedAt ? 'resolved' : 'firing',
        startsAt: now.startsAt,
        resolvedAt: now.resolvedAt,
        sources: answers.map((x) => x.result),
        pushed: seenBy.filter((id) => !byId.has(id)).map((id) => pushedSenderOf({ cfg: d.cfg, store }, id, a)).filter((p): p is PushedSender => !!p),
        clearsOnSweep: staleWarning && polled.length > 0,
        rule: now.rule
      }
    }
  }
}
