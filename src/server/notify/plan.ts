// The notifier's decisions, as one pure function: given the firing and resolved incidents, the notification
// log and the clock, say which sends are due. Nothing here sends, writes or reads a clock.
//
// Alertmanager semantics, restated (prometheus/alertmanager docs/configuration.md group_wait / group_interval /
// repeat_interval / continue / mute_time_intervals; nflog/nflog.go stateKey; notify/dedup_stage.go "Nothing
// changed, only notify if the repeat interval has passed"; notify/retry_stage.go exponential backoff):
//  - group_wait: nothing goes out until the incident has been seen for that long.
//  - a changed set of firing fingerprints re-notifies, but only once group_interval has passed;
//  - an unchanged set re-notifies only after repeat_interval (alertmanager issue 2320: never sooner);
//  - a failed send keeps the old log row and backs off 5 s, 10 s, 20 s ... up to 300 s, and gives up after MAX_ATTEMPTS tries or
//    MAX_RETRY_AGE_MS, whichever comes first (Alertmanager's retry_stage gives up when the group's context ends; here the cap is ours);
//  - a retry that is no longer owed is dropped before it runs: the incident resolved, was acknowledged, or is no longer flapping.

import { createHash } from 'node:crypto'
import type { RouteConfig } from '../config.ts'
import { COALESCED_PREFIX, isSettled, logKey, parseLogKey } from './log.ts'
import { matchedRoutes } from './match.ts'
import type { Matchable } from './match.ts'
import { coalesceLimits, openSummaryId, parseSummaryId, recentPages, summariesOf, summaryId } from './coalesce.ts'
import type { CoalesceInput, SummaryView } from './coalesce.ts'

export { COALESCED_PREFIX, isSettled, logKey, parseLogKey }
import type { LogRow, MessageKind, NotifyView, ResolvedView } from './types.ts'

/** A resolved notice waits until the incident has stayed resolved this long. */
export const RESOLVED_STABLE_SEC = 600

/**
 * A send that keeps failing is tried at most this many times: the waits between tries are 5, 10, 20, 40, 80, 160 and 300 s, so 8 tries
 * span about ten minutes plus the time the tries themselves take. That is one full ramp of the backoff up to its 300 s cap, and about
 * the 600 s at which the first escalation step (SMS) takes over from the phone. A skipped call (an open circuit) is not a try.
 */
export const MAX_ATTEMPTS = 8

/**
 * ... and for at most this long from its first failure, which catches what the count cannot: a target whose circuit is open for 15
 * minutes or 2 hours makes no tries, a stalled notifier makes few. 30 minutes is the page route's repeat interval: a retry never
 * outlives the next scheduled reminder of the same alert.
 */
export const MAX_RETRY_AGE_MS = 30 * 60_000

export interface Target {
  channelId: string
  logKey: string
}

export type Subject =
  | { type: 'firing'; kind: 'alert' | 'escalation' | 'flapping'; view: NotifyView }
  | { type: 'resolved'; view: ResolvedView }
  | { type: 'digest'; routeId: string; views: NotifyView[] }
  | { type: 'summary'; kind: 'summary' | 'escalation'; summary: SummaryView }

export interface PlannedSend {
  routeId: string
  /** The incident key for the result log; `digest:<route>` for a digest. */
  incidentKey: string
  kind: MessageKind
  stage: string
  mode: RouteConfig['mode']
  /** Receivers to try, in order. In mode 'all' only the receivers that are due. */
  targets: Target[]
  record: string[]
  /** Written to the log row on success. */
  digest: string
  subject: Subject
  /** A digest stands in for these incidents' alert sends: on success their alert rows are written. */
  covers: Array<{ incidentKey: string; digest: string }>
  clearsHeld: boolean
}

export interface PlanInput {
  routes: RouteConfig[]
  views: NotifyView[]
  resolved: ResolvedView[]
  nowMs: number
  quiet: boolean
  getLog(key: string): LogRow | null
  getHeld(routeId: string): string[]
}

/** A page alert that is not sent on its own: it goes into a summary. The executor closes its log rows with "coalesced into <id>" and records it. */
export interface CoalescedAlert {
  routeId: string
  incidentKey: string
  targets: Target[]
  digest: string
  summaryId: string
}

export interface Plan {
  sends: PlannedSend[]
  /** Routes whose held list changed, with the new list. */
  held: Array<{ routeId: string; keys: string[] }>
  /** Page alerts held back into a summary; absent when there are none. */
  coalesced?: CoalescedAlert[]
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** sha256 of the sorted firing fingerprints: the nflog "what was notified" state. */
export function fingerprintDigest(view: Pick<NotifyView, 'instances'>): string {
  return sha256(view.instances.map((i) => i.fingerprint).sort().join('\n'))
}

/** Delay before the next try after `attempts` failures: 5 s doubling, capped at 300 s. */
export function backoffMs(attempts: number): number {
  return Math.min(5000 * 2 ** attempts, 300_000)
}

interface Gate {
  groupIntervalSec: number
  repeatIntervalSec: number
}

/** The send decision for one log row. `once` stages (resolved) never repeat after a success. */
export function isDue(
  row: LogRow | null,
  retryAt: number | null,
  digest: string,
  nowMs: number,
  gate: Gate,
  once = false
): boolean {
  if (retryAt !== null && nowMs < retryAt) return false
  if (row === null || !isSettled(row)) return true
  if (once) return false
  const sinceMs = nowMs - row.sentAt
  if (sinceMs >= gate.repeatIntervalSec * 1000) return true
  return row.digest !== digest && sinceMs >= gate.groupIntervalSec * 1000
}

/** A ladder is one unit: its state is the newest settled row among its receivers and the latest retry gate. */
function unitState(rows: Array<LogRow | null>): { row: LogRow | null; retryAt: number | null } {
  const present = rows.filter((r): r is LogRow => r !== null)
  const delivered = present.filter(isSettled).sort((a, b) => b.sentAt - a.sentAt)[0]
  const retries = present.map((r) => r.nextAttemptAt).filter((t): t is number => t !== null)
  return { row: delivered ?? present[0] ?? null, retryAt: retries.length > 0 ? Math.max(...retries) : null }
}

function dueTargets(
  route: RouteConfig,
  receivers: string[],
  incident: string,
  stage: string,
  digest: string,
  input: PlanInput,
  once = false,
  freshSinceMs: number | null = null
): Target[] {
  const targets = [...new Set(receivers)].map((channelId) => ({
    channelId,
    logKey: logKey(incident, route.id, channelId, stage)
  }))
  // A row written before the episode began again (a park that has ended) belongs to the episode before it: it neither dedupes nor backs off this one.
  const rows = targets.map((t) => {
    const row = input.getLog(t.logKey)
    return row !== null && freshSinceMs !== null && row.sentAt < freshSinceMs ? null : row
  })
  if (route.mode === 'ladder') {
    const { row, retryAt } = unitState(rows)
    return isDue(row, retryAt, digest, input.nowMs, route, once) ? targets : []
  }
  return targets.filter((_, i) => isDue(rows[i], rows[i]?.nextAttemptAt ?? null, digest, input.nowMs, route, once))
}

function mutedNow(route: RouteConfig, severity: NotifyView['severity'], quiet: boolean): boolean {
  return Boolean(route.muteInQuietHours) && quiet && severity !== 'page'
}

interface Stage {
  name: string
  kind: 'alert' | 'escalation' | 'flapping'
  receivers: string[]
  digest: string
}

/** When the incident's current episode began for the pager: the later of first seen and the end of a park it came back from. */
function episodeSinceMs(view: NotifyView): number {
  const seen = Date.parse(view.firstSeen)
  const fresh = view.freshSince ? Date.parse(view.freshSince) : Number.NaN
  return Number.isNaN(fresh) ? seen : Number.isNaN(seen) ? fresh : Math.max(seen, fresh)
}

function stagesFor(view: NotifyView, route: RouteConfig, nowMs: number): Stage[] {
  const stages: Stage[] = []
  const seen = episodeSinceMs(view)
  const waited = Number.isNaN(seen) || nowMs - seen >= route.groupWaitSec * 1000
  const fingerprints = fingerprintDigest(view)
  if (waited) {
    // A flapping incident gets one notice at the repeat interval, not an alert per flip.
    stages.push(
      view.flapping
        ? { name: 'flap', kind: 'flapping', receivers: route.receivers, digest: 'flap' }
        : { name: 'alert', kind: 'alert', receivers: route.receivers, digest: fingerprints }
    )
  }
  for (const [i, step] of (route.escalate ?? []).entries()) {
    if (view.unattendedSec >= step.afterSec) {
      stages.push({ name: `esc${i}`, kind: 'escalation', receivers: step.receivers, digest: fingerprints })
    }
  }
  return stages
}

function planDigest(route: RouteConfig, keys: string[], byKey: Map<string, NotifyView>, input: PlanInput) {
  const views = [...new Set(keys)].map((k) => byKey.get(k)).filter((v): v is NotifyView => v?.attention === 'none')
  if (views.length === 0) return { send: null, clear: true }
  const incident = `digest:${route.id}`
  const targets = [...new Set(route.receivers)].map((channelId) => ({
    channelId,
    logKey: logKey(incident, route.id, channelId, 'digest')
  }))
  // Only the retry gate matters here: the held list itself says a digest is owed.
  const { retryAt } = unitState(targets.map((t) => input.getLog(t.logKey)))
  if (retryAt !== null && input.nowMs < retryAt) return { send: null, clear: false }
  const send: PlannedSend = {
    routeId: route.id,
    incidentKey: incident,
    kind: 'digest',
    stage: 'digest',
    mode: route.mode,
    targets,
    record: route.record ?? [],
    digest: sha256(views.map((v) => v.key).sort().join('\n')),
    subject: { type: 'digest', routeId: route.id, views },
    covers: views.map((v) => ({ incidentKey: v.key, digest: fingerprintDigest(v) })),
    clearsHeld: true
  }
  return { send, clear: false }
}

/** A log row that still counts for the episode being planned: one from before the episode began again (a park that has ended) is another episode's. */
function liveRow(row: LogRow | null, freshSinceMs: number | null): LogRow | null {
  return row !== null && freshSinceMs !== null && row.sentAt < freshSinceMs ? null : row
}

/**
 * Which page alerts due now are held back into a summary (coalesce.ts). Per route and origin: the page notifications already sent inside the
 * rolling window use up the room, the due alerts that are new (not a retry of a page that went out, which was let through when it did) fill what
 * is left, oldest first, and the rest are held. They all join the origin's open summary window, or open a new one.
 */
function decideCoalescing(input: PlanInput, owned: Map<string, Set<string>>): { held: Map<string, string>; alerts: CoalescedAlert[] } {
  interface Candidate {
    view: NotifyView
    targets: Target[]
    digest: string
    since: number
  }
  const scopes = new Map<string, { route: RouteConfig; origin: string; candidates: Candidate[] }>()
  for (const view of input.views) {
    if (view.attention !== 'none' || view.severity !== 'page') continue
    for (const route of matchedRoutes(input.routes, view)) {
      if (!coalesceLimits(route) || owned.get(route.id)?.has(view.key)) continue
      const stage = stagesFor(view, route, input.nowMs).find((st) => st.name === 'alert')
      if (!stage) continue
      const fresh = view.freshSince ? Date.parse(view.freshSince) : Number.NaN
      const freshSince = Number.isNaN(fresh) ? null : fresh
      const targets = dueTargets(route, stage.receivers, view.key, 'alert', stage.digest, input, false, freshSince)
      if (targets.length === 0) continue
      const retrying = targets.some((t) => {
        const row = liveRow(input.getLog(t.logKey), freshSince)
        return row !== null && !isSettled(row)
      })
      if (retrying) continue
      const scope = `${route.id}|${view.origin}`
      let entry = scopes.get(scope)
      if (!entry) scopes.set(scope, (entry = { route, origin: view.origin, candidates: [] }))
      const since = episodeSinceMs(view)
      entry.candidates.push({ view, targets, digest: stage.digest, since: Number.isNaN(since) ? 0 : since })
    }
  }
  const held = new Map<string, string>()
  const alerts: CoalescedAlert[] = []
  const log: CoalesceInput = { routes: input.routes, views: input.views, resolved: input.resolved, nowMs: input.nowMs, getLog: input.getLog }
  for (const { route, origin, candidates } of scopes.values()) {
    const limits = coalesceLimits(route)
    if (!limits) continue
    const room = Math.max(0, limits.maxPages - recentPages(route, origin, new Set(candidates.map((c) => c.view.key)), log))
    const over = [...candidates].sort((a, b) => a.since - b.since || a.view.key.localeCompare(b.view.key)).slice(room)
    if (over.length === 0) continue
    const id = openSummaryId(route, origin, log) ?? summaryId(route.id, origin, input.nowMs)
    for (const c of over) {
      held.set(`${route.id}|${c.view.key}`, id)
      alerts.push({ routeId: route.id, incidentKey: c.view.key, targets: c.targets, digest: c.digest, summaryId: id })
    }
  }
  return { held, alerts }
}

/** The summaries whose window has closed and that still have someone to tell, and their escalation steps: they go where the held pages would have gone. */
function planSummaries(input: PlanInput, sends: PlannedSend[]): void {
  const log: CoalesceInput = { routes: input.routes, views: input.views, resolved: input.resolved, nowMs: input.nowMs, getLog: input.getLog }
  for (const route of input.routes) {
    const limits = coalesceLimits(route)
    if (!limits) continue
    for (const summary of summariesOf(route, log)) {
      const parsed = parseSummaryId(summary.id)
      // A window still taking alerts is not told yet; one whose alerts have all cleared or been taken has nothing left to say.
      if (!parsed || input.nowMs < parsed.startMs + limits.windowMs || summary.open === 0) continue
      const stages: Array<{ name: string; kind: 'summary' | 'escalation'; receivers: string[]; once: boolean }> = [{ name: 'summary', kind: 'summary', receivers: route.receivers, once: true }]
      for (const [i, step] of (route.escalate ?? []).entries()) {
        if (summary.unattendedSec >= step.afterSec) stages.push({ name: `sumesc${i}`, kind: 'escalation', receivers: step.receivers, once: false })
      }
      for (const stage of stages) {
        const targets = dueTargets(route, stage.receivers, summary.id, stage.name, '', input, stage.once)
        if (targets.length === 0) continue
        sends.push({
          routeId: route.id,
          incidentKey: summary.id,
          kind: stage.kind,
          stage: stage.name,
          mode: route.mode,
          targets,
          record: route.record ?? [],
          digest: '',
          subject: { type: 'summary', kind: stage.kind, summary },
          covers: [],
          clearsHeld: false
        })
      }
    }
  }
}

export function planSends(input: PlanInput): Plan {
  const sends: PlannedSend[] = []
  const held = new Map<string, Set<string>>()
  const changed = new Set<string>()
  const byKey = new Map(input.views.map((v) => [v.key, v]))
  const heldOf = (routeId: string): Set<string> => {
    let set = held.get(routeId)
    if (!set) held.set(routeId, (set = new Set(input.getHeld(routeId))))
    return set
  }

  // Quiet is over for these routes: a digest owes them the incidents held back, and owns those incidents
  // until it lands, so the normal alert sends skip them.
  const owned = new Map<string, Set<string>>()
  for (const route of input.routes) {
    const keys = input.getHeld(route.id)
    if (keys.length === 0 || (route.muteInQuietHours && input.quiet)) continue
    owned.set(route.id, new Set(keys))
    const { send, clear } = planDigest(route, keys, byKey, input)
    if (send) sends.push(send)
    if (clear) {
      held.set(route.id, new Set())
      changed.add(route.id)
    }
  }

  const coalescing = decideCoalescing(input, owned)
  // A page held back into a summary does not escalate on its own: SMS and email follow the summary.
  const heldBack = (route: RouteConfig, view: NotifyView): boolean =>
    coalescing.held.has(`${route.id}|${view.key}`) ||
    (view.severity === 'page' && coalesceLimits(route) !== null && route.receivers.some((r) => input.getLog(logKey(view.key, route.id, r, 'alert'))?.closed?.startsWith(COALESCED_PREFIX)))

  for (const view of input.views) {
    if (view.attention !== 'none') continue
    for (const route of matchedRoutes(input.routes, view)) {
      if (owned.get(route.id)?.has(view.key)) continue
      for (const stage of stagesFor(view, route, input.nowMs)) {
        if (coalescing.held.has(`${route.id}|${view.key}`) && stage.name === 'alert') continue
        if (stage.kind === 'escalation' && heldBack(route, view)) continue
        const fresh = view.freshSince ? Date.parse(view.freshSince) : Number.NaN
        const targets = dueTargets(route, stage.receivers, view.key, stage.name, stage.digest, input, false, Number.isNaN(fresh) ? null : fresh)
        if (targets.length === 0) continue
        if (mutedNow(route, view.severity, input.quiet)) {
          if (!heldOf(route.id).has(view.key)) {
            heldOf(route.id).add(view.key)
            changed.add(route.id)
          }
          continue
        }
        sends.push({
          routeId: route.id,
          incidentKey: view.key,
          kind: stage.kind,
          stage: stage.name,
          mode: route.mode,
          targets,
          record: route.record ?? [],
          digest: stage.digest,
          subject: { type: 'firing', kind: stage.kind, view },
          covers: [],
          clearsHeld: false
        })
      }
    }
  }

  for (const view of input.resolved) {
    for (const route of matchedRoutes(input.routes, view)) {
      if (!route.sendResolved || !view.wasNotified || view.stableForSec < RESOLVED_STABLE_SEC) continue
      if (mutedNow(route, view.severity, input.quiet)) continue
      const incident = `${view.key}@${view.resolvedAt}`
      const targets = dueTargets(route, route.receivers, incident, 'resolved', '', input, true)
      if (targets.length === 0) continue
      sends.push({
        routeId: route.id,
        incidentKey: view.key,
        kind: 'resolved',
        stage: 'resolved',
        mode: route.mode,
        targets,
        record: route.record ?? [],
        digest: '',
        subject: { type: 'resolved', view },
        covers: [],
        clearsHeld: false
      })
    }
  }

  planSummaries(input, sends)

  return {
    sends,
    held: [...changed].map((routeId) => ({ routeId, keys: [...(held.get(routeId) ?? [])] })),
    ...(coalescing.alerts.length > 0 ? { coalesced: coalescing.alerts } : {})
  }
}

// ---- retries that are over -----------------------------------------------------------------------

/** The message kind a log stage sends, for the result row that records its end. */
export function kindOfStage(stage: string): MessageKind {
  if (stage === 'resolved') return 'resolved'
  if (stage === 'digest') return 'digest'
  if (stage === 'summary') return 'summary'
  if (stage === 'flap') return 'flapping'
  if (stage.startsWith('esc') || stage.startsWith('sumesc')) return 'escalation'
  return 'alert'
}

/** The result status of a send that was given up on. */
export function abandonedStatus(reason: string): string {
  return `abandoned: ${reason}`
}

const ATTENTION_REASON: Record<Exclude<NotifyView['attention'], 'none'>, string> = {
  acked: 'incident acknowledged',
  silenced: 'incident silenced',
  parked: 'incident parked'
}

/**
 * The row of a send that failed every time it was allowed to: counts as sent now (the repeat gate and the digest comparison run from
 * here, so the next try is a reminder or a change, not an immediate fresh round of the same retries) and says why. A digest has no
 * repeat gate of its own, so it waits `gateMs` before the next round.
 */
export function closeByLimit(row: LogRow, reason: string, digest: string, nowMs: number, gateMs: number | null): LogRow {
  const { firstFailedAt, ...rest } = row
  return {
    ...rest,
    sentAt: nowMs,
    digest,
    ok: false,
    nextAttemptAt: gateMs === null ? null : nowMs + gateMs,
    ...(firstFailedAt !== undefined ? { firstFailedAt } : {}),
    closed: abandonedStatus(reason)
  }
}

/**
 * The row of a send that is no longer owed (its incident moved on). A row that had delivered before the failing retry goes back to
 * being that delivered row. One that never delivered becomes a row that never sent anything: a repeat gate that has long passed, so a
 * notification owed again later (an acknowledgement taken off) goes out at once.
 */
export function closeAsStale(row: LogRow, reason: string): LogRow {
  const { firstFailedAt, closed: _closed, ...rest } = row
  if (row.ok) return { ...rest, attempts: 0, nextAttemptAt: null }
  return { ...rest, sentAt: 0, digest: '', nextAttemptAt: null, ...(firstFailedAt !== undefined ? { firstFailedAt } : {}), closed: abandonedStatus(reason) }
}

export interface Abandon {
  /** The row as it is to be written. */
  row: LogRow
  /** Why, without the "abandoned: " the status puts in front. */
  reason: string
  incidentKey: string
  routeId: string
  channelId: string
  kind: MessageKind
}

export interface AbandonInput {
  /** Rows waiting on a retry. */
  pending: LogRow[]
  routes: RouteConfig[]
  views: NotifyView[]
  resolved: ResolvedView[]
  nowMs: number
  getHeld(routeId: string): string[]
  /** Needed to tell whether a summary still has anyone to tell; without it a summary's retries are left to the caps. */
  getLog?(key: string): LogRow | null
}

/** Why the send behind this log row is no longer owed, or null when it still is. */
function staleReason(p: { incident: string; routeId: string; stage: string }, input: AbandonInput, firing: Map<string, NotifyView>): string | null {
  if (!input.routes.some((r) => r.id === p.routeId)) return 'route no longer configured'
  if (p.stage === 'digest') return input.getHeld(p.routeId).length === 0 ? 'nothing held' : null
  if (p.stage === 'summary' || p.stage.startsWith('sumesc')) {
    const route = input.routes.find((r) => r.id === p.routeId)
    const { getLog } = input
    if (!route || !getLog) return null
    const summary = summariesOf(route, { routes: input.routes, views: input.views, resolved: input.resolved, nowMs: input.nowMs, getLog }).find((x) => x.id === p.incident)
    return summary === undefined || summary.open === 0 ? 'summary no longer owed' : null
  }
  const onRoute = (item: Matchable): boolean => matchedRoutes(input.routes, item).some((r) => r.id === p.routeId)
  if (p.stage === 'resolved') {
    // The incident part of a resolved row is `<incident key>@<resolvedAt>`; an ISO time holds no "@".
    const at = p.incident.lastIndexOf('@')
    const key = at < 0 ? p.incident : p.incident.slice(0, at)
    const resolvedAt = at < 0 ? '' : p.incident.slice(at + 1)
    if (firing.has(key)) return 'incident no longer resolved'
    const resolved = input.resolved.find((r) => r.key === key && r.resolvedAt === resolvedAt)
    if (!resolved) return 'resolved notice expired'
    return onRoute(resolved) ? null : 'route no longer matches'
  }
  const view = firing.get(p.incident)
  if (!view) return 'incident resolved'
  if (view.attention !== 'none') return ATTENTION_REASON[view.attention]
  // A page that dropped to a warning is another route's now (the pager speaks for the incident's current severity): the page route's retry is not owed.
  if (!onRoute(view)) return 'route no longer matches'
  if (p.stage === 'flap') return view.flapping ? null : 'incident no longer flapping'
  if (p.stage === 'alert' && view.flapping) return 'incident flapping'
  return null
}

/** What the retry's own log row will say it last notified, so a given-up row gates on the same comparison the planner makes. */
function stageDigest(stage: string, view: NotifyView | undefined): string {
  if (stage === 'flap') return 'flap'
  if (stage === 'resolved' || stage === 'digest' || !view) return ''
  return fingerprintDigest(view)
}

/**
 * Before any retry runs: the rows whose send is over. A send is over when its incident is no longer in the state that called for it
 * (a `resolved` or `flapping` notice whose incident is not resolved or flapping now; an alert, escalation or flapping notice whose
 * incident resolved or was acknowledged, silenced or parked), when its route is gone, or when it has used up its tries or its time.
 * The state is checked first: a notice that is no longer owed says so, not that it ran out of attempts.
 */
export function planAbandons(input: AbandonInput): Abandon[] {
  const firing = new Map(input.views.map((v) => [v.key, v]))
  const out: Abandon[] = []
  for (const row of input.pending) {
    const p = parseLogKey(row.key)
    if (!p) continue
    const stale = staleReason(p, input, firing)
    const limit =
      row.attempts >= MAX_ATTEMPTS
        ? 'max attempts'
        : row.firstFailedAt !== undefined && input.nowMs - row.firstFailedAt >= MAX_RETRY_AGE_MS
          ? 'max age'
          : null
    const reason = stale ?? limit
    if (reason === null) continue
    const route = input.routes.find((r) => r.id === p.routeId)
    const closed =
      stale !== null
        ? closeAsStale(row, stale)
        : closeByLimit(row, reason, stageDigest(p.stage, firing.get(p.incident)), input.nowMs, p.stage === 'digest' ? (route?.repeatIntervalSec ?? 0) * 1000 : null)
    const at = p.stage === 'resolved' ? p.incident.lastIndexOf('@') : -1
    out.push({
      row: closed,
      reason,
      incidentKey: at < 0 ? p.incident : p.incident.slice(0, at),
      routeId: p.routeId,
      channelId: p.receiverId,
      kind: kindOfStage(p.stage)
    })
  }
  return out
}
