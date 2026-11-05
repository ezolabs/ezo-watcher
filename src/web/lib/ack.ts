// How an acknowledgement reads on the wall. The tile says it in one line, the big number tells the truth about what it counts, and the
// status line counts the acknowledged beside the firing. Pure functions of the incident, so a tile and a sheet never disagree.
// A park reads the same way (`parkedParts`, `parkedDetail`): when it ends, why, the ticket and the sender's line, and when it began.

import { byPhrase, shownName } from '../../shared/who.ts'
import type { Attention, Incident, Park, ParkedState, WallHeader } from '../../shared/types.ts'
import { clockText, durationText, parkStampText } from './format.ts'

/** A sentence told in two parts, so a tile can put each on its own line and the time is never the part an ellipsis cuts. */
export interface Told {
  who: string
  when: string
}

export const toldLine = (t: Told): string => (t.when === '' ? t.who : `${t.who} ${t.when}`)

/** "Acknowledged by the user" and "at 14:45"; with no stored name, "Acknowledged" and "at 14:45". */
export function ackedParts(by: string | null | undefined, at: string | null | undefined): Told {
  return { who: `Acknowledged${byPhrase(by)}`, when: at ? `at ${clockText(at)}` : '' }
}

/** "Acknowledged by the user at 14:45" ("Acknowledged at 14:45" with no stored name): the chip in the sheet, the tile's title and its accessible name. */
export function ackedLine(by: string | null | undefined, at: string | null | undefined): string {
  return toldLine(ackedParts(by, at))
}

/**
 * The one line that says a silence: who set it and until when. A silence is time-boxed, so one set on the previous episode of a re-fired
 * incident stays until it runs out; the line then says it was set before this episode, so nobody reads it as chosen for this problem.
 * `by` is null for a silence only the source holds (Alertmanager's own).
 */
export function silencedLine(by: string | null | undefined, until: string | null | undefined, carried: boolean): string {
  return toldLine(silencedParts(by, until, carried, true))
}

/**
 * A silence told in two parts: who, then "until 15:40", and when it was set before this episode ", carried over" on a tile (which has little
 * room) or ", set before this episode" in the sheet (`whole`).
 */
export function silencedParts(by: string | null | undefined, until: string | null | undefined, carried: boolean, whole = false): Told {
  if (!until) return { who: 'Silenced at the source', when: '' }
  return { who: `Silenced${byPhrase(by)}`, when: `until ${clockText(until)}${carried ? (whole ? ', set before this episode' : ', carried over') : ''}` }
}

export const isAcked = (i: Pick<Incident, 'state'>): boolean => i.state.attention === 'acked'

/** Why an incident is parked, in the words a tile and a sheet use (the `parked_state` values). */
export const PARK_REASON: Record<ParkedState, string> = { deferred: 'deferred', fixed_undeployed: 'fix not deployed', awaiting_source: 'fix live, awaiting source' }

const sentenceCase = (t: string): string => `${t.charAt(0).toUpperCase()}${t.slice(1)}`
const sentence = (t: string): string => (/[.!?]$/.test(t) ? t : `${t}.`)

/**
 * A park told in two parts, like a silence, so a tile can put each on its own line: "Parked until Oct 17, 09:00", then why and the ticket, "Fix not deployed,
 * SB-4412". A park set by hand names who set it, as an acknowledgement does ("Parked until Oct 17, 09:00 by agent: claude"; a stored actor that names nobody leaves it
 * out). The sender's one line and when the park began are in `parkedDetail`, for the sheet and a tile's hover.
 */
export function parkedParts(park: Park): Told {
  return { who: `Parked until ${parkStampText(park.until)}${byPhrase(park.by)}`, when: `${sentenceCase(PARK_REASON[park.state])}${park.ref ? `, ${park.ref}` : ''}` }
}

/** The one line a tile's title and accessible name say: when the park ends and why ("Parked until Oct 17, 09:00. Fix not deployed, SB-4412"). */
export const parkedLine = (park: Park): string => toldLine({ who: `${parkedParts(park).who}.`, when: parkedParts(park).when })

/** The park in full, for the sheet: the reason, the ticket, the sender's line, when it began and what happens when it ends. */
export function parkedDetail(park: Park): string {
  const parts = [`Reason: ${PARK_REASON[park.state]}`]
  if (park.ref) parts.push(`Ticket ${park.ref}`)
  if (park.note) parts.push(park.note.replace(/[.!?]+$/, ''))
  if (park.since) parts.push(`Parked since ${parkStampText(park.since)}${byPhrase(park.by)}`)
  else if (shownName(park.by) !== null) parts.push(`Parked${byPhrase(park.by)}`)
  parts.push('It is not paged while it is parked, and comes back unattended when the park ends')
  return parts.map(sentence).join(' ')
}

/** Seconds the incident has gone unattended: it stops counting at the acknowledgement (the age band's own rule), and starts at the end of a park it came back from. */
export function unattendedSeconds(i: Pick<Incident, 'state' | 'startsAt' | 'ackedAt'>, nowMs: number): number {
  const end = i.state.attention === 'acked' && i.ackedAt ? Math.min(Date.parse(i.ackedAt), nowMs) : nowMs
  return Math.max(0, (end - i.state.unattendedSinceMs) / 1000)
}

/**
 * The big number of a large tile and what it counts. Unattended: how long nobody has had it. Acknowledged: how long ago someone took it,
 * not the time it took to be taken (the old "5 h until acknowledged" read as a clock still running). How long it has been firing stays in the
 * caption. Silenced keeps its own word.
 */
export function heroOf(i: Pick<Incident, 'state' | 'startsAt' | 'ackedAt'>, nowMs: number): { value: string; label: string } {
  // a parked incident has no unattended time: the figure is how long the park has left
  if (i.state.park) return { value: durationText(Math.max(0, (Date.parse(i.state.park.until) - nowMs) / 1000)), label: 'until the park ends' }
  if (i.state.attention === 'acked') {
    if (i.ackedAt) return { value: durationText(Math.max(0, (nowMs - Date.parse(i.ackedAt)) / 1000)), label: 'since acknowledged' }
    return { value: durationText(unattendedSeconds(i, nowMs)), label: 'until acknowledged' }
  }
  return { value: durationText(unattendedSeconds(i, nowMs)), label: i.state.attention === 'silenced' ? 'silenced' : 'unattended' }
}

/** The status line's counts: "6 firing, 1 acknowledged, 2 parked". The second and third are left out at zero. A server that predates a count sends none. */
export function statusCounts(h: Pick<WallHeader, 'firing'> & { acknowledged?: number; parked?: number }): { firing: string; acknowledged: string | null; parked?: string } {
  const n = h.acknowledged ?? 0
  const p = h.parked ?? 0
  return { firing: `${h.firing} firing`, acknowledged: n > 0 ? `${n} acknowledged` : null, ...(p > 0 ? { parked: `${p} parked` } : {}) }
}

/** The tile's accessible name and sort: an acknowledged tile follows the unattended ones of its severity. */
export const attendedRank = (attention: Attention): number => (attention === 'acked' ? 1 : 0)
