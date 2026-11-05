// What an agent that writes to Watch through the MCP server may say, and how it reads. Pure: the server tools, the Chat lines and the sheet share it.
//
// Every write names its author (`by`). A person on the wall gives a name once; an agent says "agent: <who>". The prefix is added when the caller left it
// off, so a write by an agent can never read as a person's, and the tile, the sheet, History and the operator log all show the same text.

import { PARK_MAX_HOURS, PARK_MAX_MS, zonedMs } from './incident.ts'
import type { ParkedState } from './types.ts'
import { NAME_MAX, cleanName } from './who.ts'

/** A comment is markdown of at most this many characters. */
export const COMMENT_MAX = 4000
/** A reason (silence, manual resolve) or a note (acknowledge, unacknowledge, confirm) is a sentence or two, not a report: the report is a comment. */
export const REASON_MAX = 500
/** An agent may silence an incident for at most this long. A silence hides an incident from the pager, so it is a short pause, never a way to live with a problem. */
export const SILENCE_MAX_MINUTES = 240

/** The states a park set by hand may say. `awaiting_source`: the fix is live and the source's evaluation window has not caught up, so it still reports the alert. */
export const PARK_STATES = ['fixed_undeployed', 'deferred', 'awaiting_source'] as const satisfies readonly ParkedState[]
/** A park's note says why: it is the sentence on the tile's proof line and the sheet, the same size as a silence's reason. */
export const PARK_NOTE_MAX = REASON_MAX
/** A park's ticket or commit reference (`ref`), one line. */
export const PARK_REF_MAX = 64

const PREFIX = 'agent:'
const SHORTEST_WHO = 1

/**
 * The author of an agent write, "agent: <who>", at most NAME_MAX characters. `null` when the caller named nobody, so the tool can refuse
 * the call: attribution is required, never guessed. "claude" and "Agent:claude" and "agent:   claude" all read "agent: claude".
 */
export function agentName(raw: unknown): string | null {
  const clean = cleanName(raw)
  const who = (clean.toLowerCase().startsWith(PREFIX) ? clean.slice(PREFIX.length) : clean).trim()
  if ([...who].length < SHORTEST_WHO) return null
  const room = NAME_MAX - PREFIX.length - 1
  return `${PREFIX} ${[...who].slice(0, room).join('').trim()}`
}

/** True for a name this module wrote: the sheet and the History row mark such a write as an agent's. */
export function isAgentName(by: string | null | undefined): boolean {
  return typeof by === 'string' && by.toLowerCase().startsWith(PREFIX)
}

/**
 * Free text from an agent: control characters out (newline and tab stay), line ends folded to \n, trimmed. '' for anything that is not text.
 * It is NOT cut: a caller that gives more than the limit is told so, never silently shortened.
 */
export function cleanText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return (
    raw
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
  )
}

export type TextCheck = { ok: true; text: string } | { ok: false; error: string }

/** A required text of at most `max` characters, counted by character and not by UTF-16 unit. */
export function checkText(raw: unknown, what: string, max: number): TextCheck {
  const text = cleanText(raw)
  if (text === '') return { ok: false, error: `${what} is required and may not be empty` }
  const length = [...text].length
  if (length > max) return { ok: false, error: `${what} is ${length} characters; the most is ${max}` }
  return { ok: true, text }
}

/** An optional text: absent or blank is fine and reads as no text. */
export function checkOptionalText(raw: unknown, what: string, max: number): TextCheck {
  if (raw === undefined || raw === null || (typeof raw === 'string' && cleanText(raw) === '')) return { ok: true, text: '' }
  return checkText(raw, what, max)
}

export type SilenceCheck = { ok: true; minutes: number } | { ok: false; error: string }

/** A silence of a whole number of minutes, 1 to SILENCE_MAX_MINUTES. More is refused, not clamped: the agent must know it did not get what it asked for. */
export function checkSilenceMinutes(raw: unknown): SilenceCheck {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return { ok: false, error: 'minutes must be a whole number of at least 1' }
  if (raw > SILENCE_MAX_MINUTES) {
    return { ok: false, error: `an agent may silence for at most ${SILENCE_MAX_MINUTES} minutes (4 hours); ${raw} was asked. Acknowledge the incident while you work it instead, and silence again later if it is still needed` }
  }
  return { ok: true, minutes: raw }
}

export type ParkCheck = { ok: true; state: ParkedState; until: string; note: string; ref: string } | { ok: false; error: string }

/**
 * A park set by hand (POST /api/incidents/:key/park, the MCP `park` tool), checked the way the silence is: `state` one of PARK_STATES, `until` an ISO 8601 time with a
 * zone that is after `nowMs` and at most PARK_MAX_HOURS after it (more is refused, not shortened, and the answer names the latest time that is taken), `note` required
 * (at most PARK_NOTE_MAX characters), `ref` optional (one line, at most PARK_REF_MAX). `until` comes back as ISO UTC and `ref` as '' when none was given.
 */
export function checkPark(raw: { state?: unknown; until?: unknown; note?: unknown; ref?: unknown }, nowMs: number): ParkCheck {
  const asked = typeof raw.state === 'string' ? raw.state.trim().toLowerCase() : ''
  const state = PARK_STATES.find((s) => s === asked)
  if (state === undefined) return { ok: false, error: `state must be one of ${PARK_STATES.join(', ')}: fixed_undeployed (the fix is merged and not live yet), awaiting_source (the fix is live and the source has not caught up), deferred (a person chose a later date)` }
  const now = new Date(nowMs).toISOString()
  const untilMs = typeof raw.until === 'string' ? zonedMs(raw.until) : null
  if (untilMs === null) {
    const example = new Date(nowMs + 24 * 3_600_000).toISOString()
    return { ok: false, error: `until must be an ISO 8601 time with a zone (Z or an offset), for example ${example}; it is ${now} now` }
  }
  const until = new Date(untilMs).toISOString()
  if (untilMs <= nowMs) return { ok: false, error: `until must be after now (${now}); ${until} has already passed` }
  if (untilMs - nowMs > PARK_MAX_MS) {
    const hours = Math.round(((untilMs - nowMs) / 3_600_000) * 10) / 10
    return {
      ok: false,
      error: `an agent may park for at most ${PARK_MAX_HOURS} hours; ${until} is ${hours} hours out and was refused, not shortened. The latest time it takes is ${new Date(nowMs + PARK_MAX_MS).toISOString()}. Park for the shortest time that covers the fix, and look at the incident again when it ends`
    }
  }
  const note = checkText(raw.note, 'note', PARK_NOTE_MAX)
  if (!note.ok) return note
  const ref = checkOptionalText(raw.ref, 'ref', PARK_REF_MAX)
  if (!ref.ok) return ref
  return { ok: true, state, until, note: note.text, ref: ref.text.replace(/\s+/g, ' ') }
}

// ---- the lines a thread and a sheet say ----------------------------------------------------------------------------------------------------

/** The marks are escapes, like the Chat channel's: the UI gate reads an emoji that opens a string as a list bullet. */
const MARK = { comment: '\u{1F4AC}', resolved: '\u2705', reopened: '\u{1F534}', confirmed: '\u2705' } as const

/** One line of free text, quoted: every line of it behind `> ` so Chat renders it as a block quote and an agent cannot start a heading or a list of its own. */
function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => `> ${l.trim()}`)
    .filter((l) => l !== '>')
    .join('\n')
}

/** A character-safe cut: at most `max` characters with an ellipsis when something was cut. */
function cutTo(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 3).join('')}...`
}

export type NoteKind = 'comment' | 'resolved' | 'reopened' | 'confirmed'

/** The Chat post for one of Watch's own notes. At most `max` characters (Chat refuses over 4000); the full text stays in Watch. */
export function noteLine(kind: NoteKind, by: string, text: string, max = 3900): string {
  const who = `\`${by.replace(/[`*[\]]/g, '')}\``
  let head: string
  switch (kind) {
    case 'comment':
      head = `${MARK.comment} **Comment** from ${who}`
      break
    case 'resolved':
      head = `${MARK.resolved} **Marked resolved** by ${who}. The source has not said so: if it still reports the alert, Watch reopens it.`
      break
    case 'reopened':
      head = `${MARK.reopened} **Reopened**, the source still reports it firing after the manual resolve by ${who}.`
      break
    case 'confirmed':
      head = `${MARK.confirmed} **Resolution confirmed** by ${who}`
      break
  }
  const body = text.trim() === '' ? '' : `\n${quote(text)}`
  return cutTo(`${head}${body}`, max)
}

/**
 * What History and the sheet say of a manual resolve, a reopen and a confirmation, in the words the API also carries. `by` is the name to
 * show (`shownName`): null names nobody and the sentence leaves the actor out.
 */
export function resolutionText(kind: 'resolved-manual' | 'reopened' | 'confirmed', by: string | null, extra: string | undefined): string {
  const who = by === null ? '' : ` by ${by}`
  switch (kind) {
    case 'resolved-manual':
      return `Marked resolved${who}${extra ? `. Reason: ${extra}` : ''}`
    case 'reopened':
      return `Reopened: source still firing after manual resolve${who}`
    case 'confirmed':
      return `Resolution confirmed${who}${extra ? `. Note: ${extra}` : ''}`
  }
}
