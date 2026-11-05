// The canonical alert model of EZO Watcher.
//
// Layer 2 of "steal the right layer": the wire shape is Alertmanager's GettableAlert (labels, annotations,
// startsAt, endsAt, generatorURL, fingerprint, status{state, silencedBy, inhibitedBy, mutedBy}), from
// prometheus/alertmanager api/v2/openapi.yaml (retrieved 2026-10-14). Everything Watch adds sits beside it:
// provenance (where the alert was seen and every link back to evidence), lifecycle (when we first and last
// saw it, ack and silence), and the untouched raw payload for the deepest drill level.

import type { WallGroupDef } from './wall-groups.ts'

export type Severity = 'page' | 'warning' | 'info'
/** Wall tier. Severity is a tier, not a factor: tiers own area budgets (see weight.ts). */
export type Tier = 'page' | 'warning' | 'quiet'

/** Alertmanager status.state, verbatim enum. There is no 'firing' there: active means firing. */
export type AmState = 'unprocessed' | 'active' | 'suppressed'

export interface AlertStatus {
  state: AmState
  silencedBy: string[]
  inhibitedBy: string[]
  mutedBy: string[]
}

/** Every reference link we can attach to an alert. All optional; absent links are simply not shown. */
export interface AlertLinks {
  generator?: string
  runbook?: string
  dashboard?: string
  panel?: string
  explore?: string
  rule?: string
  silence?: string
}

/** One way an alert reached us. An alert seen both by the Grafana poll and by a webhook push has two. */
export interface AlertVia {
  /** Source id from config, for example "grafana" or "vmalert" or "webhook". */
  source: string
  kind: SourceKind
  /** ISO time this observation channel last reported it firing. */
  lastSeen: string
  /** Where to look at it on that channel. */
  url?: string
}

/** 'zulip' is the retired alert-relay poll: no source of that kind exists any more, but alerts stored while it ran keep it in their `via`. */
export type SourceKind =
  | 'grafana'
  | 'zulip'
  | 'webhook'
  | 'self'
  | 'vmalert'
  | 'netdata-cloud'
  | 'netdata-fleet'
  | 'sentry'
  /** The Watcher's own uptime prober (src/server/sources/http-probe.ts): a GET per target, ProbeDown, ProbeSlow and CertExpiring. */
  | 'http-probe'
  /** The Watcher's own TCP prober (src/server/sources/tcp-probe.ts): a connect per host and port, ProbeDown, ProbeSlow and, for a TLS target, CertExpiring. */
  | 'tcp-probe'
  /** The Watcher's own registrar-expiry check (src/server/sources/domain-expiry.ts): each domain's RDAP expiration event, DomainExpiring. */
  | 'domain-expiry'
  /** A push body Watch polls instead of being pushed (src/server/sources/feed.ts): what POST /ingest/<source> takes, read with GET and a Bearer. */
  | 'feed'
  /** A scheduled job that pings Watch after each run (src/server/sources/heartbeat.ts): a missed run or a reported failure is an incident. */
  | 'heartbeat'
  /** The machine this process runs on (src/server/sources/host.ts), read with node:os and fs.statfs: load per core, memory available, free space per mount, an optional pid. Nothing to install, no network. */
  | 'host'

// GET /api/fleet (src/shared/fleet.ts): the fleet metrics snapshot the fleet view reads.
export type { FleetDiskHeat, FleetGroup, FleetHeat, FleetMount, FleetNode, FleetNodeRule, FleetRole, FleetRuleId, FleetSeries, FleetSummary, FleetThresholds, FleetView } from './fleet.ts'

/**
 * Where a source's endpoint was found (config `discovered`, written by `watcher add --found-at`): the record that the URL is a reading of the
 * project, not somebody's guess. A source without one is "untraced" (doctor code source.untraced, a warning: the gate rests on `doctor --prove`).
 */
export interface SourceDiscovery {
  /** Where it was found: the file and line, or the command, whose output names the endpoint ("src/server.ts:42"). One line. */
  foundAt: string
  /** What was read there that showed the endpoint answers ("GET /healthz returns {\"status\":\"ok\"}"). One line. */
  read?: string
  /** ISO time the discovery was recorded: the `watcher add` that wrote it. */
  at?: string
}

export interface Alert {
  /** Identity: `${origin}:${fp8}`. The same alert seen on two channels shares it. */
  key: string
  /** The system that raised it: "grafana", "prod", "dev", or a webhook source name. */
  origin: string
  /** Alertmanager fingerprint (full) when the source gave one; a hash of the labels otherwise. */
  fingerprint: string
  /** alertname, or the rule name for Grafana's DatasourceNoData / DatasourceError pseudo-alerts. */
  rule: string
  /** What group the wall puts it in: derived from labels and the service map in config. */
  service: string
  /** The machine or instance it concerns, when known. */
  host: string
  severity: Severity
  /** The raw severity label as sent ("critical", "warn", ...), kept for display. */
  severityLabel: string
  labels: Record<string, string>
  annotations: Record<string, string>
  /** ISO. Alertmanager: when the alert began firing. */
  startsAt: string
  /** ISO. Present once resolved; Alertmanager sets a future endsAt on a firing alert, which we drop. */
  endsAt: string | null
  generatorURL?: string
  status: AlertStatus
  /** A short value string when the source gave one (Grafana values, a webhook value). */
  value?: string
  links: AlertLinks
  via: AlertVia[]
  // lifecycle, written by the engine
  firstSeen: string
  lastSeen: string
  resolvedAt: string | null
  /** Raw payload from the richest channel, for the raw-data drill level. */
  raw: unknown
}

/** What a source adapter hands the engine after one poll or one webhook. */
export interface Observation {
  source: string
  kind: SourceKind
  /** ISO time of the observation. */
  at: string
  /** The firing alerts seen. */
  firing: Alert[]
  /** Alerts the source says resolved (a webhook with status resolved). */
  resolved: Alert[]
  /**
   * True when `firing` is the complete set the source holds, so any alert this source previously reported
   * firing and now omits has resolved. Webhooks are never complete.
   */
  complete: boolean
  /** Rule inventory, when the source has one (Grafana's rules API): the health grid reads it. */
  rules?: RuleCell[]
  /** A pushed check list (sources/checks.ts): the checks a sender says it runs, as cells. Kept apart from `rules` so two senders of one webhook never replace each other. */
  checks?: ChecksPush
  /** Alerts the source already knows to be resolved: seeds the history view once. No source sends it since the Zulip bridge poll was retired. */
  resolvedHistory?: Alert[]
  /**
   * The last good answer of each probe target, tagged with source and target. Kept in the process's memory only (never written to the database),
   * so `watcher doctor --prove` can mutate a recorded answer and re-run the same predicates instead of asking the target again.
   */
  probes?: ProbeObservation[]
}

/** One HTTP answer as the prober read it: the status, the headers and the body. The body is the one the target's assertions are judged on. */
export interface ProbeAnswer {
  status: number
  /** Header names lower-cased, as `fetch`'s Headers gives them. */
  headers: Record<string, string>
  /** The body as read, at most the prober's cap; null when the body was over the cap or could not be read. */
  bodyText: string | null
}

/** A probe target's last good answer, tagged with where it came from: what `doctor --prove` mutates. */
export interface ProbeObservation extends ProbeAnswer {
  source: string
  target: string
  /** ISO time of the poll that recorded it. */
  at: string
}

/** One watched rule: a cell in a proof-of-watch tile. */
export type CellState = 'ok' | 'pending' | 'firing' | 'nodata' | 'error' | 'stale' | 'inferred'
export interface RuleCell {
  id: string
  source: string
  name: string
  service: string
  state: CellState
  /** ISO of the rule's last evaluation, when the source reports one. */
  evaluatedAt?: string
  /** Seconds between evaluations, when known. */
  intervalSec?: number
  /** A pushed check list: the cell is dashed once its last run (`evaluatedAt`) is older than this. Wins over `intervalSec`, whose rule is twice the interval. */
  staleAfterSec?: number
  /** One short line from the sender about the last run ("HTTP 200 in 41ms"). */
  detail?: string
  /**
   * What this cell's last run asserts, in words: every predicate its check made (`["status 200", "body.ok = true"]`) and what green means for a check
   * with no predicate of its own (a heartbeat cell says `["heartbeat:on-time"]`, so green means the job ran on time; a tcp-probe cell says
   * `["tcp:connect"]`, and a domain-expiry cell `["rdap:expires>7d"]`). A cell whose list holds nothing but `status 200` proves only that something
   * answered; the Sources page counts the ones that assert more (`SourceStatus.asserted`).
   */
  asserts?: string[]
  /** Set on a cell that came from a pushed check list: the class (alertname) the check fires under. The wall matches a dotted history cell to it. */
  checkId?: string
  url?: string
}

/** What a sender says about one check it runs. ok = last run passed, pending = failing but not yet declared (a damping streak), failing = declared, skipped = could not run. */
export type CheckState = 'ok' | 'failing' | 'pending' | 'skipped'

/** One parsed check list: the cells of one sender (`origin`), and whether it is the sender's whole list. */
export interface ChecksPush {
  origin: string
  /** True: a check of this origin that is not in `cells` is gone and its cell is dropped. False: the cells update, the rest stay. */
  complete: boolean
  cells: RuleCell[]
}

export type SourceState = 'ok' | 'stale' | 'error' | 'idle'
export interface SourceStatus {
  id: string
  kind: SourceKind
  name: string
  state: SourceState
  lastOk: string | null
  lastAttempt: string | null
  error: string | null
  /**
   * Why this source is not started on this host: an optional source (`watcher add … --optional`) whose credential env is unset
   * reads this as `missing <ENV>` and state `idle`, never stale or error, and raises no source-stale alert. Absent on a
   * source that runs.
   */
  skipped?: string
  /** Alerts currently firing that this source reports. */
  firing: number
  rules: number
  /** Consecutive missed polls. Three raise the source-stale alert. */
  misses: number
  /** A pushing source that promised a schedule: silence for longer than this many seconds reads stale. Absent for a poller and for a source that never promised one. */
  staleAfterSec?: number
  /**
   * How many of this source's cells assert more than that something answered (a `RuleCell.asserts` holding a predicate besides the default
   * "status 200"). 0 means no cell of this source is proven to go red for anything but a dead process. Absent on a server that predates it: the
   * Sources page then shows no badge.
   */
  asserted?: number
  /** Where this source's endpoint was found (config `discovered`), when it records one. Absent: the source is untraced. */
  discovered?: SourceDiscovery
}

/** One line of `watcher doctor`'s report (GET /api/doctor, docs/doctor-codes.md): what was checked, what it found, and how to repair it. */
export interface DoctorCheck {
  /** A dotted code ("source.bare-200", "config.invalid"): stable, so a transcript can match on it. */
  code: string
  status: 'pass' | 'fail' | 'warn' | 'skip'
  /** One line, safe to show: never a secret and never a payload value. */
  message: string
  /** The command or edit that repairs it, when there is one. */
  next?: string
}

/**
 * GET /api/doctor: the checks the running process can make about its own sources, and the recorded answers `doctor --prove` mutates. The CLI
 * merges these with the checks only it can make (is the server up, is a channel configured) into one report.
 */
export interface DoctorReport {
  /** False when a check failed. A warning does not make the report red. */
  ok: boolean
  checks: DoctorCheck[]
  /** Every probe target's last good answer, from memory. A target that has not answered since the process started has none. */
  observations: ProbeObservation[]
}

/**
 * Who has the incident, or why the pager leaves it alone. Precedence: silenced, then acked, then parked, then none. `parked` is not a person's act: it is an
 * open triage verdict that is not due yet (the regression sweep says so in the alert's annotations, src/shared/incident.ts `parkOf`).
 */
export type Attention = 'none' | 'acked' | 'silenced' | 'parked'

/**
 * Why an incident is parked: `deferred` (a person chose a later date), `fixed_undeployed` (the fix is merged and not live yet) or `awaiting_source` (the fix is live
 * and the source's evaluation window has not caught up, so it still reports the alert). The sweep's `parked_state` annotation says the first two; a park set by hand
 * (`Engine.park`, the MCP `park` tool) may say any of the three.
 */
export type ParkedState = 'deferred' | 'fixed_undeployed' | 'awaiting_source'

/**
 * A park as the alert's annotations state it (`parked_state`, `parked_until`, `parked_since`, `parked_ref`, `parked_note`), or as someone set it by hand on the
 * incident (`Engine.park`, which also fills `by`).
 */
export interface Park {
  state: ParkedState
  /** ISO UTC. When the park ends: the incident is back in its severity tier, unattended, from this instant. */
  until: string
  /** ISO UTC. When the verdict was written, when the sender said; for a park set by hand, the moment it was set. */
  since: string | null
  /** A ticket id, when the sender gave one. */
  ref: string | null
  /** One short line from the sender; for a park set by hand, the note the parker gave (up to 500 characters). */
  note: string | null
  /** Who set the park by hand, as stored ("agent: <who>", a person's name, "this browser"). Absent on a park the sweep's annotations state: its presence IS the difference. */
  by?: string
  /**
   * A park set by hand: the keys of the alerts that were firing when it was set. It covers those alerts and no others (the annotation rule, "parked only when every firing alert
   * states a park"): an alert that joins the incident later ends it. Absent on a park the sweep states, and on one written before this was recorded.
   */
  alertKeys?: string[]
}

/** The state of one incident, computed by one pure function (incident.ts) that the wall and the pager share. */
export interface IncidentState {
  tier: Tier
  /** Area weight inside the tier, an integer so the layout only moves on a real step. */
  R: number
  /** Age band 0..3, counted only while unattended. Band edges are the escalation edges. */
  band: 0 | 1 | 2 | 3
  attention: Attention
  /** Counts as firing: false while parked (it still fires at its source, but it is in no firing, unattended or paging tally). */
  firing: boolean
  instances: number
  /** The honoured park, while `attention` is `parked`; null otherwise. */
  park: Park | null
  /** Epoch ms the unattended clock started: the incident's own start, or the end of the park it came back from when that is later. */
  unattendedSinceMs: number
}

/** A wall tile before layout: one incident (firing) or one service (healthy health tile). */
export interface Incident {
  /** `${service}|${rule}` for a firing incident, `${service}|${rule}|${instance}` when the config splits it per instance. */
  key: string
  service: string
  rule: string
  /** The value that told this incident from its siblings (the prober's target), when the config splits the rule per instance. */
  instance: string | null
  summary: string
  severity: Severity
  state: IncidentState
  startsAt: string
  /** Firing instances. `raw` is left empty here; the detail endpoint carries it. */
  alerts: Alert[]
  ackedBy: string | null
  ackedAt: string | null
  silencedUntil: string | null
  /** Who silenced it (the name the caller gave, "agent: <who>" for an agent), while the silence holds. */
  silencedBy: string | null
  /** The silence was set before this episode of the incident fired: it was carried over from the last one (silences are time-boxed, so it stays until it runs out). */
  silenceCarried: boolean
  /** Every rule cell of the incident's service, so a big tile can show the proof-of-watch strip. */
  cells: RuleCell[]
  /** Latest notification receipt for this incident, for the tile footer. */
  receipt: Receipt | null
  /** Next escalation, when one is due. */
  nextStep: NextStep | null
  heldUntil: string | null
  /** Every matching route has no receivers: the incident is on the wall and nobody is notified. */
  wallOnly: boolean
}

export interface Receipt {
  at: string
  channel: string
  ok: boolean
  latencyMs: number
  status: string
}

export interface NextStep {
  at: string
  channels: string[]
}

/** A proof-of-watch tile: one service and a cell per rule behind it. */
export interface ServiceHealth {
  service: string
  cells: RuleCell[]
  /** The service has firing incidents; the cells then sit inside the incident tiles instead. */
  firing: number
}

export interface WallHeader {
  rulesWatched: number
  /** Incidents firing now, parked ones left out: a parked incident is counted in `parked`, never here. */
  firing: number
  /** Of the firing incidents, how many someone has acknowledged (and not silenced). */
  acknowledged: number
  /** Incidents parked (an open triage verdict that is not due yet): off the firing count, on the wall in their own section. A server that predates the state sends none. */
  parked?: number
  oldestEvaluationAt: string | null
  lastIncidentAt: string | null
  stale: boolean
}

/** One response carries the whole wall: the client polls it with an ETag. */
export interface WallState {
  generatedAt: string
  header: WallHeader
  sources: SourceStatus[]
  incidents: Incident[]
  health: ServiceHealth[]
  /** Channel proof strip: last real test per channel. */
  channels: ChannelProof[]
  /** The categories the wall files its services under, in drawing order (config `wallGroups`). Absent = no headings, one band of cells. */
  wallGroups?: WallGroupDef[]
}

export interface ChannelProof {
  id: string
  type: string
  enabled: boolean
  lastTestAt: string | null
  /** null when never tested, and when the last test found the channel unconfigured: that is not a failed test. */
  lastTestOk: boolean | null
  /**
   * What the last test found: it was delivered, it failed, or the channel had nobody to deliver to (a Web Push channel with no
   * subscribers). null when never tested.
   */
  lastTest: 'passed' | 'failed' | 'unconfigured' | null
}

export type EventKind =
  | 'fired'
  | 'resolved'
  | 'ack'
  | 'unack'
  | 'silence'
  /** Someone parked the incident by hand (the MCP `park` tool, POST /api/incidents/:key/park): who, why, until when. */
  | 'park'
  /** Someone ended a hand-set park before it ran out. */
  | 'unpark'
  | 'notify'
  | 'notify-failed'
  | 'source-stale'
  | 'source-recovered'
  | 'flapping'
  /** The source still reported an alert after someone marked its incident resolved by hand: the incident is firing again. */
  | 'reopened'
  /** Someone confirmed that a resolved incident is resolved, with a note. */
  | 'confirmed'

export interface AlertEvent {
  id: number
  at: string
  kind: EventKind
  alertKey: string | null
  incidentKey: string | null
  detail: Record<string, unknown>
}

export interface HistoryRow {
  incidentKey: string
  service: string
  rule: string
  /** Set for an incident the config splits per instance, so two targets of one rule are told apart in history. */
  instance?: string
  severity: Severity
  source: string
  startsAt: string
  resolvedAt: string
  durationSec: number
  instances: number
  /** Who acknowledged it during this episode, and when, when someone did and it stayed acknowledged until it resolved. */
  ackedBy?: string
  ackedAt?: string
  /** Set when someone marked this episode resolved by hand (the MCP `resolve` tool) and the source had not said so: who, why. A source's own resolve has no such field. */
  manual?: { by: string; reason: string }
  /** The last confirmation that this episode is resolved: who, when, and the note. */
  confirmed?: { by: string; at: string; note?: string }
}

/**
 * What this Watch calls itself (config `brand`): the page title and header, the installed app's name, the notification titles, the email header and
 * the MCP server's name. One codebase serves more than one wall, so the product name is never a literal. Absent from
 * the config: `{ name: 'EZO Watcher', shortName: 'Watcher' }` (src/shared/instance.ts DEFAULT_BRAND).
 */
export interface Brand {
  /** The full name, one line of at most 40 characters: "EZO Watcher", "Infra Wall". */
  name: string
  /** Where room is short (the installed app's label under its icon), at most 24 characters. Absent: `name`. */
  shortName?: string
}

/**
 * A view that only some Watches have, by the view's own name: each shows in the nav only when this server has its backing (src/server/instance.ts
 * `featuresOf`). The wall, History, Notifications and Sources are on every Watch and are never listed.
 */
export type WatchFeature = 'fleet'

/** GET /api/instance, and the `watch-instance` meta of the served page: the name to show and the optional views this server backs. */
export interface InstanceInfo {
  brand: Required<Brand>
  features: WatchFeature[]
}

/** A comment on an incident. Written by an agent through the MCP server (`by` reads "agent: <who>") or by a person on the wall. */
export interface IncidentComment {
  id: number
  incidentKey: string
  by: string
  /** Markdown, at most 4000 characters. */
  text: string
  createdAt: string
}
