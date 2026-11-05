// What an event of an incident says, in words: the MCP server's history and the incident sheet read the same sentence. Pure.

import { isAgentName, resolutionText } from './agent.ts'
import type { AlertEvent } from './types.ts'
import { byPhrase, shownName } from './who.ts'

export interface EventLine {
  at: string
  kind: string
  by?: string
  /** True when `by` is an agent ("agent: <who>"). */
  agent?: boolean
  text: string
}

/** The kinds whose sentence names who did it and why; every other kind keeps the sheet's own wording. */
const SAYS_WHO = new Set(['ack', 'unack', 'silence', 'park', 'unpark', 'reopened', 'confirmed'])

type Detail = {
  by?: unknown
  note?: unknown
  reason?: unknown
  minutes?: unknown
  manual?: unknown
  origin?: unknown
  state?: unknown
  until?: unknown
  ref?: unknown
  wasUntil?: unknown
  ended?: unknown
  parkedBy?: unknown
  alert?: unknown
}

/** How a time inside a sentence is told. The MCP server and the history API tell it in UTC (one sentence for every reader's zone); the wall passes its own, so a sheet reads every time in the viewer's zone. */
export interface EventTextOptions {
  stamp?: (iso: string) => string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Why a park was set, in the words of a sentence ("fix not deployed"); an unknown state is left out. */
const PARK_WHY: Record<string, string> = { deferred: 'deferred', fixed_undeployed: 'fix not deployed', awaiting_source: 'fix live, awaiting source' }

/** "Oct 17, 04:00 UTC": a time in a History sentence, in UTC because the sentence is the same for the MCP server and for every reader's zone. '' for anything that is not an ISO time. */
export function utcStamp(iso: unknown): string {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

/** The alert that joined a parked incident, as the sentence names it: "DiskFull on node-5", "DiskFull" when it names no host, '' when the event kept none. */
function joinedAlertName(v: unknown): string {
  if (typeof v !== 'object' || v === null) return ''
  const a = v as { rule?: unknown; host?: unknown }
  const rule = typeof a.rule === 'string' ? a.rule : ''
  const host = typeof a.host === 'string' ? a.host : ''
  return rule !== '' && host !== '' ? `${rule} on ${host}` : rule !== '' ? rule : host
}

/** One event as a line of history. `opts.stamp` tells the times inside the sentence (a park's end); the default is UTC. */
export function eventLine(e: AlertEvent, opts: EventTextOptions = {}): EventLine {
  const stamp = opts.stamp ?? utcStamp
  const d = e.detail as Detail
  const by = typeof d.by === 'string' ? d.by : undefined
  const note = typeof d.note === 'string' && d.note !== '' ? d.note : typeof d.reason === 'string' && d.reason !== '' ? d.reason : undefined
  const who = shownName(by)
  const phrase = byPhrase(by)
  let text: string
  switch (e.kind) {
    case 'ack':
      text = `Acknowledged${phrase}${note ? `. Note: ${note}` : ''}`
      break
    case 'unack':
      text = `Acknowledgement removed${phrase}${note ? `. Note: ${note}` : ''}`
      break
    case 'silence':
      text = `Silenced${phrase}${typeof d.minutes === 'number' ? ` for ${d.minutes} min` : ''}${note ? `. Reason: ${note}` : ''}`
      break
    case 'park': {
      // "Parked by agent: claude until Oct 17, 04:00 UTC (fix live, awaiting source), SB-4412. Note: <why>": who, until when, the state and the ticket, then the note
      const until = typeof d.until === 'string' && !Number.isNaN(Date.parse(d.until)) ? stamp(d.until) : ''
      const why = typeof d.state === 'string' ? PARK_WHY[d.state] : undefined
      const detail = [why, typeof d.ref === 'string' && d.ref !== '' ? d.ref : undefined].filter(Boolean).join(', ')
      text = `Parked${phrase}${until ? ` until ${until}` : ''}${detail ? ` (${detail})` : ''}${note ? `. Note: ${note}` : ''}`
      break
    }
    case 'unpark': {
      if (d.ended === 'joined') {
        // the engine ended it, not a person: "Park by agent: claude ended. A new alert joined the incident (DiskFull on node-5)", the actor is whoever set the park
        const joined = joinedAlertName(d.alert)
        text = `Park${byPhrase(typeof d.parkedBy === 'string' ? d.parkedBy : undefined)} ended. A new alert joined the incident${joined ? ` (${joined})` : ''}`
        break
      }
      text = `Unparked${phrase}${note ? `. Note: ${note}` : ''}`
      break
    }
    case 'resolved':
      text = d.manual === true ? resolutionText('resolved-manual', who, note) : `Resolved${typeof d.origin === 'string' ? ` (${d.origin})` : ''}`
      break
    case 'reopened':
      text = resolutionText('reopened', who, undefined)
      break
    case 'confirmed':
      text = resolutionText('confirmed', who, note)
      break
    case 'fired':
      text = e.alertKey === null ? 'Fired' : `Alert fired${typeof d.origin === 'string' ? ` (${d.origin})` : ''}`
      break
    default:
      text = e.kind
  }
  return { at: e.at, kind: e.kind, ...(by !== undefined ? { by, agent: isAgentName(by) } : {}), text }
}

/**
 * The `reopened` event that started the incident's current episode, or null: the latest incident-level `fired` event, and a `reopened` event
 * written in the same instant (the engine records both together when a source still reports an alert someone marked resolved).
 */
export function reopenedOf(events: readonly AlertEvent[]): AlertEvent | null {
  let fired: AlertEvent | null = null
  for (const e of events) {
    if (e.kind === 'fired' && e.alertKey === null && (e.detail as { imported?: unknown }).imported === undefined && (fired === null || e.id > fired.id)) fired = e
  }
  if (!fired) return null
  return events.find((e) => e.kind === 'reopened' && e.at === fired.at) ?? null
}

/** Why the incident's current silence was set: the reason of its latest incident-level `silence` event, or null when it gave none. */
export function silenceReasonOf(events: readonly AlertEvent[]): string | null {
  let latest: AlertEvent | null = null
  for (const e of events) if (e.kind === 'silence' && e.alertKey === null && (latest === null || e.id > latest.id)) latest = e
  const reason = (latest?.detail as { reason?: unknown } | undefined)?.reason
  return typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null
}

/**
 * The sentence the sheet's History shows for an event that says who did it and why (an acknowledgement, a silence, a manual resolve, a reopen,
 * a confirmation), or null for one the sheet words itself (fired, an alert's own resolve, a notification).
 */
export function eventSaying(e: AlertEvent, opts: EventTextOptions = {}): string | null {
  const manual = e.kind === 'resolved' && (e.detail as Detail).manual === true
  return SAYS_WHO.has(e.kind) || manual ? eventLine(e, opts).text : null
}
