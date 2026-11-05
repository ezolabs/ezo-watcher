// The wire shapes of an on-demand re-check (POST /api/recheck and POST /api/recheck/:alertKey), shared by the server that
// answers and the wall that words the answer. They carry facts and ISO times only: the words, in the reader's own clock, are
// written by src/web/lib/recheck.ts.

import type { SourceKind } from './types.ts'

/** A source is re-polled on demand at most once in this many seconds; a click inside the gap is answered from the last poll. */
export const RECHECK_GAP_SEC = 10

/** An open re-check request for a pushing sender expires this long after it was made, unanswered or not: the sender is not coming for it. */
export const RECHECK_REQUEST_TTL_SEC = 30 * 60

/** What a pushing sender tells Watch about a request it took: it ran the check, started one it waits on, could not, or cannot at all. */
export type RecheckOutcome = 'ran' | 'dispatched' | 'failed' | 'unsupported'
export const RECHECK_OUTCOMES: readonly RecheckOutcome[] = ['ran', 'dispatched', 'failed', 'unsupported']

/** Who made a request: the wall's own Re-check (the HTTP API) or an agent through the MCP `recheck` tool. */
export type RecheckVia = 'wall' | 'mcp'

/**
 * One request for a pushing sender to run an alert's check again, as the sender reads it from GET /ingest/<source>/recheck-requests
 * (docs/mcp.md, "Re-check"). The sender answers each one with POST /ingest/<source>/recheck-requests/<id>.
 */
export interface RecheckRequest {
  id: string
  /** The alert, `${origin}:${fp8}`. */
  alertKey: string
  /** The alert's full fingerprint: what the sender hashed its own finding key into. */
  fingerprint: string
  alertname: string
  labels: Record<string, string>
  /** ISO. */
  requestedAt: string
  /** The person or agent: the name the wall sent, "wall" when it named nobody, or an MCP caller's "agent: <who>". */
  requestedBy: string
  via: RecheckVia
  /** ISO, set on the first poll that returned the request; null until then. */
  claimedAt: string | null
}

/** What Watch holds of the latest request for one alert and one pushing source, so the sheet can say where it stands. */
export interface PushedRequest {
  /** The source's `recheckRequests.pickupWithinSec`: how soon the sender promised to look for requests. */
  pickupWithinSec: number
  /** Null when this alert has no request from the last 24 h. Every field below is then empty. */
  id: string | null
  requestedAt: string | null
  claimedAt: string | null
  /** ISO. Set once the sender closed it (ran, failed or unsupported). */
  doneAt: string | null
  /** Still open after RECHECK_REQUEST_TTL_SEC: nobody closed it, and the sender no longer sees it. */
  expired: boolean
  outcome: RecheckOutcome | null
  note: string | null
}

/** What one polled source did for a re-check. */
export interface RecheckSource {
  id: string
  kind: SourceKind
  /** The poll answered. False: it failed, and `error` says how (a message the poller already keeps clean of secrets). */
  ok: boolean
  error: string | null
  /** When that poll finished, ISO. Null only when the source has not been polled yet and this request did not poll it either. */
  checkedAt: string | null
  /** This request started a new poll. */
  ran: boolean
  /** This request joined a poll that was already running (a scheduled one or another click's). */
  shared: boolean
  /** Inside the gap: no poll ran, the answer is the last poll's. */
  throttled: boolean
}

/**
 * A sender that pushes and cannot be forced (a webhook, the regression sweep, the prober, the alert bridge). Watch can only say
 * when it last reported and what it promised, so the person knows when this can next change.
 */
export interface PushedSender {
  /** The source id in the config. */
  source: string
  /** Who to name: the system that raised the alert, with the source it came through when that differs ("prod through webhook"). */
  sender: string
  /** When this sender last reported the alert, ISO. */
  lastReportedAt: string | null
  /** The source's own promise: silence longer than this reads stale (`staleAfterSec`). Null when it made none. */
  atLeastEverySec: number | null
  /** An alert this sender stops repeating clears after this long (`presenceTtlSec`, else the 6 h default). */
  clearsAfterSec: number | null
  /** When the sender said it reports next (`nextReportAt` of its last push, per source), ISO. Null when it never said. May be in the past: it is overdue. */
  nextReportAt: string | null
  /** When this alert clears on its own if the sender stops sending it: `lastReportedAt` plus `clearsAfterSec`, ISO. Null without a last report. */
  clearsAt: string | null
  /** The latest re-check request for this alert; null when the source takes no requests (`recheckRequests` is not in the config). */
  request: PushedRequest | null
}

export interface WallRecheck {
  /** When Watch answered, ISO. */
  at: string
  sources: RecheckSource[]
  /** Alerts that were firing on one of these sources and are resolved now. */
  cleared: number
  /** Alerts a polled source still reports firing now. */
  stillFiring: number
  /** The sources that push: not re-polled, named so the line can say so. */
  pushed: string[]
  /** Of those, the ones that take re-check requests: an alert's Re-check asks them, the wall's does not. */
  requestable?: string[]
}

export type AlertState = 'firing' | 'resolved'

export interface AlertRecheck {
  key: string
  /** When Watch answered, ISO: the reference for "just now", so a wall clock a few seconds behind never makes a fresh answer read old. */
  at: string
  /** The alert's state when the request came in, and when it was answered. */
  before: AlertState
  after: AlertState
  startsAt: string
  resolvedAt: string | null
  /** The polled sources asked about this alert. */
  sources: RecheckSource[]
  /** The pushing senders of this alert. */
  pushed: PushedSender[]
  /** The alert is Watch's own source-stale warning: it clears on Watch's next sweep after the named source answers. */
  clearsOnSweep: boolean
  /** The alert's own sentence about itself, so the answer can name it. */
  rule: string
}
