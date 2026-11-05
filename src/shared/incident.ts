// Severity, tier, age band and the weight of one incident.
//
// One pure function, `incidentState`, is read by the wall (size, border, footer) AND by the notifier (when
// to page, when to escalate). The wall is the pager's state, rendered: a tile that grows an age band is the
// same instant the pager moves to the next receiver set.
//
// Layer 3 of "steal the right layer", each with its source:
//  - Reach scaling: Sentry's issue ordering, log-scaled events times log-scaled users. Here the reach term
//    (`reach`, below) is the instance count n: 1 + floor(log2(1 + n)), an integer so the layout only moves
//    on a real step.
//  - Severity is a TIER with an area budget, not a multiplier (the drilled design): with a multiplier, 15
//    warnings would out-weigh one page exactly when many things are wrong and the page matters most.
//  - Standing alarms: EEMUA 191 and ISA-18.2 count how long an alarm has stood; here age counts only while
//    nobody has taken the problem, and an ack freezes it.
//  - Shelved alarms: ISA-18.2 shelves an alarm a person has judged, for a bounded time, with a reason, and shows the shelf apart from the live list.
//    A parked incident is that: the sweep's own open triage verdict (deferred to a date, or fixed and not deployed yet), shown in its own state and
//    colour, held off every live count and every page for at most PARK_MAX_HOURS, then back in its tier, unattended, with its clock starting at the park's end.
//    A park can also be set by hand (`Engine.park`, the MCP `park` tool) by whoever fixed or judged the incident, for any source; it is the same state with a name on it.

import type { Attention, IncidentState, Park, Severity, Tier } from './types.ts'

/** The most a park may run, counted from now: a `parked_until` further out than this is not honoured, and the incident shows as unattended. Nothing may be parked for a week. */
export const PARK_MAX_HOURS = 72
export const PARK_MAX_MS = PARK_MAX_HOURS * 3_600_000

/** The annotations that state a park. They are never part of an alert's identity (its key and its incident come from labels). */
export const PARK_KEYS = ['parked_state', 'parked_until', 'parked_since', 'parked_ref', 'parked_note'] as const

/** An ISO 8601 time with an explicit zone (Z or an offset): a bare local time is ambiguous, so it states no park. */
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/
const REF_MAX = 64
const NOTE_MAX = 200

/** The epoch ms of an ISO 8601 time that carries a zone (Z or an offset), or null for anything else: a bare local time, a date, text. */
export function zonedMs(v: string | undefined): number | null {
  if (v === undefined) return null
  const t = v.trim()
  if (!ISO_ZONED.test(t)) return null
  const ms = Date.parse(t)
  return Number.isNaN(ms) ? null : ms
}

function oneLine(v: string | undefined, max: number): string | null {
  if (v === undefined) return null
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (t === '') return null
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

/**
 * The park one alert's annotations state, or null when they state none that parses: `parked_state` is deferred or fixed_undeployed and `parked_until` is an
 * ISO time with a zone. Reads no clock, so whether the park holds is `incidentState`'s decision alone.
 */
export function parkOf(annotations: Readonly<Record<string, string>> | undefined): Park | null {
  if (!annotations) return null
  const state = annotations.parked_state?.trim().toLowerCase()
  if (state !== 'deferred' && state !== 'fixed_undeployed') return null
  const until = zonedMs(annotations.parked_until)
  if (until === null) return null
  const since = zonedMs(annotations.parked_since)
  return {
    state,
    until: new Date(until).toISOString(),
    since: since === null ? null : new Date(since).toISOString(),
    ref: oneLine(annotations.parked_ref, REF_MAX),
    note: oneLine(annotations.parked_note, NOTE_MAX)
  }
}

/**
 * The park an incident's alerts claim: every firing alert states one, else none (an alert that is not parked keeps the incident live). The park that ends first
 * governs, so the incident is back the moment any of its alerts is.
 */
export function incidentPark(alerts: ReadonlyArray<Readonly<Record<string, string>> | undefined>): Park | null {
  let governing: Park | null = null
  for (const a of alerts) {
    const p = parkOf(a)
    if (p === null) return null
    if (governing === null || p.until < governing.until) governing = p
  }
  return governing
}

/** True when a park holds at `nowMs`: it ends after now and no more than PARK_MAX_HOURS after it. */
export function parkHolds(p: Pick<Park, 'until'> | null, nowMs: number): boolean {
  if (p === null) return false
  const untilMs = Date.parse(p.until)
  return untilMs > nowMs && untilMs - nowMs <= PARK_MAX_MS
}

/**
 * The park that speaks for an incident now. A park set by hand governs while it holds: it is the latest word of whoever fixed or judged the incident, and it says who. Else
 * the park the alerts' annotations state, while it holds. Else, when neither holds, the park that ended last, so the unattended clock starts when the incident was last
 * handed back; else whatever park is claimed (one too far out is "not honoured", and counts from the incident's own start).
 */
export function governingPark(manual: Park | null, annotated: Park | null, nowMs: number): Park | null {
  if (parkHolds(manual, nowMs)) return manual
  if (parkHolds(annotated, nowMs)) return annotated
  const ended = [manual, annotated].filter((p): p is Park => p !== null && Date.parse(p.until) <= nowMs)
  if (ended.length > 0) return ended.reduce((a, b) => (Date.parse(b.until) > Date.parse(a.until) ? b : a))
  return annotated ?? manual
}

/** The incident is parked now (its `attention`): the one test every count, section and notice reads. */
export const isParked = (i: { state: { attention: Attention } }): boolean => i.state.attention === 'parked'

/** What a tile, a history row and a resolved notice call an incident: the rule, and the instance when the config splits that rule per instance. */
export function incidentTitle(x: { rule: string; instance?: string | null }): string {
  return x.instance ? `${x.rule} on ${x.instance}` : x.rule
}

/**
 * Tier base weights. Severity is a tier, not a factor: within a tier the weight can grow by less than SPREAD
 * (reach and age saturate), and the bases are SPREAD x 2 apart, so the smallest page tile is always at least
 * twice the largest warning tile, which is at least twice the largest quiet tile. Quantity and age can never
 * buy a warning past a page. (Drill of the adjudicated design, 2026-10-14: "with a multiplier, 15 warnings
 * would out-weigh one page exactly when many things are wrong".)
 */
export const TIER_BASE: Readonly<Record<Tier, number>> = { page: 64, warning: 8, quiet: 1 }
/** Within-tier growth is 1 + (SPREAD - 1) * R / (R + SOFT): below SPREAD for every R. */
export const SPREAD = 4
const SOFT = 12

/** A quiet tile's weight is its scope, capped so the largest quiet tile stays under half the smallest warning tile. */
export const QUIET_SCOPE_CAP = 5

/**
 * The area weight of one tile. A firing tile: its tier base times a saturating step of its integer R. A quiet
 * tile: its scope, the number of rules that watch it (linear, capped), so even an all-clear wall shows which
 * services carry the most watching.
 */
export function tileWeight(tier: Tier, R: number): number {
  if (tier === 'quiet') return TIER_BASE.quiet * Math.min(Math.max(R, 1), QUIET_SCOPE_CAP)
  return TIER_BASE[tier] * (1 + ((SPREAD - 1) * R) / (R + SOFT))
}

/** Age band edges in seconds: 10 minutes, 1 hour, 24 hours. Band edges are also the escalation edges. */
export const BAND_EDGES_SEC = [600, 3600, 86400] as const

/** Unattended age factor per band. Integers, so a layout step is a real step. Acked incidents use 1. */
export const AGE_FACTOR = [2, 3, 4, 6] as const
const ACKED_FACTOR = 1

const PAGE_LABELS = new Set(['critical', 'crit', 'page', 'fatal', 'emergency', 'alert', 'error', 'high'])
const WARNING_LABELS = new Set(['warning', 'warn', 'ticket', 'minor', 'medium'])
const INFO_LABELS = new Set(['info', 'informational', 'notice', 'low', 'debug', 'none', 'ok'])

/**
 * The severity contract already in use across the Watchers: critical, page, or an absent label is a page; warning,
 * warn and ticket are quiet warnings; info is wall-only. An unknown label is read as a warning, never a page,
 * so a typo cannot wake anyone and cannot hide the alert either.
 */
export function severityOf(label: string | undefined | null): Severity {
  if (label === undefined || label === null || label.trim() === '') return 'page'
  const v = label.trim().toLowerCase()
  if (PAGE_LABELS.has(v)) return 'page'
  if (WARNING_LABELS.has(v)) return 'warning'
  if (INFO_LABELS.has(v)) return 'info'
  return 'warning'
}

export function ageBand(ageSec: number): 0 | 1 | 2 | 3 {
  if (ageSec < BAND_EDGES_SEC[0]) return 0
  if (ageSec < BAND_EDGES_SEC[1]) return 1
  if (ageSec < BAND_EDGES_SEC[2]) return 2
  return 3
}

/** Reach term: 1 + floor(log2(1 + n)). One instance is 2, three are 3, seven are 4. */
export function reach(n: number): number {
  return 1 + Math.floor(Math.log2(1 + Math.max(0, n)))
}

export function tierOf(severity: Severity, attention: Attention): Tier {
  if (attention === 'silenced' || attention === 'parked') return 'quiet'
  if (severity === 'page') return 'page'
  if (severity === 'warning') return 'warning'
  return 'quiet'
}

export interface StateInput {
  severity: Severity
  /** Firing instances in the incident. */
  instances: number
  startsAtMs: number
  nowMs: number
  ackedAtMs?: number | null
  silencedUntilMs?: number | null
  /** The annotations of the incident's firing alerts, one record each: a park they all state (`incidentPark`) holds while it ends after now and within PARK_MAX_HOURS of it. */
  annotations?: ReadonlyArray<Readonly<Record<string, string>> | undefined>
  /** A park already read, for a caller that rolls incidents up (the By host wall): used in place of `annotations` and `manualPark`. */
  park?: Park | null
  /** The park someone set on the incident by hand (`Engine.park`). It governs while it holds and outranks the annotations' park; once it has ended the annotations' park may hold. */
  manualPark?: Park | null
}

/**
 * The one state function. Precedence: silenced, then acked, then parked, then none. Age counts only while unattended: an ack freezes the band and halves
 * the weight. A parked incident is the quiet tier at the quiet weight, counted as firing nowhere, and never pages; its unattended clock has not started.
 * When the park ends (or its annotations go) the incident is back in its severity tier, unattended, and the clock starts at the park's end, never at its
 * first firing. A park that ends more than PARK_MAX_HOURS from now is not honoured at all. A park set by hand (`manualPark`) is read the same way and wins over the
 * annotations' park while it holds; ending one early (unpark) writes its end as now, so the clock starts there.
 */
export function incidentState(i: StateInput): IncidentState {
  const silenced = i.silencedUntilMs != null && i.silencedUntilMs > i.nowMs
  const acked = !silenced && i.ackedAtMs != null
  const claim = i.park !== undefined ? i.park : governingPark(i.manualPark ?? null, incidentPark(i.annotations ?? []), i.nowMs)
  const untilMs = claim ? Date.parse(claim.until) : null
  const parked = !silenced && !acked && claim !== null && parkHolds(claim, i.nowMs)
  const attention: Attention = silenced ? 'silenced' : acked ? 'acked' : parked ? 'parked' : 'none'
  // a park that has ended hands the incident back: the unattended clock starts when it ended, unless the incident began after that
  const sinceMs = untilMs !== null && untilMs <= i.nowMs ? Math.max(i.startsAtMs, untilMs) : i.startsAtMs
  const ageEnd = acked ? Math.min(i.ackedAtMs as number, i.nowMs) : i.nowMs
  const ageSec = parked ? 0 : Math.max(0, (ageEnd - sinceMs) / 1000)
  const band = ageBand(ageSec)
  const tier = tierOf(i.severity, attention)
  const factor = acked ? ACKED_FACTOR : AGE_FACTOR[band]
  const R = silenced || parked ? 1 : reach(i.instances) * factor
  return { tier, R, band, attention, firing: !parked, instances: i.instances, park: parked && claim ? claim : null, unattendedSinceMs: sinceMs }
}

/**
 * Seconds the incident has gone unattended at `nowMs`, for the pager (the next escalation step is due when this reaches its edge): none while silenced or
 * parked, frozen at the acknowledgement, and counted from `unattendedSinceMs` (the incident's start, or the end of the park it came back from).
 */
export function unattendedSecOf(state: Pick<IncidentState, 'attention' | 'unattendedSinceMs'>, ackedAtMs: number | null | undefined, nowMs: number): number {
  if (state.attention === 'silenced' || state.attention === 'parked') return 0
  const end = state.attention === 'acked' && ackedAtMs != null ? Math.min(ackedAtMs, nowMs) : nowMs
  return Math.max(0, (end - state.unattendedSinceMs) / 1000)
}

/** A quiet tile for a service that is healthy: R is how many rules sit behind it. */
export function quietWeight(rules: number): number {
  return Math.max(1, rules)
}
