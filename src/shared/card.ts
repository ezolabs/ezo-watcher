// The incident card: the small answer the chat panel unfurls under a message that links to an incident (GET /api/incident-card/:ref, docs/embed.md),
// and the reference message the embed posts to the panel that frames it. One pure shaper, read by the route and by its test, so the wire
// shape is spelled once. It names what a card needs (what broke, how bad, where it stands, since when, who has it, where it lives) and
// nothing else: no label, no annotation, no description, no host, no source link, no value. The title is the headline the wall's own tile
// shows, which is already public to anyone who can open the link.

import { rankOf, worstFirst } from './evidence-links.ts'
import { tileStory } from './story.ts'
import type { Alert, HistoryRow, Incident, Severity } from './types.ts'
import { shownName } from './who.ts'

/** `parked` is an open triage verdict that is not due yet (`parkedUntil` says when it ends). The chat app's card allow-list has named it since 71a993e5 (`ezo-watcher-panel.js` `takeCard`). */
export type CardState = 'firing' | 'acknowledged' | 'silenced' | 'parked' | 'resolved'

export interface IncidentCard {
  /** The shape's version, so the chat panel can ignore a newer one it does not know. */
  v: 1
  /** The incident key, as the wall names it. */
  key: string
  /** What broke, the headline of the wall's tile. */
  title: string
  severity: Severity
  state: CardState
  service: string
  /** ISO time the incident began. */
  since: string
  /** Who acknowledged it, when someone with a name did (state `acknowledged`). */
  ackedBy?: string
  /** ISO time the park ends (state `parked`): the card says when it comes back, never why. */
  parkedUntil?: string
  /** The incident's own link on the wall: `<base>/#/i/<encoded key>`. */
  url: string
}

/** The fields of a card, in the order they are written: the test pins the response to exactly these. */
export const CARD_FIELDS = ['v', 'key', 'title', 'severity', 'state', 'service', 'since', 'ackedBy', 'parkedUntil', 'url'] as const

/** The message the embed view posts to the page that frames it when a person presses "Reference in chat". */
export const REFERENCE_MESSAGE = 'ezo-watcher:reference'
export interface ReferenceMessage {
  type: typeof REFERENCE_MESSAGE
  key: string
  url: string
  title: string
}

/** The drag types an incident tile or sheet sets: the link, and the title with the link after it for a plain-text target. */
export const DRAG_URI = 'text/uri-list'
export const DRAG_TEXT = 'text/plain'

/** An alert key as `alertKey()` writes it: the origin (a source id), a colon and 8 hex digits. A ref of this shape names an alert; any other ref is an incident key. */
export const ALERT_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:[0-9A-Fa-f]{8}$/

/** The longest title a card carries: a headline is a sentence, not a log line. */
export const CARD_TITLE_MAX = 200

export function incidentLink(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/#/i/${encodeURIComponent(key)}`
}

/** What the drag of an incident sets: the link as a uri-list, and "<title> <link>" as plain text (a target that takes text gets both the words and the link). */
export function dragText(title: string, url: string): { uri: string; text: string } {
  return { uri: url, text: `${title.replace(/\s+/g, ' ').trim()} ${url}`.trim() }
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= CARD_TITLE_MAX ? t : `${t.slice(0, CARD_TITLE_MAX - 1).trimEnd()}…`
}

export interface CardSource {
  key: string
  /** The incident while it fires (acknowledged and silenced ones included); null once it has cleared. */
  incident: Incident | null
  /** Every alert row stored for the incident, firing or cleared. */
  alerts: Alert[]
  /** The last episode that resolved, when the incident is not firing. */
  resolved: HistoryRow | null
  baseUrl: string
}

/** The card of one incident, or null when Watch has never heard of it (no firing incident, no alert row, no resolved episode). */
export function cardOf(src: CardSource): IncidentCard | null {
  const { incident, alerts, resolved } = src
  if (!incident && alerts.length === 0 && !resolved) return null
  const ordered = worstFirst(incident ? incident.alerts : alerts, rankOf)
  const rule = incident?.rule ?? resolved?.rule ?? ordered[0]?.rule ?? ''
  const instance = incident ? incident.instance : (resolved?.instance ?? null)
  const headline = ordered.length > 0 ? tileStory(ordered, { rule, instance }).headline : `${resolved?.service ?? ''}: ${rule}`
  const severity: Severity = incident?.severity ?? resolved?.severity ?? ordered[0]?.severity ?? 'info'
  const service = incident?.service ?? resolved?.service ?? ordered[0]?.service ?? ''
  const since = incident?.startsAt ?? resolved?.startsAt ?? ordered.map((a) => a.startsAt).sort()[0] ?? ''
  const attention = incident?.state.attention
  const state: CardState = !incident ? 'resolved' : attention === 'acked' ? 'acknowledged' : attention === 'silenced' ? 'silenced' : attention === 'parked' ? 'parked' : 'firing'
  const by = state === 'acknowledged' ? shownName(incident?.ackedBy) : null
  const parkedUntil = state === 'parked' ? (incident?.state.park?.until ?? null) : null
  return {
    v: 1,
    key: src.key,
    title: clip(headline) || src.key,
    severity,
    state,
    service,
    since,
    ...(by !== null ? { ackedBy: by } : {}),
    ...(parkedUntil !== null ? { parkedUntil } : {}),
    url: incidentLink(src.baseUrl, src.key)
  }
}
