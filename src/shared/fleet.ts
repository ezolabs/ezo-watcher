// The contract of GET /api/fleet: what the fleet view reads. Server (src/server/sources/netdata-fleet.ts) and client share it; src/shared/types.ts
// re-exports it, so the web code can import either.
//
// One snapshot of every node in the Netdata Cloud room, refreshed by the `netdata-fleet` pull source every 60 s and held in memory
// (nothing is stored: a restart refills it on the first poll). Units: cpu, mem and disk are percent (0 to 100), load figures are the
// Linux load average, `loadPerCore` is load5 divided by the node's cores, byte figures are bytes. A figure Cloud did not report is null, never 0.

export type FleetRole = 'fleet' | 'watch-only' | 'k8s'

/** What the fleet page calls each role: the servers, the machines Watch only looks at, and the Kubernetes state collector (not a host). */
export type FleetGroup = 'servers' | 'watch only' | 'k8s'

/** The three Watch rules built on this data; ids are stable (they are part of the check-list cell ids). */
export type FleetRuleId = 'cpu-hot' | 'memory-hot' | 'load-high'

/**
 * How hot a node runs, from the same thresholds as the alerts (config `rules`):
 *  - hot:     a fleet rule is firing, or (watch-only node) a reading is over a rule's warnAbove now;
 *  - warm:    not hot, but a reading is at or over a rule's clearBelow line (the band under the trigger);
 *  - cold:    not hot or warm and the 10-minute CPU average is under `rules.coldCpuBelow` (default 10 %);
 *  - ok:      everything else;
 *  - unknown: no figures (the node did not answer, or it is not a host).
 */
export type FleetHeat = 'hot' | 'warm' | 'ok' | 'cold' | 'unknown'

/**
 * How full a disk is, on its own scale (never the node's CPU and memory `FleetHeat`): `ok` under 80 % used, `warm` from 80 to under 90, `hot` from
 * 90, `unknown` with no reading. The same line as the disk warning floor: nothing warns under 80 %.
 */
export type FleetDiskHeat = 'ok' | 'warm' | 'hot' | 'unknown'

/** Where a disk turns warm and hot, in percent used. */
export const DISK_WARM_AT = 80
export const DISK_HOT_AT = 90

/** A used percent, read to one decimal as the page shows it, against the two lines: 79.9 is ok, 80 is warm, 90 is hot. */
export function diskHeatOf(usedPct: number | null): FleetDiskHeat {
  if (usedPct === null || !Number.isFinite(usedPct)) return 'unknown'
  const shown = Math.round(usedPct * 10) / 10
  return shown >= DISK_HOT_AT ? 'hot' : shown >= DISK_WARM_AT ? 'warm' : 'ok'
}

/** A fleet rule that is firing on a node right now (fleet nodes only). */
export interface FleetNodeRule {
  id: FleetRuleId
  /** The alert name: HostCpuHot, HostMemoryHot, HostLoadHigh. */
  alertname: string
  level: 'warning' | 'page'
  /** ISO. When the rule's condition began (the minute whose window first crossed the threshold). */
  since: string
  /** What the rule read: "83.4% averaged over 10 min". */
  value: string
}

/** The last `windowMin` minutes, one point a minute, oldest first. Every array has the same length as the others. */
export interface FleetSeries {
  /** Epoch seconds of the first point (a point is the average of the minute that ends there). */
  from: number
  stepSec: number
  cpu: Array<number | null>
  mem: Array<number | null>
  /** load5 / cores. */
  loadPerCore: Array<number | null>
  disk: Array<number | null>
}

/** One mount of a node that matters: `/` always, and any other real filesystem of at least 50 GiB (the filter is `keepMount`, netdata-fleet.ts). */
export interface FleetMount {
  /** The mount point: `/`, `/data/ssd1`, `/Volumes/Backup`. */
  path: string
  /** The filesystem Netdata reports for it (ext4, xfs, apfs), or an empty string when it reports none. */
  fs: string
  /** Used percent of used + available, to one decimal: the figure `df` calls Use% and the one Netdata's own disk alert reads. */
  usedPct: number | null
  usedBytes: number | null
  /** Available to a normal user (the `avail` dimension): what `df` calls Avail. */
  freeBytes: number | null
  /** Size as `df` counts it: used + available + the share reserved for root. Netdata's own alert text says "free of" this figure. */
  sizeBytes: number | null
  /** `usedPct` for every minute of the window, oldest first, null for a minute with no reading; as long as `FleetSeries.cpu`. */
  series: Array<number | null>
  heat: FleetDiskHeat
}

export interface FleetNode {
  /** The name Netdata Cloud gives the node: node-13, mac-a1.example.net. */
  name: string
  role: FleetRole
  group: FleetGroup
  /** Netdata Cloud's state for the node: reachable, unreachable, stale ... */
  state: string
  /** The node answered the metrics query this poll. When false every figure below is null and the series are empty. */
  live: boolean
  /** ISO, the newest data point of this node; null when it has none. */
  updatedAt: string | null
  /** No fresh data: the node did not answer, or its newest point is older than three poll intervals. The figures are old or absent. */
  stale: boolean
  heat: FleetHeat
  cores: number | null
  /** Installed RAM in bytes (Netdata host label). */
  ramBytes: number | null
  /** The agent's version, v2.12.1. */
  version: string
  /** CPU busy percent: every dimension of system.cpu but idle, the latest one-minute average. */
  cpu: number | null
  /** CPU averaged over the last 10 minutes: the figure HostCpuHot reads. */
  cpu10: number | null
  /** Memory in use percent: 100 - mem.available / RAM on Linux. */
  mem: number | null
  load1: number | null
  load5: number | null
  load15: number | null
  /** load5 / cores. HostLoadHigh reads it. */
  loadPerCore: number | null
  /** Root filesystem (`/`) used percent: used / (used + available). Kept for readers of the old view; `mounts` has every mount that matters. */
  disk: number | null
  /** The mounts that matter, the fullest first (a node's `/` leads a tie): empty when the node reported no disk. `mounts[0]` is what the page and the strip show. */
  mounts: FleetMount[]
  /** The worst mount's heat. `heat` above is CPU, memory and load only; a hot disk never makes a node `hot`. */
  diskHeat: FleetDiskHeat
  series: FleetSeries
  /** Fleet rules firing on this node now. Always empty for a watch-only or k8s node (rules cover fleet nodes only). */
  rules: FleetNodeRule[]
  /** The node's page in Netdata Cloud, when the node id is known. */
  url?: string
}

/** The thresholds the rules use, as configured, so a view can draw them. */
export interface FleetThresholds {
  cpu: { warnAbove: number; clearBelow: number; forMin: number }
  memory: { warnAbove: number; clearBelow: number; pageAbove: number; pageClearBelow: number; forMin: number }
  load: { warnAbove: number; clearBelow: number; forMin: number }
  /** A node whose 10-minute CPU average is under this and that is not warm or hot reads `cold`. */
  coldCpuBelow: number
  /** Where a disk turns warm and hot, percent used (the constants above; not configurable). */
  disk: { warmAt: number; hotAt: number }
}

export interface FleetSummary {
  /** Hosts counted: every node whose role is fleet or watch-only (the k8s state collector is not a host). */
  nodes: number
  servers: number
  watchOnly: number
  /** Hosts with figures this poll. */
  live: number
  hot: number
  warm: number
  cold: number
  /** The host with the highest CPU now (live hosts only), or null. */
  hottest: { name: string; cpu: number } | null
  /** Mean CPU percent over the live fleet servers, or null. */
  fleetCpuAvg: number | null
}

export interface FleetView {
  /** ISO, when this response was made. */
  generatedAt: string
  /** ISO, the newest data point behind the snapshot; null before the first successful poll. */
  dataAt: string | null
  /** Seconds since the last successful poll, null before the first. */
  ageSec: number | null
  pollSec: number
  /** No successful poll for three intervals: the figures are old. Every node is then stale too. */
  stale: boolean
  /** The last failed poll's message (never a token), null when the last poll worked. */
  error: string | null
  windowMin: number
  stepSec: number
  thresholds: FleetThresholds
  summary: FleetSummary
  /** Fleet servers first (by name, numerically), then watch-only, then k8s. */
  nodes: FleetNode[]
  /** Link to the room in Netdata Cloud. */
  cloudUrl?: string
}
