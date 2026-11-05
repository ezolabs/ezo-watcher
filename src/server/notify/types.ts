// Notification contracts. The notifier is a pure decision function plus an executor; channels are small
// functions with an injected fetch so every one is unit-testable without a network.

import type { AlertLinks, Attention, Severity } from '../../shared/types.ts'

export type MessageKind = 'alert' | 'escalation' | 'resolved' | 'digest' | 'flapping' | 'summary' | 'test'

/** What a channel is asked to deliver. Channels render it their own way (ntfy headers, SMS text, HTML mail). */
export interface Message {
  kind: MessageKind
  /** Short headline, for example "Page: API edge dead". Plain text. */
  title: string
  /** A few lines of plain text. */
  body: string
  severity: Severity
  /** Stable per incident: repeats replace the previous one on channels that support a tag or id. */
  tag: string
  /** Deep link into the wall for this incident. */
  url: string
  /** The incident's service and rule, for a channel that names them in its headline (Chat). Absent on a test and a digest. */
  service?: string
  rule?: string
  /**
   * An opaque link to the same incident (`/go/<token>`, an HMAC of its key) for a channel that publishes on a server we do
   * not run: `url` carries the incident key, which reads "service|rule|instance". Absent for messages with no incident.
   */
  noticeUrl?: string
  /** One-tap acknowledge URL (HMAC-signed), when the channel can carry an action. */
  ackUrl?: string
  /** Reference links worth showing on channels that can carry them. */
  links?: AlertLinks
  /** The incident behind a firing message, for the channel that renders a table of instances (email). */
  incident?: MessageIncident
  /** Seconds the incident was firing, on a resolved notice. */
  durationSec?: number
  /** Who had the incident acknowledged when it resolved, and when (ISO), on a resolved notice. Absent when nobody did. */
  ackedBy?: string
  ackedAt?: string
}

/** What an instance table needs, worst instance first. */
export interface MessageIncident {
  service: string
  rule: string
  /** ISO. First time any instance of the current severity started firing. */
  startsAt: string
  unattendedSec: number
  instances: InstanceView[]
}

export interface SendResult {
  ok: boolean
  /** "200", "202", "410 gone", "timeout", "no subscribers". Never a credential. */
  status: string
  latencyMs: number
  /** Short human detail for the log, with secrets already removed. */
  detail?: string
  /** How long the server asked us to wait (Retry-After on a 429), when it said. */
  retryAfterMs?: number
  /**
   * Epoch ms the target's circuit is open until: set when the call was skipped because it was open (the status then reads "skipped: circuit
   * open until ..."), and when this very call opened it (a 429 or a timeout), so the retry waits for it instead of backing off into a skip.
   */
  circuitUntil?: number
}

export interface Channel {
  id: string
  type: string
  send(msg: Message, signal?: AbortSignal): Promise<SendResult>
}

export interface LogRow {
  /** `${incidentKey}|${routeId}|${receiverId}|${stage}` where stage is "alert", "esc0", "esc1", "digest", "flap". */
  key: string
  sentAt: number
  /** sha256 of the sorted firing fingerprints at send time. */
  digest: string
  ok: boolean
  attempts: number
  nextAttemptAt: number | null
  /** When the send that is being retried first failed (epoch ms); the retry cap by age counts from it. Absent on a delivered row and on a row from before it existed. */
  firstFailedAt?: number
  /**
   * Why this row will not be retried, in the words its result row carries: "abandoned: max attempts", "abandoned: incident resolved",
   * "coalesced into <summary id>". Absent while the send is owed or delivered. A closed row is settled: it is not retried, and the repeat
   * gate counts from it like from a send.
   */
  closed?: string
}

export interface ResultRow {
  at: number
  incidentKey: string
  routeId: string
  channelId: string
  kind: MessageKind
  ok: boolean
  status: string
  latencyMs: number
}

/** The notification log (Alertmanager nflog) and result log, backed by SQLite in the app and a Map in tests. */
export interface NotifyStore {
  getLog(key: string): LogRow | null
  putLog(row: LogRow): void
  /** Rows still waiting on a retry: failed at least once and not closed. Absent in a store that cannot list, which leaves orphaned retries to the caps. */
  listPending?(): LogRow[]
  addResult(row: ResultRow): void
  /** Quiet-hours bookkeeping: incidents whose notification was held, by route id. */
  getHeld(routeId: string): string[]
  putHeld(routeId: string, incidentKeys: string[]): void
}

export interface InstanceView {
  fingerprint: string
  /** Host or instance name; the summary, then the alertname, when the alert carries nothing that names it. */
  name: string
  /** Where `name` came from (src/shared/evidence-links.ts), so a table can leave out a name that only repeats the title. */
  nameSource?: 'host' | 'instance' | 'service' | 'workload' | 'summary' | 'rule'
  value?: string
  startsAt: string
  /** The instance's own severity: one host of an incident can page while the others warn. */
  severity?: Severity
  /** The instance's own summary annotation, the text of its row in an email and its place in the worst-first order. */
  summary?: string
  /** What the evidence-link model reads (src/shared/evidence-links.ts). */
  annotations?: Record<string, string>
  links?: AlertLinks
  generatorURL?: string
}

/** One firing incident as the notifier sees it. Built by the engine from the same state the wall draws. */
export interface NotifyView {
  key: string
  service: string
  rule: string
  summary: string
  severity: Severity
  severityLabel: string
  origin: string
  /** Labels common to every instance, for route matching. */
  labels: Record<string, string>
  instances: InstanceView[]
  /** ISO. First time any instance started firing. */
  startsAt: string
  /** ISO. First time Watch saw it. group_wait counts from here. */
  firstSeen: string
  /** Only `none` is the pager's: an incident someone has acknowledged or silenced, or that the sweep has parked, is never sent, escalated or digested. */
  attention: Attention
  /** Seconds the incident has gone unattended (age that stops counting at ack; none while silenced or parked; counted from the end of a park that ended). */
  unattendedSec: number
  /**
   * ISO. When the incident's last park ended, if it came back from one: the pager treats everything after it as a fresh episode, so group_wait counts from it and a
   * notification sent before it (before the park) does not hold the alert back. Absent or null for an incident that was never parked.
   */
  freshSince?: string | null
  /** Three fire/resolve flips inside 30 minutes. */
  flapping: boolean
  links: AlertLinks
}

/** An incident that cleared since the last tick. */
export interface ResolvedView {
  key: string
  service: string
  rule: string
  summary: string
  severity: Severity
  origin: string
  labels: Record<string, string>
  startsAt: string
  resolvedAt: string
  durationSec: number
  /** Seconds since the last flip: resolved notices wait until the incident has been stable for 10 minutes. */
  stableForSec: number
  /** Who had it acknowledged when it resolved, and when. Absent when nobody did. */
  ackedBy?: string
  ackedAt?: string
  /** True when a firing notification was sent for it, so a resolved notice has something to resolve. */
  wasNotified: boolean
}
