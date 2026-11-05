// Configuration shape. The config file holds structure only (which sources, channels and routes exist).
// A secret is never in it: every credential is named by an environment variable (`...Env`), and the
// environment comes from a 0600 env file on the host or from the keyring at deploy time. Nothing secret
// is committed to this repository or written to a log.

import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import type { Brand, Severity, SourceDiscovery } from '../shared/types.ts'
import { brandProblems, resolveBrand } from '../shared/instance.ts'
import { wallGroupProblems } from '../shared/wall-groups.ts'
import type { WallGroupDef } from '../shared/wall-groups.ts'
import { heartbeatProblems } from './sources/heartbeat.ts'
import type { HeartbeatSourceConfig } from './sources/heartbeat.ts'
import { hostProblems } from './sources/host.ts'
import type { HostSourceConfig } from './sources/host.ts'

/** A heartbeat source's config lives with its adapter (src/server/sources/heartbeat.ts); it joins the union here like every other source's. */
export type { HeartbeatSourceConfig } from './sources/heartbeat.ts'
/** A host source's config lives with its adapter (src/server/sources/host.ts); it joins the union here like every other source's. */
export type { HostSourceConfig } from './sources/host.ts'

export interface ServiceRule {
  /** All present matchers must match. `labels` keys are label names, values are RegExp source strings. */
  match: { origin?: string; rule?: string; labels?: Record<string, string> }
  service: string
}

/** Which alerts form one incident per value of a label, so a silence or an acknowledgement on one target leaves the others alone. */
export interface SplitRule {
  /** All present matchers must match, on the alert as merged from every channel. */
  match: { origin?: string; rule?: string }
  /** The label whose value tells the incidents apart, for example "instance" (the prober's target). An alert without it stays in the shared incident. */
  by: string
}

/**
 * A ceiling on the severity of a class of alert. A dev environment going offline need not be red, so a page from a dev environment is a
 * warning: on the tile, in every count and to the pager. It is applied to each alert as the engine takes it in, and again where a stored alert is read
 * (`capSeverity`, src/server/derive.ts), before an incident's severity is taken as the worst of its alerts. So an incident that also holds an alert no cap
 * covers (prod's ApiWedge beside dev's) keeps that alert's page. The capped alert says so in its `watch_capped` annotation.
 */
export interface SeverityCap {
  /**
   * All present matchers must match, and at least one is given. Each is a RegExp source: `origin` and `rule` (the alertname) as in `serviceMap`, `labels`
   * keyed by label name (a label the alert lacks reads as "").
   */
  match: { origin?: string; rule?: string; labels?: Record<string, string> }
  /** The most this class may be. When more than one cap matches, the lowest holds. */
  max: 'warning' | 'info'
  /** One line: why. Every alert it caps carries it. */
  note: string
}

/** A class of alert the wall never infers a rule cell from. Both matchers are RegExp sources; all present ones must match. */
export interface ExcludedClass {
  origin?: string
  rule?: string
  /** Why, for whoever reads the config next. */
  note?: string
}

// ---- sources ----------------------------------------------------------------------------------------

export interface GrafanaSourceConfig {
  id: string
  type: 'grafana'
  /** Base URL reachable from the host, for example http://192.0.2.10:3000 */
  url: string
  /** A Viewer service-account token, by env var name. */
  tokenEnv: string
  /** The URL humans use for links, when it differs from `url`. */
  publicUrl?: string
  pollSec: number
}

/**
 * A building block a push sender may add: the config for the Netdata webhook adapter. Netdata Cloud POSTs one alert per body and
 * names only the host; the adapter joins a disk alert to the Grafana host-disk rule of the same tier when the host has one, and it
 * cannot know that from the payload. `grafanaDiskHosts` is that list: a host on it joins the Grafana incident, any other host stands
 * alone. `netdataHosts` is informational and kept for operators who name their agents; it changes nothing about routing.
 */
export interface NetdataWebhookConfig {
  grafanaDiskHosts?: string[]
  netdataHosts?: string[]
}

export type WebhookVerifyScheme = 'github' | 'stripe' | 'hmac-sha256'

/**
 * A signed-webhook credential for a webhook source, for a sender that cannot set an Authorization header: GitHub signs X-Hub-Signature-256,
 * Stripe signs Stripe-Signature, a generic sender signs a header of its own. The secret is never in the config: `secretEnv` names the environment
 * variable that holds it. Verification is over the exact bytes of the request body (sources/webhook.ts).
 */
export interface WebhookVerifyConfig {
  /** `github`: X-Hub-Signature-256, `sha256=<hex>` HMAC of the raw body. `stripe`: Stripe-Signature, the `<t>.<body>` HMAC with a replay window. `hmac-sha256`: a bare or `sha256=` hex HMAC of the raw body in `header`. */
  scheme: WebhookVerifyScheme
  /** The env var holding the shared secret: GitHub's webhook secret, Stripe's `whsec_...` endpoint secret, or the generic HMAC key. */
  secretEnv: string
  /** Only for `hmac-sha256`: the header the sender signs into. Default `X-Signature-256`. GitHub and Stripe fix their own header, so a value here is refused. */
  header?: string
}

export interface WebhookSourceConfig {
  id: string
  type: 'webhook'
  /** Bearer token for POST /ingest/<id>, by env var name. A source with a `verify` block may omit it: a signed push is its credential. */
  tokenEnv?: string
  /**
   * The sender pushes on a schedule, so silence is a failure: after this many seconds without a push the source
   * reads "stale" (the wall's status line and the Sources page say so) and the wall raises a source-stale alert of its
   * own (engine.staleAlerts), at `staleSeverity`. Absent = never stale, which is right for an Alertmanager that only pushes
   * when something changes.
   */
  staleAfterSec?: number
  /**
   * The severity of the source-stale alert raised when this source is silent past `staleAfterSec`. Default 'page': a push source that promised a
   * schedule and then broke that promise has stopped reporting, which is a page. A polled source's missed poll keeps its warning.
   */
  staleSeverity?: 'page' | 'warning'
  /**
   * How long an alert this source pushed stays firing without a resend. Absent = 6 h, the default of every
   * webhook sender. Set it above the sender's longest gap between pushes, or alerts flap off and on.
   */
  presenceTtlSec?: number
  /**
   * The sender can be asked to run its check again: an alert's Re-check (the wall, the MCP `recheck` tool) leaves a request the sender picks up
   * from GET /ingest/<id>/recheck-requests and answers with POST /ingest/<id>/recheck-requests/<request id> (docs/mcp.md, "Re-check"). Absent = the sender
   * cannot be asked, and Re-check only says when it reports next. `pickupWithinSec` is how soon it promises to look, 30 to 3600; the sheet says so.
   */
  recheckRequests?: { pickupWithinSec: number }
  /** What the Netdata Cloud webhook adapter needs beyond the payload (the host-disk rule list). Absent: no host joins a Grafana rule. */
  netdata?: NetdataWebhookConfig
  /** A signed-webhook credential beside the Bearer token: either one accepts the push. Absent: only the Bearer token authenticates the source. */
  verify?: WebhookVerifyConfig
}

/**
 * The health of a vmalert rule file, read from the VictoriaMetrics that stores vmalert's own metrics
 * (`vmalert_alerting_rules_*`, one series per rule). It carries no alerts: whether a rule fires reaches Watch through the
 * Alertmanager (the router receivers push to the webhook source). It carries proof of watch, one cell per rule.
 */
export interface VmalertSourceConfig {
  id: string
  type: 'vmalert'
  /** Base URL of the VictoriaMetrics query API reachable from the host, for example http://127.0.0.1:8428 */
  url: string
  pollSec: number
  /** A rule whose error counter rose within this many seconds reads "error". Default 300. */
  errorWindowSec?: number
  /** A rule whose series was seen within this many seconds but not now reads "no data". Default 3600. */
  knownWindowSec?: number
}

/**
 * One query the Netdata Cloud source runs: a set of contexts (never "*": a whole-room query is tens of megabytes) and the alert
 * names to read inside them. One group is one proof-of-watch cell, so a name the group does not list is not watched.
 */
export interface NetdataCloudGroupConfig {
  /** Stable id: part of the cell id, so renaming it replaces the cell. */
  id: string
  /** The cell's name on the Netdata tile. */
  name: string
  /** Netdata contexts to scope the query to, simple patterns (`disk.space`, `clickhouse.*`). */
  contexts: string[]
  /** Alert names to read, simple patterns (`disk_space_usage`, `clickhouse_*`, `*`). */
  alerts: string[]
  /** The wall tile its alerts land on when they join no Grafana rule. Default "Netdata". */
  service?: string
  /** Query this group every N seconds instead of every poll (a big context such as Docker's). */
  everySec?: number
}

/** An instance whose alerts are never shown: a mounted installer image at 100 % is not a full disk. */
export interface NetdataCloudIgnoreRule {
  /** RegExp source for the node's hostname; absent = any node. */
  node?: string
  /** RegExp source for the Netdata instance id (`disk_space./Volumes/Google Chrome`). */
  instance: string
  note?: string
}

/** What a person needs to know about a Netdata node that Cloud does not report. Both fields are optional. */
export interface NetdataNodeNote {
  /** The public name that reaches the machine (`print.example.com`). Shown beside the node's name and address. */
  dns?: string
  /** One or two sentences: what the machine is, what runs on it, what a restart does. Shown under "Where". */
  note?: string
}

/**
 * The disk warning floor (no warning for a disk under 80 % used). A Netdata disk-capacity alert at WARNING on a mount
 * less full than `usedPct` is not raised; its CRITICAL tier (a disk projected full in under 2 hours) is raised at any fill.
 */
export interface NetdataDiskWarningFloor {
  /** Percent used, 0 to 100. 0 turns the floor off. */
  usedPct: number
  /** One line: why this number (the config's record of the rule). */
  note: string
}

/**
 * Netdata Cloud, read by a poll (outbound HTTPS only, so no firewall rule is needed on the Watch host). It reads which nodes
 * Cloud can reach and, per alert group, which instances are in WARNING or CRITICAL. src/server/sources/netdata-cloud.ts has the tables.
 */
export interface NetdataCloudSourceConfig {
  id: string
  type: 'netdata-cloud'
  /** Origin of the Cloud API, `https://app.netdata.cloud`. The bearer token is sent only there. */
  url: string
  /** A Netdata Cloud API token (scope:grafana-plugin is enough), by env var name. */
  tokenEnv: string
  spaceId: string
  roomId: string
  /** Seconds between polls. Netdata evaluates alerts every few seconds to a minute; 60 is plenty and kind to the API. */
  pollSec: number
  /** Nodes Watch may page for: a full disk or an unreachable node there is a page. */
  fleetNodes: string[]
  /** Nodes that only ever reach the wall (a warning at most). A node in the room that is in neither list counts as one. */
  watchOnlyNodes?: string[]
  /**
   * Nodes Watch does not watch at all, by the name Cloud gives them, each with the one-line reason (`{ "print": "print spooler, not monitored" }`). Their
   * alerts are dropped like quietAlerts' (never raised), they are not expected for reachability (never unreachable, never missing from the room) and they count
   * in no cell. One line to add the next node nobody wants watched.
   */
  ignoreNodes?: Record<string, string>
  /** Instances to ignore, added to the built-in rules (macOS /Volumes, snap mounts). */
  ignoreInstances?: NetdataCloudIgnoreRule[]
  /** Alert names (`*` wildcards) dropped from the wall: the noisy ones. Default the two disk latency alerts. */
  quietAlerts?: string[]
  /** No disk WARNING on a mount under this percent used. Absent = 80 (DEFAULT_DISK_WARNING_FLOOR_PCT in sources/netdata-cloud.ts). */
  diskWarningFloor?: NetdataDiskWarningFloor
  /** The queries to run. Absent = the built-in groups (disk space, disk inodes, RAID and NVMe, ClickHouse, Docker, host basics). */
  groups?: NetdataCloudGroupConfig[]
  /**
   * Where a person opens the room in Netdata Cloud, `https://app.netdata.cloud/spaces/<space slug>/rooms/<room slug>`. It is the
   * cells' link, and an alert on a node opens that node's page under it (`/nodes/<node id>`).
   */
  cloudUrl?: string
  /**
   * What Netdata Cloud cannot say about a node, by the name Cloud gives it. Cloud knows a node's hostname and address; only we know
   * the public name that reaches it and what it is for. Both go into the words of every alert about the node.
   */
  nodes?: Record<string, NetdataNodeNote>
  /** The nodes whose host-disk alert has a Grafana rule of the same tier (the netdata webhook source's `netdata.grafanaDiskHosts`): on one, a space alert joins the Grafana incident. Absent = every Netdata disk alert stands alone. */
  grafanaDiskHosts?: string[]
  /** Per-request timeout in ms. Default 10000. */
  requestTimeoutMs?: number
}

/**
 * One threshold rule of the fleet-load rules: it fires when the reading stays above `warnAbove` for `forMin` minutes and clears when it stays below
 * `clearBelow` for `forMin` minutes (the gap is the hysteresis that stops a reading on the line from flapping).
 */
export interface FleetThresholdConfig {
  warnAbove: number
  clearBelow: number
  /** Minutes the reading is held (CPU: its average over this window; memory and load: every minute of it). */
  forMin: number
}

/** The numbers behind HostCpuHot, HostMemoryHot and HostLoadHigh. Every field is optional: an absent one takes the default of src/server/sources/fleet-rules.ts. */
export interface NetdataFleetRulesConfig {
  /** HostCpuHot: CPU busy percent averaged over `forMin`. Warning only. */
  cpu?: FleetThresholdConfig
  /** HostMemoryHot: memory in use percent. Above `warnAbove` is a warning; above `pageAbove` (a page, fleet nodes only) both held for `forMin`. */
  memory?: FleetThresholdConfig & { pageAbove: number; pageClearBelow: number }
  /** HostLoadHigh: load5 per core. Warning only. */
  load?: FleetThresholdConfig
  /** The fleet view reads a node `cold` when its 10-minute CPU average is under this percent (and it is not warm or hot). Default 10. */
  coldCpuBelow?: number
}

/**
 * The fleet metrics source: one Netdata Cloud data query per poll for every node's CPU, memory, load and root disk, the last `windowMin` minutes at one point a
 * minute. It holds them in memory for GET /api/fleet and raises the fleet-load alerts (HostCpuHot, HostMemoryHot, HostLoadHigh) for fleet nodes. It uses the
 * same Netdata Cloud token as the `netdata-cloud` source and the same outbound HTTPS, so it needs no firewall rule and no new secret.
 */
export interface NetdataFleetSourceConfig {
  id: string
  type: 'netdata-fleet'
  /** Origin of the Cloud API, `https://app.netdata.cloud`. The bearer token is sent only there. */
  url: string
  /** A Netdata Cloud API token (scope:grafana-plugin is enough), by env var name. The same variable the netdata-cloud source reads. */
  tokenEnv: string
  spaceId: string
  roomId: string
  pollSec: number
  /** The fleet's hostnames: the rules cover these and only these, and the only ones a memory page can come from. */
  fleetNodes: string[]
  /** Nodes that appear in the view but raise nothing. A room node in no list counts as one. */
  watchOnlyNodes?: string[]
  /**
   * Nodes Watch does not watch at all, by the name Cloud gives them, each with the one-line reason (`{ "print": "print spooler, not monitored" }`).
   * An ignored node is left out of the view's nodes[] and of every summary count (nodes, servers, watchOnly, live, hot, warm, cold, hottest, fleetCpuAvg).
   */
  ignoreNodes?: Record<string, string>
  /** Nodes that are not hosts (`netdata-k8s-state` is the Kubernetes state collector): shown with no figures. */
  k8sNodes?: string[]
  /** `https://app.netdata.cloud/spaces/<space slug>/rooms/<room slug>`: the view's link, and the base of every node's page. */
  cloudUrl?: string
  rules?: NetdataFleetRulesConfig
  /** Minutes of series kept per node, at one point a minute. Default 60, at most 180. */
  windowMin?: number
  /** Per-request timeout in ms. Default 15000. */
  requestTimeoutMs?: number
}

/**
 * Sentry, read by a poll over outbound HTTPS with a read-only user token (org:read project:read event:read team:read), so no
 * webhook, no internal integration and no firewall rule are needed: the Free Developer plan has alerts "via email" only, and a poll also sees an issue
 * Sentry marks resolved. Each unresolved issue in a state Sentry calls new, regressed or escalating (and a release whose crash-free session rate is low) is one
 * alert on the tile of its project. skills/ezo-watcher/references/sources.md "sentry" has the severity rules and the table of what the sweep and Grafana already cover.
 */
export interface SentrySourceConfig {
  id: string
  type: 'sentry'
  /** The API origin, `https://us.sentry.io` (the org is in the US region). The bearer token is sent only there. */
  url: string
  /** Where people open Sentry, `https://example.sentry.io`. Issue links come from Sentry's own permalink; this builds the release-stream link. */
  webUrl: string
  org: string
  /** A Sentry user API token with the scopes above, by env var name. */
  tokenEnv: string
  pollSec: number
  /**
   * Sentry project slug to the Watch tile its alerts land on: desktop, mobile, helper and web, one tile each. A project not listed is never read
   * (acme-server is left to Grafana and the sweep). The web bundle sends no release-health sessions, so its `SentryCrashFreeLow` cell stays `ok`
   * ("no release has enough sessions") rather than alerting on an empty answer.
   */
  projects: Record<string, string>
  /** Environments that raise an alert. Default production and testflight; dev, development and e2e builds never do. */
  environments?: string[]
  /** Environments that may page. Default production only: a TestFlight crash is a warning. */
  pageEnvironments?: string[]
  /** RegExp source for a release that is a developer build (`app-helper@1.0.13-dev.183`, `com.example.app.dev@...`): its events are ignored whatever the environment label says. Default `-dev\.|\.dev@`. */
  devReleases?: string
  /** An issue with no event for this many seconds is quiet and its alert resolves. Default 21600 (6 h). */
  quietAfterSec?: number
  /** A crash issue (fatal, or unhandled) in a page environment pages at this many events in the last hour. Default 20. */
  pageEventsPerHour?: number
  /** ... or when it has hit this many distinct users in the last 24 h. Default 5. Our clients send no user id, so this is rarely the one that trips. */
  pageUsers?: number
  /** A release needs this many sessions in 24 h before its crash-free rate counts. Default 50. */
  crashFreeMinSessions?: number
  /** Crash-free session rate (0 to 1) under which a release is a warning. Default 0.98. */
  crashFreeWarnBelow?: number
  /** ... and under which a production release pages. Default 0.95. */
  crashFreePageBelow?: number
}

/**
 * One URL the http-probe source GETs every poll (src/server/sources/http-probe.ts). skills/ezo-watcher/references/sources.md "http-probe" has the classes and the damping.
 * The URL is https, or plain http to a loopback, RFC 1918 or 100.64.0.0/10 address written as an IP (or `localhost`): nothing else may go out in the clear.
 */
export interface HttpProbeTargetConfig {
  /** Stable id: the alert's `instance` and the check cell's name, so renaming it replaces both. */
  id: string
  /** The wall tile its alerts and cells land on. Absent: the source's own id (one probe source watches one tile unless it says otherwise). */
  service?: string
  url: string
  /** The status a healthy answer has. Default 200. A redirect is followed never: a 3xx is a failure unless this says 3xx. */
  expectStatus?: number
  /** Dotted paths into the JSON body and the value each must equal (`{ "ok": true, "db.kind": "postgres" }`). Absent: the body is not read as JSON. */
  expectJson?: Record<string, string | number | boolean>
  /** The whole request, headers and body, is bounded by this. Default 10000. */
  timeoutMs?: number
  /** An answer slower than this on `failAfter` polls in a row is the ProbeSlow warning. Absent: no ProbeSlow for this target. */
  slowMs?: number
  /** An https target's certificate expiring in under this many days is the CertExpiring warning. Default 14. */
  certWarnDays?: number
  /** ... and in under this many days, a page. Default 3. */
  certPageDays?: number
}

/** Watch's own uptime prober: GET each target, ProbeDown after `failAfter` failures in a row, ProbeSlow, CertExpiring. */
export interface HttpProbeSourceConfig {
  id: string
  type: 'http-probe'
  /** Seconds between polls. Default 60. */
  pollSec?: number
  /** Consecutive failed (or slow) polls before ProbeDown (or ProbeSlow) fires; until then the cell reads pending. Default 3. */
  failAfter?: number
  targets: HttpProbeTargetConfig[]
  /**
   * Where the probed endpoint was found in the project (`watcher add --found-at`): the record that its URL is a reading, not a guess. Absent: the
   * source is untraced, which `watcher doctor` reports as a warning (source.untraced). It is provenance only, never a gate: the gate is
   * `doctor --prove`.
   */
  discovered?: SourceDiscovery
}

/**
 * A push body Watch polls (src/server/sources/feed.ts): `GET url` with `Authorization: Bearer <tokenEnv's value>` answers exactly what POST
 * /ingest/<source> takes (an Alertmanager v4 `alerts` list and/or a `checks` object), and each good answer is the sender's whole state: a firing
 * alert it no longer lists is resolved. A failed poll changes nothing and counts as a miss. skills/ezo-watcher/references/sources.md "feed".
 */
export interface FeedSourceConfig {
  id: string
  type: 'feed'
  /** https, or plain http to a loopback, RFC 1918 or 100.64.0.0/10 address (the bearer token is sent there). */
  url: string
  /** The bearer token, by env var name. */
  tokenEnv: string
  /** The sender its alerts and checks are filed under (the X-Alert-Source of a push). Default the source id. */
  origin?: string
  /** Seconds between polls. Default 60. */
  pollSec?: number
  /** The whole request is bounded by this. Default 10000. */
  timeoutMs?: number
}

/**
 * One TCP endpoint the tcp-probe source connects to every poll (src/server/sources/tcp-probe.ts): a port that speaks no HTTP (postgres, redis,
 * an SMTP relay, a compose service). The connect is the check; a tls target also reads the peer certificate the handshake presents. This is the
 * tcpSocket probe Kubernetes defines beside httpGet, exec and grpc (kubernetes.io, "Configure Liveness, Readiness and Startup Probes", retrieved
 * 2026-11-04); gRPC health checking needs a protocol client and is not covered.
 */
export interface TcpProbeTargetConfig {
  /** Stable id: the alert's `instance` and the check cell's name, so renaming it replaces both. */
  id: string
  /** The wall tile its alerts and cells land on. */
  service: string
  /** A hostname or IP address, without a scheme, port or path. */
  host: string
  /** The port to connect to. */
  port: number
  /** Open a TLS handshake instead of a plain TCP connect, and report the certificate's expiry. Default false. */
  tls?: boolean
  /** The connect (and, for a tls target, the handshake) is bounded by this. Default 10000. */
  timeoutMs?: number
  /** A connect slower than this on `failAfter` polls in a row is the ProbeSlow warning. Absent: no ProbeSlow for this target. */
  slowMs?: number
  /** Consecutive failed (or slow) connects before ProbeDown (or ProbeSlow) fires; until then the cell reads pending. Default 3. */
  failAfter?: number
  /** A tls target's certificate expiring in under this many days is the CertExpiring warning. Default 14. */
  certWarnDays?: number
  /** ... and in under this many days, a page. Default 3. */
  certPageDays?: number
}

/** Watch's own TCP prober: connect to each target, ProbeDown after `failAfter` failures in a row, ProbeSlow, and for a tls target CertExpiring. */
export interface TcpProbeSourceConfig {
  id: string
  type: 'tcp-probe'
  /** Seconds between polls. Default 60. */
  pollSec?: number
  targets: TcpProbeTargetConfig[]
  /**
   * Where the endpoint was found in the project (`watcher add --found-at`): the record that its host and port are a reading, not a guess. Absent: the
   * source is untraced, which `watcher doctor` reports as a warning (source.untraced). Provenance only, never a gate.
   */
  discovered?: SourceDiscovery
}

/**
 * A domain's registrar expiry, read over RDAP (src/server/sources/domain-expiry.ts): `GET https://rdap.org/domain/<domain>` and the `expiration`
 * event. Kept apart from http-probe's CertExpiring because the domain can lapse while the certificate still looks fine.
 */
export interface DomainExpirySourceConfig {
  id: string
  type: 'domain-expiry'
  /** Seconds between lookups. Default 43200 (12 h): a registrar expiry moves on the scale of days. */
  pollSec?: number
  /** The wall tile each domain's alerts and cells land on. Default the source id. */
  service?: string
  /** Days left under which a domain is the DomainExpiring warning. Default 30. */
  warnDays?: number
  /** ... and under which it pages. Default 7, at most warnDays. */
  pageDays?: number
  /** The registrable domains to look up, without a scheme or path. */
  domains: string[]
  /**
   * Where the domain list was found in the project (`watcher add --found-at`): the record that it is a reading, not a guess. Absent: the source is
   * untraced, which `watcher doctor` reports as a warning (source.untraced). Provenance only, never a gate.
   */
  discovered?: SourceDiscovery
}

export type SourceConfig =
  | GrafanaSourceConfig
  | WebhookSourceConfig
  | VmalertSourceConfig
  | NetdataCloudSourceConfig
  | NetdataFleetSourceConfig
  | SentrySourceConfig
  | HttpProbeSourceConfig
  | TcpProbeSourceConfig
  | DomainExpirySourceConfig
  | FeedSourceConfig
  | HeartbeatSourceConfig
  | HostSourceConfig

// ---- channels ---------------------------------------------------------------------------------------

/**
 * ntfy has two targets. `server` and `topicEnv` name the PUBLIC server (ntfy.sh): it only ever gets a content-free
 * notice ("EZO Watcher: page", "Open Watch for details", an opaque click link), because its operator can read everything
 * published there. `self` names the SELF-HOSTED server (ntfy.example.com): it gets the whole alert, with the one-tap
 * Acknowledge, authenticated with an access token.
 */
export interface NtfyChannelConfig {
  id: string
  type: 'ntfy'
  /** The public ntfy server, `https://ntfy.sh`. */
  server: string
  /** The topic is the secret on a public ntfy server, so it is an env var name. */
  topicEnv: string
  /** Optional bearer token for the public server. */
  tokenEnv?: string
  /** The self-hosted server. Optional by design: while any of the three variables is unset the notice still goes to the public server. */
  self?: NtfySelfConfig
  /**
   * Env var that says which target the phone listens to: `public` (default) or `self`. Only that target's answer
   * decides whether the ntfy step succeeded (so web push fires when the phone's own target failed); the other is
   * best effort and its failure is only logged.
   */
  primaryEnv?: string
}
export interface NtfySelfConfig {
  /** Env var holding the server's base URL, for example `https://ntfy.example.com`. */
  urlEnv: string
  /** Env var holding the topic. Not a secret here (the server refuses anonymous readers), but kept out of the repository. */
  topicEnv: string
  /** Env var holding the publisher's access token (`tk_...`), sent as `Authorization: Bearer`. */
  tokenEnv: string
}
export interface WebPushChannelConfig {
  id: string
  type: 'webpush'
  publicKeyEnv: string
  privateKeyEnv: string
  /** Must be a real mailto: or https: URI, or Apple Push answers 403 BadJwtToken. */
  subject: string
}
export interface SmsChannelConfig {
  id: string
  type: 'sms'
  provider: 'telnyx' | 'quo'
  apiKeyEnv: string
  /** Sender: an E.164 number, or a Quo phone number id (PN...). */
  fromEnv: string
  /** Recipient E.164 numbers, by env var name holding a comma-separated list. */
  toEnv: string
  /** Base URL override, for tests. */
  baseUrl?: string
}
export interface EmailChannelConfig {
  id: string
  type: 'email'
  provider: 'resend'
  apiKeyEnv: string
  from: string
  toEnv: string
  baseUrl?: string
}
export interface WebhookChannelConfig {
  id: string
  type: 'webhook'
  urlEnv: string
  headers?: Record<string, string>
}
/**
 * A local file: one JSON line per notification appended to `path`, no credential and no network. The
 * fallback channel for a headless install that cannot get a token: the wall and a JSONL record are
 * still a delivered notification, and `watcher test-alert` proves it without a vendor.
 */
export interface FileChannelConfig {
  id: string
  type: 'file'
  /** Where one JSON line per notification is appended. Default `.watcher/data/alerts.jsonl`, resolved against the project. */
  path?: string
}
export type ChannelConfig =
  | NtfyChannelConfig
  | WebPushChannelConfig
  | SmsChannelConfig
  | EmailChannelConfig
  | WebhookChannelConfig
  | FileChannelConfig

// ---- routes -----------------------------------------------------------------------------------------

export interface EscalationStep {
  /** Seconds the incident has been unattended (not acked, not silenced) before this step fires. */
  afterSec: number
  receivers: string[]
}

export interface RouteConfig {
  id: string
  /** All present matchers must match. */
  match: { severity?: Severity[]; origin?: string[]; labels?: Record<string, string> }
  /** Channel ids notified first. An empty list on purpose is a wall-only route: it matches, so later routes do not, and nobody is notified. */
  receivers: string[]
  /** 'ladder' sends to the first receiver that succeeds (3 s timeout, one retry), 'all' sends to every one. */
  mode: 'all' | 'ladder'
  /** Channels that always get a record of the notification and sit outside the ladder. */
  record?: string[]
  /** Alertmanager `continue`: keep matching later routes after this one matched. */
  continue?: boolean
  groupWaitSec: number
  groupIntervalSec: number
  repeatIntervalSec: number
  escalate?: EscalationStep[]
  /**
   * A page storm from one origin is told once, not page by page: more than `maxPages` page notifications from one origin inside `windowSec` are held
   * back, and one summary per window goes to the same receivers ("webhook: 15 more pages in 10 min, see the wall"). Absent: 10 pages in 600 s,
   * so a route written before this knob behaves as before for fewer than 10 pages. `maxPages: 0` switches it off for the route.
   */
  coalesce?: { maxPages?: number; windowSec?: number }
  /** Mute this route during quiet hours and send one digest when they end. Pages ignore quiet hours. */
  muteInQuietHours?: boolean
  sendResolved?: boolean
}

export interface QuietHoursConfig {
  /** IANA time zone, for example America/Chicago. */
  tz: string
  /** Local times, "22:00" and "07:00"; the interval may wrap midnight. */
  start: string
  end: string
  /** ISO weekdays 1..7 the interval applies on (the weekday the interval STARTS). Empty or absent = every day. */
  days?: number[]
}

export interface WatchConfig {
  /**
   * What this Watcher calls itself: the page title and header, the installed app, notification and email titles, the MCP server (src/shared/types.ts
   * Brand). Absent = `{ name: "EZO Watcher", shortName: "Watcher" }`. Read it with `brandOf`.
   */
  brand?: Brand
  /** Public base URL, used in links inside notifications. */
  baseUrl: string
  /**
   * Origins allowed to frame the embed view and read GET /api/summary and /api/incident-card (a chat panel, a dashboard). Exact origins, scheme and
   * host, no path. Absent: nobody may frame the page or read it cross-origin; WATCHER_EMBED_ORIGINS adds more, for a local proof.
   */
  embedOrigins?: string[]
  /** The port to listen on. Absent: `WATCHER_PORT`, else 7717. */
  port?: number
  /** The address to bind. Absent: `WATCHER_HOST`, else 127.0.0.1. */
  host?: string
  /** Where the SQLite file and other state live. Absent: `WATCHER_DATA_DIR`, else `.watcher/data`. */
  dataDir: string
  sources: SourceConfig[]
  serviceMap: ServiceRule[]
  /** Rules whose alerts group into one incident per label value instead of one per service and rule. Absent = none. */
  splitIncidents?: SplitRule[]
  /** Classes of resolved alert that must not leave an inferred rule cell on a quiet service tile. Absent = none. */
  inferredCellExclude?: ExcludedClass[]
  /** Classes of alert held below their own severity (dev environments: never a page). Absent = none: every alert keeps the severity its source sent. */
  severityCaps?: SeverityCap[]
  /**
   * The major categories the wall files its services under, in the order they are drawn: each a stable id, the heading's label and the service names it holds.
   * A service no group lists falls into "Other", which is always last. Defined here once: the state carries it to the wall (shared/wall-groups.ts).
   * Absent = no headings (the wall is one band of cells).
   */
  wallGroups?: WallGroupDef[]
  channels: ChannelConfig[]
  routes: RouteConfig[]
  quietHours: QuietHoursConfig | null
  historyHours: number
  /** Cells beyond this many missed polls mark a source stale. */
  staleAfterMisses: number
}

/**
 * The config as a value, checked: `{ ok: true, config }` or `{ ok: false, errors }` naming what is wrong. Pure: no file is read and nothing is mutated,
 * so the CLI can call it on a document before writing it. `loadConfig` reads a file, runs this and throws the first error.
 */
export function validateConfig(raw: unknown): { ok: true; config: WatchConfig } | { ok: false; errors: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['config: the top level must be a JSON object'] }
  try {
    const cfg = raw as WatchConfig
    for (const field of ['sources', 'channels', 'routes', 'serviceMap'] as const) {
      if (!Array.isArray(cfg[field])) throw new Error(`config: ${field} must be a list`)
    }
    const brand = brandProblems((cfg as { brand?: unknown }).brand)
    if (brand.length > 0) throw new Error(`config: ${brand.join('; ')}`)
    if (cfg.baseUrl !== undefined && typeof cfg.baseUrl !== 'string') throw new Error('config: baseUrl must be a string')
    for (const [field, v] of [['port', cfg.port], ['host', cfg.host]] as const) {
      if (v === undefined) continue
      if (field === 'port' && (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 65535)) throw new Error('config: port must be a whole number from 0 to 65535')
      if (field === 'host' && (typeof v !== 'string' || v.trim() === '')) throw new Error('config: host must be a hostname or address')
    }
    if (cfg.embedOrigins !== undefined) {
      if (!Array.isArray(cfg.embedOrigins)) throw new Error('config: embedOrigins must be a list of origins')
      for (const o of cfg.embedOrigins) {
        let u: URL
        try {
          u = new URL(o)
        } catch {
          throw new Error(`config: embedOrigins entry ${JSON.stringify(o)} is not an origin (scheme and host)`)
        }
        if (u.origin !== o || u.pathname !== '/') throw new Error(`config: embedOrigins entry ${JSON.stringify(o)} must be an origin: scheme and host only, no path`)
      }
    }
    const ids = new Set<string>()
    for (const c of [...cfg.sources, ...cfg.channels]) {
      if (typeof c?.id !== 'string' || c.id.trim() === '') throw new Error('config: every source and channel needs an id')
      if (ids.has(c.id)) throw new Error(`config: duplicate id ${c.id}`)
      ids.add(c.id)
    }
    const channelIds = new Set(cfg.channels.map((c) => c.id))
    for (const r of cfg.routes) {
      for (const id of [...r.receivers, ...(r.record ?? []), ...(r.escalate ?? []).flatMap((e) => e.receivers)]) {
        if (!channelIds.has(id)) throw new Error(`config: route ${r.id} names unknown channel ${id}`)
      }
      checkCoalesce(r)
    }
    for (const x of cfg.inferredCellExclude ?? []) if (x.origin === undefined && x.rule === undefined) throw new Error('config: inferredCellExclude entry needs an origin or a rule')
    for (const x of cfg.splitIncidents ?? []) if (!x.by) throw new Error('config: splitIncidents entry needs a `by` label')
    checkSeverityCaps((cfg as { severityCaps?: unknown }).severityCaps)
    for (const s of cfg.sources) if (s.type === 'vmalert' && !(s.pollSec > 0)) throw new Error(`config: source ${s.id} needs a pollSec above 0`)
    for (const s of cfg.sources) if (s.type === 'netdata-cloud') checkNetdataCloud(s)
    for (const s of cfg.sources) if (s.type === 'netdata-fleet') checkNetdataFleet(s)
    for (const s of cfg.sources) if (s.type === 'sentry') checkSentry(s)
    for (const s of cfg.sources) if (s.type === 'http-probe') checkHttpProbe(s)
    for (const s of cfg.sources) if (s.type === 'tcp-probe') checkTcpProbe(s)
    for (const s of cfg.sources) if (s.type === 'domain-expiry') checkDomainExpiry(s)
    for (const s of cfg.sources) if (s.type === 'feed') checkFeed(s)
    for (const s of cfg.sources) if (s.type === 'heartbeat') checkHeartbeat(s)
    for (const s of cfg.sources) if (s.type === 'host') checkHost(s)
    for (const s of cfg.sources) if (s.type === 'webhook') checkWebhookStale(s)
    for (const s of cfg.sources) checkOptional(s)
    for (const c of cfg.channels) if (c.type === 'file') checkFileChannel(c)
    for (const s of cfg.sources) checkNetdataHosts(s)
    for (const s of cfg.sources) checkRecheckRequests(s)
    for (const s of cfg.sources) checkWebhookVerify(s)
    checkWallGroups(cfg.wallGroups)
    return { ok: true, config: cfg }
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] }
  }
}

export function loadConfig(path: string): WatchConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const checked = validateConfig(raw)
  if (!checked.ok) throw new Error(checked.errors.join('; '))
  return checked.config
}

/** The config's brand with its defaults filled (src/shared/instance.ts): EZO Watcher when it names none, its name as the short name when it gives none. */
export function brandOf(cfg: Pick<WatchConfig, 'brand'>): Required<Brand> {
  return resolveBrand(cfg.brand)
}

/** `coalesce` of a route: an object whose `maxPages` is a whole number from 0 (off) to 1000 and whose `windowSec` is a whole number of seconds from 60 to 86400. */
function checkCoalesce(r: RouteConfig): void {
  const raw = (r as { coalesce?: unknown }).coalesce
  if (raw === undefined) return
  const where = `config: route ${r.id}`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${where}: coalesce must be an object with maxPages and windowSec`)
  const { maxPages, windowSec } = raw as { maxPages?: unknown; windowSec?: unknown }
  if (maxPages !== undefined && (typeof maxPages !== 'number' || !Number.isInteger(maxPages) || maxPages < 0 || maxPages > 1000)) {
    throw new Error(`${where}: coalesce.maxPages must be a whole number from 0 (off) to 1000`)
  }
  if (windowSec !== undefined && (typeof windowSec !== 'number' || !Number.isInteger(windowSec) || windowSec < 60 || windowSec > 86400)) {
    throw new Error(`${where}: coalesce.windowSec must be a whole number of seconds from 60 to 86400`)
  }
}

/**
 * `severityCaps`: a list whose every entry has a `match` naming at least one of origin, rule and labels, each a non-empty RegExp source that compiles (an empty
 * one would match every alert and cap the whole wall), a `max` of warning or info (a cap at page caps nothing), and a `note` of one line saying why.
 */
function checkSeverityCaps(raw: unknown): void {
  if (raw === undefined) return
  if (!Array.isArray(raw)) throw new Error('config: severityCaps must be a list')
  raw.forEach((cap: unknown, i) => {
    const where = `config: severityCaps[${i}]`
    if (typeof cap !== 'object' || cap === null || Array.isArray(cap)) throw new Error(`${where} must be an object with match, max and note`)
    const { match, max, note } = cap as { match?: unknown; max?: unknown; note?: unknown }
    if (typeof match !== 'object' || match === null || Array.isArray(match)) throw new Error(`${where}.match must be an object with origin, rule or labels`)
    const { origin, rule, labels } = match as { origin?: unknown; rule?: unknown; labels?: unknown }
    if (labels !== undefined && (typeof labels !== 'object' || labels === null || Array.isArray(labels))) throw new Error(`${where}.match.labels must be an object of label name to regular expression`)
    const named: Array<[string, unknown]> = [['origin', origin], ['rule', rule]]
    for (const [k, v] of Object.entries((labels ?? {}) as Record<string, unknown>)) named.push([`labels.${k}`, v])
    const sources = named.filter(([, v]) => v !== undefined)
    if (sources.length === 0) throw new Error(`${where}.match needs origin, rule or labels: an empty match would cap every alert`)
    for (const [field, src] of sources) {
      if (field === 'labels.') throw new Error(`${where}.match.labels names a label with an empty name`)
      if (typeof src !== 'string' || src === '') throw new Error(`${where}.match.${field} must be a non-empty regular expression`)
      try {
        new RegExp(src)
      } catch {
        throw new Error(`${where}.match.${field} is not a regular expression: ${JSON.stringify(src)}`)
      }
    }
    if (max !== 'warning' && max !== 'info') throw new Error(`${where}.max must be warning or info`)
    if (typeof note !== 'string' || note.trim() === '' || note.length > 300 || /[\r\n]/.test(note)) throw new Error(`${where}.note must be one line (at most 300 characters) saying why`)
  })
}

/**
 * `wallGroups`: every group has a unique id and label, none uses the reserved "Other", every group lists at least one service, and no service (compared without
 * case or separators) is in two groups or twice in one. A service no group lists is not an error: it falls into Other. With `known`, an id outside that set
 * is an error too (a typo: the live service would sit in Other and the dead name in a group); `loadConfig` cannot pass it because a label-derived tile
 * ("Ops errors") is named by a Grafana rule the config never sees, so test/wall-groups.test.ts checks its fixture groups against a `known` set it builds.
 */
export function checkWallGroups(groups: unknown, known?: ReadonlySet<string>): void {
  const problems = wallGroupProblems(groups, known)
  if (problems.length > 0) throw new Error(`config: ${problems.join('; ')}`)
}

/** Every service name the config itself can give a tile: the service map, the Sentry projects' tiles, the http-probe tiles, the Netdata groups' tiles and the one the Watcher raises itself. */
export function configServiceNames(cfg: Pick<WatchConfig, 'serviceMap' | 'sources'>): Set<string> {
  const names = new Set<string>(['Netdata', 'Watcher sources'])
  for (const r of cfg.serviceMap) names.add(r.service)
  for (const s of cfg.sources) {
    if (s.type === 'sentry') for (const tile of Object.values(s.projects ?? {})) names.add(tile)
    if (s.type === 'http-probe') for (const t of s.targets ?? []) names.add(t.service ?? s.id)
    if (s.type === 'tcp-probe') for (const t of s.targets ?? []) if (t.service) names.add(t.service)
    if (s.type === 'domain-expiry') names.add(s.service ?? s.id)
    if (s.type === 'netdata-cloud') for (const g of s.groups ?? []) if (g.service) names.add(g.service)
    if (s.type === 'heartbeat') if (s.service) names.add(s.service)
    if (s.type === 'host') names.add(s.service ?? s.id)
  }
  return names
}

/**
 * `netdata.grafanaDiskHosts` / `netdata.netdataHosts` of a webhook source, and `grafanaDiskHosts` of a netdata-cloud source: lists of hostnames. A list
 * that names anything that is not a hostname is a config error, never a silently dropped host.
 */
function checkNetdataHosts(s: SourceConfig): void {
  const lists: Array<[string, unknown]> = []
  if (s.type === 'webhook') {
    lists.push(['netdata.grafanaDiskHosts', s.netdata?.grafanaDiskHosts], ['netdata.netdataHosts', s.netdata?.netdataHosts])
  }
  if (s.type === 'netdata-cloud') lists.push(['grafanaDiskHosts', s.grafanaDiskHosts])
  for (const [field, list] of lists) {
    if (list === undefined) continue
    if (!Array.isArray(list) || list.some((n) => typeof n !== 'string' || !HOSTNAME.test(n))) throw new Error(`config: source ${s.id}: ${field} must be a list of hostnames`)
  }
}

/**
 * `verify` of a webhook source: a scheme of github, stripe or hmac-sha256, a `secretEnv` naming an environment variable, and, for hmac-sha256 only, a
 * `header` the sender signs into. A webhook source needs a Bearer token or a verify block (a source with neither has no credential at all); a source
 * with both accepts either. The token env var must be a name, never a value.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const VERIFY_HEADER = /^[A-Za-z0-9-]{1,64}$/
const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'content-length', 'host', 'cookie', 'connection', 'transfer-encoding'])
function checkWebhookVerify(s: SourceConfig): void {
  const raw = (s as { verify?: unknown }).verify
  const where = `config: source ${s.id}`
  if (raw === undefined) {
    if (s.type === 'webhook' && (typeof s.tokenEnv !== 'string' || s.tokenEnv.trim() === '')) {
      throw new Error(`${where} needs a tokenEnv, or a verify block naming the env var that holds its signing secret`)
    }
    return
  }
  if (s.type !== 'webhook') throw new Error(`${where}: verify is only for a webhook source, the one a sender pushes to`)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${where}: verify must be an object with scheme and secretEnv`)
  const { scheme, secretEnv, header } = raw as { scheme?: unknown; secretEnv?: unknown; header?: unknown }
  if (scheme !== 'github' && scheme !== 'stripe' && scheme !== 'hmac-sha256') throw new Error(`${where}: verify.scheme must be github, stripe or hmac-sha256`)
  if (typeof secretEnv !== 'string' || !ENV_NAME.test(secretEnv)) throw new Error(`${where}: verify.secretEnv must name an environment variable`)
  if (header !== undefined) {
    if (scheme !== 'hmac-sha256') throw new Error(`${where}: verify.header is only for scheme hmac-sha256; ${scheme} fixes its own header`)
    if (typeof header !== 'string' || !VERIFY_HEADER.test(header)) throw new Error(`${where}: verify.header must be a header name such as X-Signature-256`)
    if (RESERVED_HEADERS.has(header.toLowerCase())) throw new Error(`${where}: verify.header may not be ${header}: the request itself uses it`)
  }
  if (s.tokenEnv !== undefined && (typeof s.tokenEnv !== 'string' || !ENV_NAME.test(s.tokenEnv))) throw new Error(`${where}: tokenEnv must name an environment variable when it is given`)
}

/** `recheckRequests` of a webhook source: an object with `pickupWithinSec`, a whole number of seconds from 30 to 3600. No other source type takes it. */
export const PICKUP_MIN_SEC = 30
export const PICKUP_MAX_SEC = 3600
function checkRecheckRequests(s: SourceConfig): void {
  const raw = (s as { recheckRequests?: unknown }).recheckRequests
  if (raw === undefined) return
  const where = `config: source ${s.id}`
  if (s.type !== 'webhook') throw new Error(`${where}: recheckRequests is only for a webhook source, the one that pushes alerts`)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${where}: recheckRequests must be an object with pickupWithinSec`)
  const sec = (raw as { pickupWithinSec?: unknown }).pickupWithinSec
  if (typeof sec !== 'number' || !Number.isInteger(sec) || sec < PICKUP_MIN_SEC || sec > PICKUP_MAX_SEC) {
    throw new Error(`${where}: recheckRequests.pickupWithinSec must be a whole number of seconds from ${PICKUP_MIN_SEC} to ${PICKUP_MAX_SEC}`)
  }
}

/**
 * Where a request may go in the clear: a loopback, RFC 1918 or 100.64.0.0/10 (the tailnet's CGNAT range) address written as an IP, or `localhost`. A
 * name is never enough, since what it resolves to is not known here. Everything else is https only.
 */
export function plainHttpAllowed(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

/** True for an https URL, or an http one whose host `plainHttpAllowed`; false for anything that does not parse or has a user or password in it. */
export function probeUrlAllowed(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  try {
    const u = new URL(raw)
    if (u.username !== '' || u.password !== '') return false
    return u.protocol === 'https:' || (u.protocol === 'http:' && plainHttpAllowed(u.hostname))
  } catch {
    return false
  }
}

/** A DNS label: letters and digits, with dashes inside, 1 to 63 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

/** A host a TCP probe can dial: an IP address (IPv6 may be bracketed) or a DNS name, with no scheme, port, path or credentials. */
export function tcpHostAllowed(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim() !== raw || raw === '') return false
  if (isIP(raw.replace(/^\[|\]$/g, '')) !== 0) return true
  if (raw.length > 253) return false
  return raw.split('.').every((label) => LABEL.test(label))
}

/** A registrable domain name: at least two labels, no scheme, port or path. Case is not significant; the poll lowercases it. */
export function domainNameAllowed(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim() !== raw || raw.length > 253) return false
  const labels = raw.split('.')
  return labels.length >= 2 && labels.every((label) => LABEL.test(label))
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** How many `expectJson` paths a target may assert: with the status predicate, a cell's `asserts` list holds 20 at most (sources/checks.ts MAX_ASSERTS). */
const MAX_EXPECT_JSON = 19
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
const wholeIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi

function checkHttpProbe(s: HttpProbeSourceConfig): void {
  const where = `config: source ${s.id}`
  if (s.pollSec !== undefined && !positive(s.pollSec)) throw new Error(`${where}: pollSec must be a number of seconds above 0`)
  if (s.failAfter !== undefined && !wholeIn(s.failAfter, 1, 20)) throw new Error(`${where}: failAfter must be a whole number of polls from 1 to 20`)
  if (!Array.isArray(s.targets) || s.targets.length === 0) throw new Error(`${where} needs targets, a list of URLs to probe`)
  const ids = new Set<string>()
  for (const [i, t] of s.targets.entries()) {
    const at = `${where}: targets[${i}]`
    if (typeof t !== 'object' || t === null) throw new Error(`${at} must be an object with id, service and url`)
    if (typeof t.id !== 'string' || !SAFE_ID.test(t.id)) throw new Error(`${at}.id must be letters, digits, dots, dashes and underscores, at most 64`)
    if (ids.has(t.id)) throw new Error(`${at}.id ${t.id} is used twice`)
    ids.add(t.id)
    if (t.service !== undefined && (typeof t.service !== 'string' || t.service.trim() === '')) throw new Error(`${at}.service must name the wall tile its alerts land on`)
    if (!probeUrlAllowed(t.url)) throw new Error(`${at}.url must be https, or http to a loopback, RFC 1918 or 100.64.0.0/10 address, with no credentials in it`)
    if (t.expectStatus !== undefined && !wholeIn(t.expectStatus, 100, 599)) throw new Error(`${at}.expectStatus must be an HTTP status from 100 to 599`)
    if (t.expectJson !== undefined) {
      if (typeof t.expectJson !== 'object' || t.expectJson === null || Array.isArray(t.expectJson)) throw new Error(`${at}.expectJson must be an object of dotted path to the value it must equal`)
      const paths = Object.entries(t.expectJson)
      if (paths.length > MAX_EXPECT_JSON) throw new Error(`${at}.expectJson holds more than ${MAX_EXPECT_JSON} paths`)
      for (const [path, want] of paths) {
        if (path === '' || path.split('.').some((p) => p === '')) throw new Error(`${at}.expectJson has a path with an empty segment`)
        if (!['string', 'number', 'boolean'].includes(typeof want)) throw new Error(`${at}.expectJson.${path} must be a string, a number or true or false`)
      }
    }
    if (t.timeoutMs !== undefined && !wholeIn(t.timeoutMs, 100, 60_000)) throw new Error(`${at}.timeoutMs must be a whole number of ms from 100 to 60000`)
    if (t.slowMs !== undefined && (!positive(t.slowMs) || t.slowMs >= (t.timeoutMs ?? 10_000))) throw new Error(`${at}.slowMs must be a number of ms above 0 and under timeoutMs`)
    const warn = t.certWarnDays ?? 14
    const page = t.certPageDays ?? 3
    if (!positive(warn) || typeof page !== 'number' || !Number.isFinite(page) || page < 0 || page > warn) throw new Error(`${at}: certPageDays must be 0 or more and at most certWarnDays, which is above 0`)
  }
  checkDiscovered(s.discovered, where)
}

/**
 * `discovered`, a source's record of where its endpoint was found: `foundAt` is required and one line, `read` is one optional line of what was read
 * there, `at` is an optional ISO time. Accepted on the kinds that read an endpoint or a schedule from the project (http-probe, tcp-probe, heartbeat,
 * domain-expiry). It is provenance only (a warning when absent, source.untraced); it never gates.
 */
export function checkDiscovered(raw: unknown, where: string): void {
  if (raw === undefined) return
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${where}: discovered must be an object with foundAt`)
  const { foundAt, read, at } = raw as { foundAt?: unknown; read?: unknown; at?: unknown }
  if (typeof foundAt !== 'string' || foundAt.trim() === '' || foundAt.length > 200 || /[\r\n]/.test(foundAt)) {
    throw new Error(`${where}: discovered.foundAt must be one line of at most 200 characters saying where the endpoint was found`)
  }
  if (read !== undefined && (typeof read !== 'string' || read.trim() === '' || read.length > 300 || /[\r\n]/.test(read))) {
    throw new Error(`${where}: discovered.read must be one line of at most 300 characters saying what was read there`)
  }
  if (at !== undefined) {
    const ms = typeof at === 'string' ? Date.parse(at) : Number.NaN
    if (!Number.isFinite(ms) || ms <= 0) throw new Error(`${where}: discovered.at must be an ISO time`)
  }
}

/**
 * A heartbeat source (src/server/sources/heartbeat.ts): one scheduled job, one source. The adapter owns the schedule parsing, so this is one call; the first
 * problem is thrown with the source named, as every other checker does.
 */
function checkHeartbeat(s: HeartbeatSourceConfig): void {
  const problems = heartbeatProblems(s)
  if (problems.length > 0) throw new Error(`config: source ${s.id}: ${problems[0]}`)
  checkDiscovered(s.discovered, `config: source ${s.id}`)
}

/**
 * A host source (src/server/sources/host.ts): one machine, read with node:os and fs.statfs. The adapter owns the threshold arithmetic, so this is one
 * call; the first problem is thrown with the source named, as every other checker does.
 */
function checkHost(s: HostSourceConfig): void {
  const problems = hostProblems(s)
  if (problems.length > 0) throw new Error(`config: source ${s.id}: ${problems[0]}`)
}

/**
 * A webhook source's promise of a schedule: `staleAfterSec` is a positive number of seconds, and `staleSeverity` is page or warning and only means
 * something with that promise. A source that names a severity but never reads stale is refused rather than silently ignored.
 */
function checkWebhookStale(s: WebhookSourceConfig): void {
  const where = `config: source ${s.id}`
  if (s.staleAfterSec !== undefined && !(typeof s.staleAfterSec === 'number' && Number.isFinite(s.staleAfterSec) && s.staleAfterSec > 0)) {
    throw new Error(`${where}: staleAfterSec must be a number of seconds above 0`)
  }
  if (s.staleSeverity !== undefined) {
    if (s.staleSeverity !== 'page' && s.staleSeverity !== 'warning') throw new Error(`${where}: staleSeverity must be page or warning`)
    if (s.staleAfterSec === undefined) throw new Error(`${where}: staleSeverity needs staleAfterSec, the schedule it is judged against`)
  }
}

/**
 * `optional` on a source (`watcher add … --optional`): its credential may be absent on this host without
 * failing `watcher doctor`. The field is a boolean; a source without it is required.
 */
function checkOptional(s: SourceConfig): void {
  const optional = (s as unknown as Record<string, unknown>).optional
  if (optional !== undefined && typeof optional !== 'boolean') throw new Error(`config: source ${s.id}: optional must be true or false`)
}

/**
 * A `file` channel's path: one line, at most 500 characters. The default (`.watcher/data/alerts.jsonl`) is
 * filled by the channel itself, so an absent path is the documented default, not an error.
 */
function checkFileChannel(c: FileChannelConfig): void {
  const where = `config: channel ${c.id}`
  if (c.path === undefined) return
  if (typeof c.path !== 'string' || c.path.trim() === '') throw new Error(`${where}: path must be a file path`)
  if (c.path.length > 500) throw new Error(`${where}: path must be at most 500 characters`)
  if (/[\u0000-\u001f\u007f]/.test(c.path)) throw new Error(`${where}: path must be one line`)
}

function checkTcpProbe(s: TcpProbeSourceConfig): void {
  const where = `config: source ${s.id}`
  if (s.pollSec !== undefined && !positive(s.pollSec)) throw new Error(`${where}: pollSec must be a number of seconds above 0`)
  if (!Array.isArray(s.targets) || s.targets.length === 0) throw new Error(`${where} needs targets, a list of host and port pairs to connect to`)
  const ids = new Set<string>()
  for (const [i, t] of s.targets.entries()) {
    const at = `${where}: targets[${i}]`
    if (typeof t !== 'object' || t === null) throw new Error(`${at} must be an object with id, service, host and port`)
    if (typeof t.id !== 'string' || !SAFE_ID.test(t.id)) throw new Error(`${at}.id must be letters, digits, dots, dashes and underscores, at most 64`)
    if (ids.has(t.id)) throw new Error(`${at}.id ${t.id} is used twice`)
    ids.add(t.id)
    if (typeof t.service !== 'string' || t.service.trim() === '') throw new Error(`${at}.service must name the wall tile its alerts land on`)
    if (!tcpHostAllowed(t.host)) throw new Error(`${at}.host must be a hostname or IP address, without a scheme, port or path`)
    if (!wholeIn(t.port, 1, 65_535)) throw new Error(`${at}.port must be a whole number from 1 to 65535`)
    if (t.tls !== undefined && typeof t.tls !== 'boolean') throw new Error(`${at}.tls must be true or false`)
    if (t.timeoutMs !== undefined && !wholeIn(t.timeoutMs, 100, 60_000)) throw new Error(`${at}.timeoutMs must be a whole number of ms from 100 to 60000`)
    if (t.slowMs !== undefined && (!positive(t.slowMs) || t.slowMs >= (t.timeoutMs ?? 10_000))) throw new Error(`${at}.slowMs must be a number of ms above 0 and under timeoutMs`)
    if (t.failAfter !== undefined && !wholeIn(t.failAfter, 1, 20)) throw new Error(`${at}.failAfter must be a whole number of polls from 1 to 20`)
    if ((t.certWarnDays !== undefined || t.certPageDays !== undefined) && t.tls !== true) throw new Error(`${at}: certWarnDays and certPageDays are only for a tls target`)
    const warn = t.certWarnDays ?? 14
    const page = t.certPageDays ?? 3
    if (!positive(warn) || typeof page !== 'number' || !Number.isFinite(page) || page < 0 || page > warn) throw new Error(`${at}: certPageDays must be 0 or more and at most certWarnDays, which is above 0`)
  }
  checkDiscovered(s.discovered, where)
}

function checkDomainExpiry(s: DomainExpirySourceConfig): void {
  const where = `config: source ${s.id}`
  if (s.pollSec !== undefined && !positive(s.pollSec)) throw new Error(`${where}: pollSec must be a number of seconds above 0`)
  if (s.service !== undefined && (typeof s.service !== 'string' || s.service.trim() === '')) throw new Error(`${where}: service must name the wall tile its alerts land on`)
  const warn = s.warnDays ?? 30
  const page = s.pageDays ?? 7
  if (!positive(warn) || typeof page !== 'number' || !Number.isFinite(page) || page < 0 || page > warn) throw new Error(`${where}: pageDays must be 0 or more and at most warnDays, which is above 0`)
  if (!Array.isArray(s.domains) || s.domains.length === 0) throw new Error(`${where} needs domains, a list of domain names to look up`)
  const seen = new Set<string>()
  for (const [i, d] of s.domains.entries()) {
    if (!domainNameAllowed(d)) throw new Error(`${where}: domains[${i}] must be a domain name such as example.com, without a scheme or path`)
    if (seen.has(d.toLowerCase())) throw new Error(`${where}: domains[${i}] ${d} is listed twice`)
    seen.add(d.toLowerCase())
  }
  checkDiscovered(s.discovered, where)
}

function checkFeed(s: FeedSourceConfig): void {
  const where = `config: source ${s.id}`
  if (!probeUrlAllowed(s.url)) throw new Error(`${where} needs a url that is https, or http to a loopback, RFC 1918 or 100.64.0.0/10 address (the bearer token is sent there)`)
  if (typeof s.tokenEnv !== 'string' || s.tokenEnv === '') throw new Error(`${where} needs a tokenEnv, the env var that holds the feed's bearer token`)
  if (s.origin !== undefined && (typeof s.origin !== 'string' || !SAFE_ID.test(s.origin))) throw new Error(`${where}: origin must be letters, digits, dots, dashes and underscores, at most 64`)
  if (s.pollSec !== undefined && !positive(s.pollSec)) throw new Error(`${where}: pollSec must be a number of seconds above 0`)
  if (s.timeoutMs !== undefined && !wholeIn(s.timeoutMs, 100, 60_000)) throw new Error(`${where}: timeoutMs must be a whole number of ms from 100 to 60000`)
}

function checkSentry(s: SentrySourceConfig): void {
  const where = `config: source ${s.id}`
  if (!(s.pollSec > 0)) throw new Error(`${where} needs a pollSec above 0`)
  if (!s.org) throw new Error(`${where} needs an org`)
  for (const [field, value] of [['url', s.url], ['webUrl', s.webUrl]] as const) {
    try {
      const u = new URL(value)
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('not https')
    } catch {
      throw new Error(`${where} needs an https ${field}${field === 'url' ? ' (the bearer token is sent there)' : ''}`)
    }
  }
  const projects = Object.entries(s.projects ?? {})
  if (projects.length === 0) throw new Error(`${where} needs projects, a map of Sentry project slug to tile name`)
  for (const [slug, tile] of projects) if (!slug || typeof tile !== 'string' || tile.trim() === '') throw new Error(`${where}: projects.${slug} must name a tile`)
  try {
    new RegExp(s.devReleases ?? '-dev\\.|\\.dev@')
  } catch {
    throw new Error(`${where}: devReleases is not a regular expression`)
  }
  const warn = s.crashFreeWarnBelow ?? 0.98
  const page = s.crashFreePageBelow ?? 0.95
  if (!(page > 0 && page <= warn && warn <= 1)) throw new Error(`${where}: crashFreePageBelow must be above 0 and at most crashFreeWarnBelow, which is at most 1`)
  for (const [field, v] of [['quietAfterSec', s.quietAfterSec], ['pageEventsPerHour', s.pageEventsPerHour], ['pageUsers', s.pageUsers], ['crashFreeMinSessions', s.crashFreeMinSessions]] as const) {
    if (v !== undefined && !(typeof v === 'number' && v > 0)) throw new Error(`${where}: ${field} must be a number above 0`)
  }
}

/**
 * `ignoreNodes` of a Netdata source: an object of node name to the one-line reason it is not watched. A node that is also named in a list the source
 * reads (`others`) or in `nodes` would be both watched and not, so that is an error naming both.
 */
function checkIgnoreNodes(ignore: unknown, others: ReadonlyArray<readonly [string, readonly string[] | undefined]>, where: string, notes?: Record<string, unknown>): void {
  if (ignore === undefined) return
  if (typeof ignore !== 'object' || ignore === null || Array.isArray(ignore)) throw new Error(`${where}: ignoreNodes must be an object of node name to a one-line reason`)
  for (const [name, reason] of Object.entries(ignore)) {
    if (name.trim() === '') throw new Error(`${where}: ignoreNodes has an entry that names a node with an empty name`)
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 300 || /[\r\n]/.test(reason)) throw new Error(`${where}: ignoreNodes.${name} must be one line (at most 300 characters) saying why`)
    for (const [field, list] of others) {
      if ((list ?? []).some((n) => n.toLowerCase() === name.toLowerCase())) throw new Error(`${where}: ${name} is in ignoreNodes and in ${field}; pick one`)
    }
    if (notes && Object.keys(notes).some((n) => n.toLowerCase() === name.toLowerCase())) throw new Error(`${where}: ${name} is in ignoreNodes and has an entry in nodes; delete the entry`)
  }
}

function checkNetdataFleet(s: NetdataFleetSourceConfig): void {
  const where = `config: source ${s.id}`
  if (!(s.pollSec > 0)) throw new Error(`${where} needs a pollSec above 0`)
  if (!s.spaceId || !s.roomId) throw new Error(`${where} needs a spaceId and a roomId`)
  if (!Array.isArray(s.fleetNodes) || s.fleetNodes.length === 0 || s.fleetNodes.some((n) => typeof n !== 'string' || n === '')) throw new Error(`${where} needs fleetNodes, a list of hostnames`)
  for (const [field, list] of [['watchOnlyNodes', s.watchOnlyNodes], ['k8sNodes', s.k8sNodes]] as const) {
    if (list !== undefined && (!Array.isArray(list) || list.some((n) => typeof n !== 'string' || n === ''))) throw new Error(`${where}: ${field} must be a list of hostnames`)
  }
  checkIgnoreNodes(s.ignoreNodes, [['fleetNodes', s.fleetNodes], ['watchOnlyNodes', s.watchOnlyNodes], ['k8sNodes', s.k8sNodes]], where)
  try {
    const u = new URL(s.url)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('not https')
  } catch {
    throw new Error(`${where} needs an https url (the bearer token is sent there)`)
  }
  const window = s.windowMin ?? 60
  if (!Number.isInteger(window) || window < 20 || window > 180) throw new Error(`${where}: windowMin must be a whole number of minutes from 20 to 180`)
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
  const rules = s.rules ?? {}
  for (const [name, r] of [['cpu', rules.cpu], ['memory', rules.memory], ['load', rules.load]] as const) {
    if (r === undefined) continue
    if (!num(r.warnAbove) || !num(r.clearBelow) || !num(r.forMin)) throw new Error(`${where}: rules.${name} needs warnAbove, clearBelow and forMin, all numbers above 0`)
    if (r.clearBelow >= r.warnAbove) throw new Error(`${where}: rules.${name}.clearBelow must be under warnAbove, or the rule flaps on the line`)
    if (!Number.isInteger(r.forMin) || r.forMin > window) throw new Error(`${where}: rules.${name}.forMin must be a whole number of minutes, at most windowMin (${window})`)
  }
  if (rules.coldCpuBelow !== undefined && !(num(rules.coldCpuBelow) && rules.coldCpuBelow < 100)) throw new Error(`${where}: rules.coldCpuBelow must be a percent above 0 and under 100`)
  if (rules.memory) {
    const m = rules.memory
    if (!num(m.pageAbove) || !num(m.pageClearBelow)) throw new Error(`${where}: rules.memory needs pageAbove and pageClearBelow, numbers above 0`)
    if (m.pageAbove < m.warnAbove) throw new Error(`${where}: rules.memory.pageAbove must not be under warnAbove`)
    if (m.pageClearBelow >= m.pageAbove) throw new Error(`${where}: rules.memory.pageClearBelow must be under pageAbove`)
  }
}

/** A DNS name: letters, digits, dots and dashes, starting and ending with a letter or digit. One pass, no nested quantifier. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i

function checkNetdataCloud(s: NetdataCloudSourceConfig): void {
  const where = `config: source ${s.id}`
  if (!(s.pollSec > 0)) throw new Error(`${where} needs a pollSec above 0`)
  if (!s.spaceId || !s.roomId) throw new Error(`${where} needs a spaceId and a roomId`)
  if (!Array.isArray(s.fleetNodes) || s.fleetNodes.some((n) => typeof n !== 'string' || n === '')) throw new Error(`${where} needs fleetNodes, a list of hostnames`)
  try {
    const u = new URL(s.url)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('not https')
  } catch {
    throw new Error(`${where} needs an https url (the bearer token is sent there)`)
  }
  if (s.watchOnlyNodes !== undefined && (!Array.isArray(s.watchOnlyNodes) || s.watchOnlyNodes.some((n) => typeof n !== 'string' || n === ''))) throw new Error(`${where}: watchOnlyNodes must be a list of hostnames`)
  checkIgnoreNodes(s.ignoreNodes, [['fleetNodes', s.fleetNodes], ['watchOnlyNodes', s.watchOnlyNodes]], where, s.nodes)
  for (const [name, n] of Object.entries(s.nodes ?? {})) {
    if (name.trim() === '') throw new Error(`${where}: nodes has an entry that names a node with an empty name`)
    if (typeof n !== 'object' || n === null || Array.isArray(n)) throw new Error(`${where}: nodes.${name} must be an object with dns and note`)
    if (n.dns !== undefined && (typeof n.dns !== 'string' || !HOSTNAME.test(n.dns))) throw new Error(`${where}: nodes.${name}.dns must be a hostname such as print.example.com`)
    if (n.note !== undefined && (typeof n.note !== 'string' || n.note.length > 600)) throw new Error(`${where}: nodes.${name}.note must be text of at most 600 characters`)
  }
  const floor = s.diskWarningFloor
  if (floor !== undefined) {
    if (typeof floor !== 'object' || floor === null || Array.isArray(floor)) throw new Error(`${where}: diskWarningFloor must be an object with usedPct and note`)
    if (typeof floor.usedPct !== 'number' || !Number.isFinite(floor.usedPct) || floor.usedPct < 0 || floor.usedPct > 100) throw new Error(`${where}: diskWarningFloor.usedPct must be a percent from 0 to 100`)
    if (typeof floor.note !== 'string' || floor.note.trim() === '' || floor.note.length > 300 || /[\r\n]/.test(floor.note)) throw new Error(`${where}: diskWarningFloor.note must be one line (at most 300 characters) saying why`)
  }
  for (const r of s.ignoreInstances ?? []) {
    for (const src of [r.instance, r.node]) {
      if (src === undefined) continue
      try {
        new RegExp(src)
      } catch {
        throw new Error(`${where}: ignoreInstances has a bad regular expression ${JSON.stringify(src)}`)
      }
    }
  }
  const ids = new Set<string>()
  for (const g of s.groups ?? []) {
    if (!g.id || ids.has(g.id)) throw new Error(`${where}: groups need unique ids`)
    ids.add(g.id)
    if (!g.contexts?.length || g.contexts.some((c) => c.trim() === '*')) throw new Error(`${where}: group ${g.id} needs contexts, and never "*" (a whole-room query is tens of megabytes)`)
    if (!g.alerts?.length) throw new Error(`${where}: group ${g.id} needs alerts`)
  }
}

/** Read an env var by the name a config field holds. A missing secret is an error, never a silent blank. */
export function secret(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]
  if (!v) throw new Error(`missing environment variable ${name}`)
  return v
}
