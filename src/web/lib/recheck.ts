// The words of an on-demand re-check, written from the facts the server returns (src/shared/recheck.ts), in the reader's own clock.
// Every answer says what it found, never a bare spinner: "Still firing, checked just now", "Cleared at 14:52", "3 sources checked, 1 alert
// cleared". An alert whose sender pushes is told in two parts: a standing sentence (`scheduleText`: when the sender runs next, and when the
// alert clears on its own if it stops sending it) and, after a Re-check, where the request to the sender stands (`requestText`: asked, picked
// up, waiting, ran, could not, cannot, not picked up). No em dash, no middle dot.

import { RECHECK_GAP_SEC, RECHECK_REQUEST_TTL_SEC } from '../../shared/recheck.ts'
import type { AlertRecheck, AlertState, PushedRequest, PushedSender, RecheckSource, WallRecheck } from '../../shared/recheck.ts'
import type { SourceStatus } from '../../shared/types.ts'
import { agoDurationText, clockText, durationText, exactDurationText, stampText, unitText } from './format.ts'

/** An answer younger than this reads "just now". */
export const JUST_NOW_SEC = 5

/** What a re-check says: the finding, and under it one quieter sentence (why nothing new ran, who did not answer, when a pusher reports). */
export interface RecheckWords {
  line: string
  note: string | null
}

/** "just now" or "7 s ago", from an ISO time against a reference clock. */
export function checkedAgoText(iso: string | null, refMs: number): string {
  if (!iso) return 'not yet'
  const sec = (refMs - Date.parse(iso)) / 1000
  return sec < JUST_NOW_SEC ? 'just now' : agoDurationText(sec)
}

/** A time of day today, a date and time on any other day. */
export function whenText(iso: string, refMs: number): string {
  return new Date(iso).toDateString() === new Date(refMs).toDateString() ? clockText(iso) : stampText(iso)
}

/** A time ahead: a clock time today, "16:07 tomorrow" the next day, a date and time after that. */
export function whenAhead(iso: string, refMs: number): string {
  const day = new Date(iso).toDateString()
  if (day === new Date(refMs).toDateString()) return clockText(iso)
  const tomorrow = new Date(refMs)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return day === tomorrow.toDateString() ? `${clockText(iso)} tomorrow` : stampText(iso)
}

/** The clock the answer is read against: the later of the wall's own and the server's answer time. */
const reference = (nowMs: number, at: string): number => Math.max(nowMs, Date.parse(at))

const names = (ids: string[]): string => (ids.length <= 2 ? ids.join(' and ') : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`)

/** Sources that push rather than get polled: Watch can only listen for them. */
const PUSHING = new Set(['webhook', 'collector', 'self', 'zulip'])

/** "Checked 40 s ago": how old the oldest answer of a polled source is, the age an all clear is only as good as. Null when none has answered. */
export function freshnessText(sources: ReadonlyArray<Pick<SourceStatus, 'kind' | 'lastOk'>>, nowMs: number): string | null {
  const answered = sources.filter((s) => !PUSHING.has(s.kind) && s.lastOk).map((s) => Date.parse(s.lastOk as string))
  if (answered.length === 0) return null
  const oldest = Math.min(...answered)
  const sec = (nowMs - oldest) / 1000
  return `Checked ${sec < JUST_NOW_SEC ? 'just now' : agoDurationText(sec)}`
}

const gapText = `A source is polled again at most every ${unitText(RECHECK_GAP_SEC, 's')}.`

/** The oldest finish time among the sources that answered: an answer is only as fresh as the stalest source behind it. */
function oldestAnswer(sources: RecheckSource[]): string | null {
  const times = sources.filter((s) => s.ok && s.checkedAt).map((s) => s.checkedAt as string)
  return times.length === 0 ? null : times.reduce((a, b) => (a < b ? a : b))
}

/** What nothing new ran says, when every source that answered did so from a poll made before this click. */
function throttledNote(sources: RecheckSource[], refMs: number): string | null {
  const answered = sources.filter((s) => s.ok)
  if (answered.length === 0 || !answered.every((s) => s.throttled)) return null
  return `Last polled ${checkedAgoText(oldestAnswer(sources), refMs)}. ${gapText}`
}

const latest = (isos: ReadonlyArray<string | null | undefined>): string | null => isos.reduce<string | null>((a, b) => (b && (a === null || b > a) ? b : a), null)

/** The first words of a sender's note, with its closing full stop dropped so a sentence of ours can end it. */
const noteText = (note: string | null): string | null => {
  let t = (note ?? '').trim()
  while (t.endsWith('.')) t = t.slice(0, -1).trimEnd()
  return t === '' ? null : t
}

/**
 * The standing sentence for a sender that pushes the firing alerts it names (one alert, or several of one sender): when it runs next, or that it is
 * overdue, or when it last reported and how often it promised to, and when the alert clears on its own if it stops sending it. Read against `refMs`.
 */
export function scheduleText(ps: readonly PushedSender[], refMs: number): string {
  const p = ps[0]
  const many = ps.length > 1
  const last = latest(ps.map((x) => x.lastReportedAt))
  const clearsAt = latest(ps.map((x) => x.clearsAt))
  const next = p.nextReportAt ? Date.parse(p.nextReportAt) : null
  let head: string
  if (p.nextReportAt && next !== null && next > refMs) head = `${p.sender} runs next at ${whenAhead(p.nextReportAt, refMs)}, in ${exactDurationText((next - refMs) / 1000)}.`
  else if (p.nextReportAt) head = `${p.sender} was due to report at ${whenText(p.nextReportAt, refMs)} and has not yet.`
  else if (last) head = `${p.sender} last reported ${many ? 'them' : 'it'} at ${whenText(last, refMs)}${p.atLeastEverySec !== null ? ` and reports at least every ${durationText(p.atLeastEverySec)}` : ''}.`
  else head = `${p.sender} has not reported ${many ? 'them' : 'it'} yet.`
  let tail = ''
  if (clearsAt) tail = many ? ` If it stops sending these alerts, they clear on their own by ${whenAhead(clearsAt, refMs)}.` : ` If it stops sending this alert, it clears on its own at ${whenAhead(clearsAt, refMs)}.`
  else if (p.clearsAfterSec !== null) tail = ` An alert it stops sending clears after ${durationText(p.clearsAfterSec)}.`
  return `${head}${tail}`
}

/** The standing sentences of the incident sheet: one per pushing sender of the firing alerts in `alerts`, null when none of them is pushed. */
export function standingScheduleText(alerts: ReadonlyArray<{ resolvedAt: string | null; pushed?: PushedSender[] }>, refMs: number): string | null {
  const bySender = new Map<string, PushedSender[]>()
  for (const a of alerts) {
    if (a.resolvedAt) continue
    for (const p of a.pushed ?? []) bySender.set(p.source, [...(bySender.get(p.source) ?? []), p])
  }
  const lines = [...bySender.values()].map((ps) => scheduleText(ps, refMs))
  return lines.length === 0 ? null : lines.join(' ')
}

/** What it says about when a sender that cannot run on demand reports next, to end an answer with. */
function nextClause(p: PushedSender, refMs: number): string {
  const next = p.nextReportAt ? Date.parse(p.nextReportAt) : null
  if (p.nextReportAt && next !== null && next > refMs) return `It runs next at ${whenAhead(p.nextReportAt, refMs)}.`
  if (p.nextReportAt) return `It was due to report at ${whenText(p.nextReportAt, refMs)} and has not yet.`
  return p.atLeastEverySec !== null ? `It reports at least every ${durationText(p.atLeastEverySec)}.` : 'It reports when an alert changes.'
}

export type RequestPhase = 'none' | 'asked' | 'claimed' | 'dispatched' | 'ran' | 'failed' | 'unsupported' | 'expired' | 'lost'

/** Where one request stands: not made, asked and not yet picked up, picked up, waiting on something, answered, or timed out (never picked up, or picked up and never answered). */
export function requestPhase(r: PushedRequest | null | undefined): RequestPhase {
  if (!r || r.id === null) return 'none'
  if (r.doneAt !== null && r.outcome && r.outcome !== 'dispatched') return r.outcome
  if (r.expired) return r.claimedAt ? 'lost' : 'expired'
  if (r.outcome === 'dispatched') return 'dispatched'
  return r.claimedAt ? 'claimed' : 'asked'
}

/** Least advanced first: a sentence about several requests tells the one still moving. */
const PHASE_RANK: Record<RequestPhase, number> = { none: 9, asked: 0, claimed: 1, dispatched: 2, expired: 3, lost: 3, ran: 4, failed: 4, unsupported: 4 }

/**
 * Where the requests to one pushing sender stand, in a sentence: `items` are the alerts that sender was asked about, each with the alert's state now
 * (what "ran" says it found). One alert reads "it" and "this check"; several read "them" and a count. Null when none of them has a request.
 */
export function requestText(items: ReadonlyArray<{ p: PushedSender; state: AlertState }>, refMs: number): string | null {
  const asked = items.filter((i) => requestPhase(i.p.request) !== 'none')
  if (asked.length === 0) return null
  const s = asked[0].p.sender
  const many = asked.length > 1
  const phase = (i: { p: PushedSender }): RequestPhase => requestPhase(i.p.request)
  const open = asked.filter((i) => PHASE_RANK[phase(i)] < 4)
  const lead = open.length > 0 ? open.reduce((a, b) => (PHASE_RANK[phase(b)] < PHASE_RANK[phase(a)] ? b : a)) : (asked.find((i) => phase(i) === 'ran') ?? asked.find((i) => phase(i) === 'failed') ?? asked[0])
  const r = lead.p.request as PushedRequest
  const kind = phase(lead)
  const at = (iso: string | null): string => (iso ? whenText(iso, refMs) : 'just now')
  const note = noteText(r.note)
  switch (kind) {
    case 'asked':
      return `Asked ${s} to re-run ${many ? `${asked.length} checks` : 'this check'} at ${at(r.requestedAt)}. It picks requests up within ${exactDurationText(r.pickupWithinSec)}.`
    case 'claimed':
      return `${s} picked ${many ? 'them' : 'it'} up at ${at(r.claimedAt)} and is re-running ${many ? 'them' : 'it'}.`
    case 'dispatched':
      return note ? `${s} is waiting on ${note}.` : `${s} has started a run and is waiting on it.`
    case 'ran': {
      const ran = asked.filter((i) => phase(i) === 'ran')
      if (ran.length === 1) return `${s} re-ran it at ${at(r.doneAt)}: ${ran[0].state === 'resolved' ? 'cleared' : 'still firing'}.`
      const cleared = ran.filter((i) => i.state === 'resolved').length
      const found = cleared === ran.length ? 'all cleared' : cleared === 0 ? 'all still firing' : `${cleared} cleared, ${ran.length - cleared} still firing`
      return `${s} re-ran ${ran.length} checks at ${at(latest(ran.map((i) => i.p.request?.doneAt ?? null)))}: ${found}.`
    }
    case 'failed':
      return `${s} could not re-run ${many ? 'them' : 'it'}${note ? `: ${note}` : ''}.`
    case 'unsupported':
      return `${s} cannot re-run ${many ? 'these checks' : 'this check'} on demand. ${nextClause(lead.p, refMs)}`
    case 'lost':
      return r.outcome === 'dispatched' && note ? `${s} was waiting on ${note} and has not reported back.` : `${s} picked ${many ? 'them' : 'it'} up at ${at(r.claimedAt)} and has not reported back.`
    default:
      return `${s} did not pick the request${many ? 's' : ''} up within ${durationText(RECHECK_REQUEST_TTL_SEC)}.`
  }
}

/**
 * What a re-check says of a sender that pushes: where its request stands, and for a sender that takes none (a webhook), that it reports on its own.
 * The times of its schedule are the sheet's standing sentence, not repeated here.
 */
export function pushedText(p: PushedSender, refMs: number, state: AlertState = 'firing'): string {
  return requestText([{ p, state }], refMs) ?? `${p.sender} reports on its own and cannot be asked to re-run this check.`
}

/**
 * The overlay of what the sheet fetched since the press: each pusher's request as it stands now, and for an alert only a pusher reports, its state now.
 * A fetch that started before the press holds an older request than the answer does, so the answer's own stays until a fetch has caught up with it.
 */
export function withLiveAlert(r: AlertRecheck, live: { resolvedAt: string | null; pushed?: PushedSender[] } | undefined): AlertRecheck {
  if (!live) return r
  const pushed = r.pushed.map((mine) => {
    const now = live.pushed?.find((p) => p.source === mine.source)
    return now && (now.request?.requestedAt ?? '') >= (mine.request?.requestedAt ?? '') ? now : mine
  })
  if (r.sources.length > 0) return { ...r, pushed }
  return { ...r, pushed, after: live.resolvedAt ? 'resolved' : 'firing', resolvedAt: live.resolvedAt ?? r.resolvedAt }
}

/** One alert's answer: next to its status, "Still firing, checked just now" or "Cleared at 14:52", or for a pusher when it last reported. */
export function alertRecheckText(r: AlertRecheck, nowMs: number): RecheckWords {
  const ref = reference(nowMs, r.at)
  const cleared = r.before === 'firing' && r.after === 'resolved'
  const pushedNote = r.pushed.map((p) => pushedText(p, ref, r.after)).join(' ')
  const failed = r.sources.filter((s) => !s.ok)
  const answered = r.sources.filter((s) => s.ok)

  if (r.sources.length > 0) {
    if (answered.length === 0) {
      const first = failed[0]
      return { line: `Could not check, ${names(failed.map((s) => s.id))} did not answer${first.error ? `: ${first.error}` : ''}.`, note: 'The wall still shows the last answer it had.' }
    }
    let line: string
    if (cleared && r.resolvedAt) line = `Cleared at ${whenText(r.resolvedAt, ref)}`
    else if (r.after === 'firing' && r.before === 'resolved') line = `Firing again since ${whenText(r.startsAt, ref)}`
    else if (r.after === 'firing') line = `Still firing, checked ${checkedAgoText(oldestAnswer(r.sources), ref)}`
    else line = `Still clear, checked ${checkedAgoText(oldestAnswer(r.sources), ref)}`
    const notes = [
      failed.length > 0 ? `${names(failed.map((s) => s.id))} did not answer.` : '',
      r.clearsOnSweep && r.after === 'firing' ? 'The source answered, so this warning clears on the next sweep.' : '',
      throttledNote(r.sources, ref) ?? '',
      r.after === 'firing' ? pushedNote : ''
    ].filter(Boolean)
    return { line, note: notes.length > 0 ? notes.join(' ') : null }
  }

  if (r.pushed.length > 0) {
    // an alert that cleared after its sender re-ran the check says what the sender found, not only that it is gone
    const reran = r.pushed.some((p) => requestPhase(p.request) === 'ran')
    if (r.after === 'resolved' && !reran) return { line: `Not firing${r.resolvedAt ? `, resolved at ${whenText(r.resolvedAt, ref)}` : ''}`, note: null }
    return { line: pushedNote, note: null }
  }
  return { line: 'No source can be asked about this alert now.', note: null }
}

/** One incident's answer, from the answers for each of its alerts: one alert reads as that alert, several as a count. */
export function incidentRecheckText(rs: AlertRecheck[], nowMs: number): RecheckWords {
  if (rs.length === 0) return { line: '', note: null }
  if (rs.length === 1) return alertRecheckText(rs[0], nowMs)
  const ref = Math.max(...rs.map((r) => reference(nowMs, r.at)))
  const cleared = rs.filter((r) => r.before === 'firing' && r.after === 'resolved')
  const firing = rs.filter((r) => r.after === 'firing')
  const noun = (n: number): string => `${n} ${n === 1 ? 'alert' : 'alerts'}`
  const sources = rs.flatMap((r) => r.sources)
  const failed = [...new Set(sources.filter((s) => !s.ok).map((s) => s.id))]
  const answered = sources.filter((s) => s.ok)
  // the alerts only a pushing sender reports: its requests are the answer, and what it cannot be asked is a sentence of its own
  const pushedOnly = rs.filter((r) => r.sources.length === 0 && r.pushed.length > 0)
  const bySender = new Map<string, Array<{ p: PushedSender; state: AlertState }>>()
  for (const r of pushedOnly) for (const p of r.pushed) bySender.set(p.source, [...(bySender.get(p.source) ?? []), { p, state: r.after }])
  const requested = [...bySender.values()].map((items) => requestText(items, ref)).filter((t): t is string => t !== null)
  const unasked = pushedOnly.filter((r) => r.after === 'firing' && r.pushed.some((p) => requestPhase(p.request) === 'none'))
  const cannotAsk = (alerts: AlertRecheck[]): string => {
    const senders = [...new Set(alerts.flatMap((r) => r.pushed.filter((p) => requestPhase(p.request) === 'none').map((p) => p.sender)))]
    return `${names(senders)} ${senders.length === 1 ? 'reports on its own and cannot' : 'report on their own and cannot'} be asked to re-run ${alerts.length === 1 ? 'this check' : 'these checks'}.`
  }

  let line: string
  if (sources.length === 0 && requested.length > 0) line = requested.join(' ')
  else if (cleared.length === rs.length) line = `All ${rs.length} alerts cleared`
  else if (cleared.length > 0) line = `${cleared.length} of ${rs.length} alerts cleared, ${firing.length} still firing`
  else if (answered.length > 0) line = `${noun(firing.length)} still firing, checked ${checkedAgoText(oldestAnswer(answered), ref)}`
  else if (failed.length > 0) line = `Could not check, ${names(failed)} did not answer`
  else line = `${noun(firing.length)} still firing`
  const notes = [
    answered.length > 0 && failed.length > 0 ? `${names(failed)} did not answer.` : '',
    answered.length > 0 && answered.every((s) => s.throttled) ? `Last polled ${checkedAgoText(oldestAnswer(answered), ref)}. ${gapText}` : '',
    // a polled source answered beside the pushers: where their requests stand goes under it
    sources.length > 0 ? requested.join(' ') : '',
    unasked.length > 0 ? cannotAsk(unasked) : ''
  ].filter(Boolean)
  return { line, note: notes.length > 0 ? notes.join(' ') : null }
}

/**
 * What the wall's re-check says of the senders that push. It asks none of them: a sender that takes requests is asked from an alert's own Re-check, and
 * the rest report on their own schedule, so their alerts change when they report.
 */
function wallPushedNote(r: WallRecheck): string | null {
  const asks = new Set(r.requestable ?? [])
  const askable = r.pushed.filter((id) => asks.has(id))
  const rest = r.pushed.filter((id) => !asks.has(id))
  const own = (ids: string[]): string => (ids.length === 1 ? `${ids[0]} pushes on its own schedule` : `${names(ids)} push on their own schedule`)
  const notes = [
    rest.length > 0 ? `${own(rest)}, so ${rest.length === 1 ? 'its alerts change when it reports' : 'their alerts change when they report'}.` : '',
    askable.length > 0 ? `${own(askable)}. Re-check ${askable.length === 1 ? 'one of its alerts to ask it' : 'one of their alerts to ask them'} to run again.` : ''
  ].filter(Boolean)
  return notes.length > 0 ? notes.join(' ') : null
}

/** The whole wall's answer: "3 sources checked, 1 alert cleared". */
export function wallRecheckText(r: WallRecheck, nowMs: number): RecheckWords {
  const ref = reference(nowMs, r.at)
  if (r.sources.length === 0) return { line: 'No source is polled here.', note: wallPushedNote(r) }
  const answered = r.sources.filter((s) => s.ok)
  const failed = r.sources.filter((s) => !s.ok).map((s) => s.id)
  const sources = `${answered.length} ${answered.length === 1 ? 'source' : 'sources'} checked`
  const alerts = (n: number): string => `${n} ${n === 1 ? 'alert' : 'alerts'}`
  const finding =
    r.cleared > 0 ? `, ${alerts(r.cleared)} cleared` : r.stillFiring > 0 ? `, none cleared, ${r.stillFiring} still firing` : ', nothing firing'
  const line = answered.length === 0 ? `Could not check, ${names(failed)} did not answer` : `${sources}${finding}`
  const notes = [
    answered.length > 0 && failed.length > 0 ? `${names(failed)} did not answer.` : '',
    answered.length > 0 && answered.every((s) => s.throttled) ? `Last polled ${checkedAgoText(oldestAnswer(r.sources), ref)}. ${gapText}` : '',
    wallPushedNote(r) ?? ''
  ].filter(Boolean)
  return { line, note: notes.length > 0 ? notes.join(' ') : null }
}

/** Shown in place of an answer when the request itself did not get through. */
export const RECHECK_FAILED = 'Could not reach Watch to re-check. Try again.'
export const RECHECK_BUSY = 'Checking'
