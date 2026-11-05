// Netdata Cloud source: Watch polls Netdata Cloud's API for what Netdata's own alerts say, over outbound HTTPS only (the Watch
// host's firewall is a per-source allowlist, so Cloud's webhook cannot reach it; a poll needs no rule).
//
// Two calls, both authenticated with a Netdata Cloud API token (scope:grafana-plugin, read-only data), docs fetched 2026-10-15:
//  - GET  /api/v2/spaces/{space}/rooms/{room}/nodes     the room's nodes: name, state (`reachable`), agent version, alarmCounters.
//  - POST /api/v3/spaces/{space}/rooms/{room}/data      Netdata Cloud's data query (https://app.netdata.cloud/api/docs/, operation
//    post-scope-data). Cloud documents NO endpoint that lists alerts (GET /api/v2/alerts answers 404 with this token), so alert
//    states are read through this query's alert selector (`name:WARNING`, `name:CRITICAL`: "the combination of name:status") and its
//    `summary`: `summary.instances[]` (ds.sl > 0 = selected = in one of the asked states; al = that instance's alert counters),
//    `summary.alerts[]` (counters per alert name over the whole scope), `summary.nodes[]` (st.code 200 = the agent answered) and
//    `agents[].now` (the agent's clock). The result data adds the dimension values (used, avail) so a disk alert can say how full.
// Every query is scoped to named contexts. A whole-room query (contexts "*") returned 87 MB in 8 s.
//
// What it does with that (classifyNetdataAlert below is the table):
//  - one proof-of-watch cell per alert group, `ok` while the group's query answers with nothing in WARNING or CRITICAL, `firing`
//    while something is, `error` when its request failed, `nodata` when no node answered; plus one cell for node reachability;
//  - an alert per instance in WARNING or CRITICAL, keyed by (node, alert, instance, incident rule). A CRITICAL pages only for a
//    full disk on a fleet node or a fleet node that stays unreachable; everything else is a wall-only warning;
//  - no disk WARNING on a mount under the disk warning floor (80 % used, `diskWarningFloor` in the config: no warning for
//    a disk under 80 % used): such an alert is dropped like a quiet one. The CRITICAL tier (full in under 2 hours) is raised at any fill;
//  - a disk alert on a host that has the Grafana host-disk rules takes the Grafana rule's title of the same tier, so both land in
//    ONE incident (classifyNetdataAlert);
//  - every alert names the machine it is about (nodeIdentity): `print (print.example.com, 203.0.113.10)`, from the nodes call (the
//    address, the system, the running kernel) and the config's `nodes` notes (the public name, what the machine is), and its source
//    link opens the node's own page in Netdata Cloud (nodeUrl), not the room.

import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { Alert, AlertLinks, CellState, Observation, RuleCell } from '../../shared/types.ts'
import type { NetdataCloudGroupConfig, NetdataCloudIgnoreRule, NetdataCloudSourceConfig, NetdataDiskWarningFloor, NetdataNodeNote } from '../config.ts'
import { makeAlert } from '../derive.ts'
import type { PolledSource, SourceDeps } from './types.ts'
import { canonicalHost, diskRule, isDiskCapacity } from './netdata.ts'
import type { GrafanaTier } from './netdata.ts'
import { clip, isRecord, safeUrl } from './shared.ts'
import { FLEET_LOAD_SERVICE, RULE_INFO, fleetRuleTitle, twinOf } from './fleet-rules.ts'
import type { FleetRuleId } from '../../shared/fleet.ts'

// ---- policy: which alerts show, at what severity, under which title -----------------------------------------------

export const NETDATA_SERVICE = 'Netdata'
export const HOST_DISKS_SERVICE = 'Host disks'
/**
 * Netdata's latency alerts: 37 warnings a day on the md and NVMe disks of node-4 and node-5. And the two CPU alerts Netdata itself sends to nobody (`to: silent` in its
 * cpu.conf: iowait and steal time), which the host group would otherwise bring in with the CPU context it reads for `10min_cpu_usage`.
 * Off the wall unless the config says otherwise.
 */
export const DEFAULT_QUIET_ALERTS: readonly string[] = ['10min_disk_backlog', '10min_disk_utilization', '10min_cpu_iowait', '20min_steal_cpu']
/**
 * The disk warning floor, percent used: a disk-capacity alert at WARNING on a mount less full than this is not raised (no warning for a disk under
 * 80 % used). The default when the config has no `diskWarningFloor`; config/watch.example.json states it with its reason.
 */
export const DEFAULT_DISK_WARNING_FLOOR_PCT = 80
/**
 * Mounts that are never a full host disk: a mounted installer image is 100 % full and read-only by design, and a per-user sandbox volume is that user's own
 * quota, not the node's filesystem.
 */
export const DEFAULT_IGNORE_INSTANCES: readonly NetdataCloudIgnoreRule[] = [
  { instance: '^disk_(space|inodes)\\./Volumes/', note: 'macOS mounted volumes and disk images (the Google Chrome installer image sits at 100 %)' },
  { instance: '^disk_(space|inodes)\\./System/Volumes/(VM|Preboot|Update|xarts|iSCPreboot|Hardware)(/|$)', note: 'macOS auxiliary APFS volumes share their container' },
  { instance: '^disk_(space|inodes)\\./snap/', note: 'read-only snap squashfs mounts' },
  {
    instance: '^disk_(space|inodes)\\./run/box-space/',
    note: "a per-user sandbox 'space' volume: its own loop-image quota, never a host filesystem; filling it costs one user's sandbox, and the node's own / mount still pages"
  }
]

export type NetdataLevel = 'warning' | 'critical'
export type NetdataFamily = 'space' | 'inodes' | 'other'

export interface NetdataPolicy {
  fleetNodes: readonly string[]
  watchOnlyNodes: readonly string[]
  /** Nodes that are not watched at all (config ignoreNodes): their alerts are dropped, they are not expected for reachability. */
  ignoreNodes: readonly string[]
  ignoreInstances: ReadonlyArray<{ node?: RegExp; instance: RegExp }>
  /** Alert names, `*` is a wildcard, case does not matter. */
  quietAlerts: readonly string[]
  /** A disk-capacity WARNING on a mount under this percent used is not raised; a CRITICAL always is. 0 = no floor. Absent = DEFAULT_DISK_WARNING_FLOOR_PCT. */
  diskWarningFloorPct?: number
  /**
   * The nodes the netdata-fleet source's rules cover (its fleetNodes). Netdata's CPU and RAM alerts on one of these take the fleet rule's title and the Fleet
   * load service, so they land in the incident of Watch's own HostCpuHot or HostMemoryHot (fleet-rules.ts NETDATA_TWINS). Absent: no alert is folded.
   */
  loadNodes?: readonly string[]
  /** The hosts whose disk alerts have a Grafana rule of the same tier (config `grafanaDiskHosts`). */
  grafanaDiskHosts?: readonly string[]
}

/** What one instance in WARNING or CRITICAL is, before the policy decides what the wall does with it. */
export interface NetdataFinding {
  /** The node's hostname as Netdata Cloud names it: `node-4`, `mac-a1.example.net`. */
  node: string
  /** Netdata's alert name: `disk_space_usage`. */
  alert: string
  /** Netdata's chart instance id: `disk_space./data/ssd1`. */
  instance: string
  level: NetdataLevel
  /** The group's tile for an alert that joins no Grafana rule. Default `Netdata`. */
  groupService?: string
  /**
   * How full the mount is, percent (one decimal, as the alert text states it): space for a disk_space alert, inodes for a disk_inodes one. Absent when the
   * response carried no usage columns; the floor then cannot judge and the alert is raised as before.
   */
  usedPct?: number
}

export type NetdataVerdict =
  | { show: false; reason: 'quiet' | 'ignored' | 'ignored-node' | 'below-floor' }
  | {
      show: true
      /** The incident's rule title. It is the key of the wall tile (service|rule). */
      rule: string
      service: string
      /** `page` only for a critical disk-full alert on a fleet node (the reachability alert pages on its own path). */
      severity: 'page' | 'warning'
      family: NetdataFamily
      /** The Grafana tier whose incident this alert joins, or null when it stands alone. */
      tier: GrafanaTier | null
      /** Netdata said critical, Watch shows a warning. */
      demoted: boolean
      /** The node is not a fleet node, so nothing it says pages. */
      watchOnly: boolean
      /** The netdata-fleet rule this alert is a twin of (CPU and RAM alerts on a fleet node). */
      fleetRule?: FleetRuleId
    }

const lower = (s: string): string => s.toLowerCase()
const has = (list: readonly string[], v: string): boolean => list.some((x) => lower(x) === lower(v))

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')
}
const globMatch = (pattern: string, name: string): boolean => globToRegExp(pattern).test(name)

/** The phrase an alert goes by in a title: the stock alert names read as words, with a few written out. */
const FRIENDLY: Record<string, string> = {
  disk_space_usage: 'disk space',
  out_of_disk_space_time: 'disk filling up',
  disk_inode_usage: 'disk inodes',
  out_of_disk_inodes_time: 'disk inodes running out',
  mdstat_disks: 'RAID member disks',
  nvme_device_critical_warnings_state: 'NVMe critical warning',
  docker_container_unhealthy: 'container unhealthy',
  system_post_update_reboot_status: 'reboot pending after update',
  system_reboot_detection: 'recent reboot',
  '10min_cpu_usage': 'CPU usage',
  ram_available: 'RAM available',
  ram_in_use: 'RAM in use',
  used_swap: 'swap used',
  oom_kill: 'OOM kills',
  '1hour_memory_hw_corrupted': 'hardware-corrupted memory',
  system_clock_sync_state: 'clock sync',
  system_file_descriptors_utilization: 'file descriptors'
}
export function friendlyAlert(alert: string): string {
  const known = FRIENDLY[lower(alert)]
  if (known) return known
  const words = alert.replace(/[_-]+/g, ' ').trim()
  return words.replace(/^clickhouse\b/i, 'ClickHouse')
}

/**
 * Decide what the wall does with one alert instance. Pure: the whole severity, dedupe and ignore table
 * is this function and test/netdata-cloud.test.ts walks every row of it.
 *
 *  - quietAlerts, ignoreInstances and a node of ignoreNodes drop the alert (it is still evaluated, so its group's cell stays solid).
 *  - The disk warning floor drops a disk-capacity alert at WARNING when its mount is under `policy.diskWarningFloorPct` used (default 80): the
 *    rule is no warning for a disk under 80 % used. A CRITICAL (full in under 2 hours, or nearly full) is never dropped by it, whatever the
 *    fill, and a mount at or over the floor, or one whose fill is unknown, keeps today's behaviour.
 *  - Disk alerts: on a host with the Grafana host-disk rules (GRAFANA_DISK_HOSTS in netdata.ts) a space alert takes the Grafana rule's title of the
 *    same tier, so Grafana's alert and this one are ONE incident (one tile, reach 2). Elsewhere it stands alone as
 *    `Netdata: disk space (host)`. Inode alerts have no Grafana twin: `Netdata: disk inodes (host)`.
 *  - CPU and RAM alerts (`10min_cpu_usage`, `ram_in_use`, `ram_available`) on a node of `policy.loadNodes` take the netdata-fleet rule's title on the
 *    Fleet load tile (`Host CPU hot (node-13)`), so Netdata's alert and Watch's are ONE incident with two alerts: Watch's grouping is the incident key,
 *    service plus rule title, nothing more.
 *  - Severity: a critical disk-full alert on a fleet node is a page. Every other critical is a warning; every warning is a warning;
 *    a node that is not a fleet node (watchOnlyNodes, or not listed at all) is capped at a warning.
 */
export function classifyNetdataAlert(f: NetdataFinding, policy: NetdataPolicy): NetdataVerdict {
  if (policy.quietAlerts.some((q) => globMatch(q, f.alert))) return { show: false, reason: 'quiet' }
  const node = canonicalHost(f.node)
  if (has(policy.ignoreNodes, node)) return { show: false, reason: 'ignored-node' }
  if (policy.ignoreInstances.some((r) => (!r.node || r.node.test(node)) && r.instance.test(f.instance))) return { show: false, reason: 'ignored' }
  const floor = policy.diskWarningFloorPct ?? DEFAULT_DISK_WARNING_FLOOR_PCT
  if (f.level === 'warning' && isDiskCapacity(f.alert) && f.usedPct !== undefined && f.usedPct < floor) return { show: false, reason: 'below-floor' }
  const fleet = has(policy.fleetNodes, node)
  // Netdata's own CPU and RAM alerts on a node the fleet rules cover: ONE incident with Watch's rule, this alert as a second piece of evidence. It never
  // pages (only Watch's memory rule above 95 % does) and is never the watch-only warning, so the wall states the level plainly.
  const twin = twinOf(f.alert)
  if (twin && has(policy.loadNodes ?? [], node)) {
    return { show: true, rule: fleetRuleTitle(twin, node), service: FLEET_LOAD_SERVICE, severity: 'warning', family: 'other', tier: null, demoted: false, watchOnly: false, fleetRule: twin }
  }
  // The disk table is the webhook adapter's (diskRule): one mapping for both Netdata sources, so they cannot disagree on a title.
  const disk = diskRule(node, f.alert, f.level, policy.grafanaDiskHosts ?? [])
  const rule = disk ? disk.rule : `Netdata: ${friendlyAlert(f.alert)} (${node})`
  const service = disk ? HOST_DISKS_SERVICE : (f.groupService ?? NETDATA_SERVICE)
  const severity = f.level === 'critical' && isDiskCapacity(f.alert) && fleet ? 'page' : 'warning'
  return { show: true, rule, service, severity, family: disk ? disk.family : 'other', tier: disk ? disk.tier : null, demoted: f.level === 'critical' && severity === 'warning', watchOnly: !fleet }
}

/** The policy a source config describes: its lists and the built-in ignore rules and quiet alerts. */
export function netdataPolicyOf(
  cfg: Pick<NetdataCloudSourceConfig, 'fleetNodes' | 'watchOnlyNodes' | 'ignoreNodes' | 'ignoreInstances' | 'quietAlerts' | 'grafanaDiskHosts'> & { diskWarningFloor?: NetdataDiskWarningFloor },
  loadNodes: readonly string[] = []
): NetdataPolicy {
  return {
    loadNodes,
    grafanaDiskHosts: cfg.grafanaDiskHosts ?? [],
    diskWarningFloorPct: cfg.diskWarningFloor?.usedPct,
    fleetNodes: cfg.fleetNodes,
    watchOnlyNodes: cfg.watchOnlyNodes ?? [],
    ignoreNodes: Object.keys(cfg.ignoreNodes ?? {}),
    ignoreInstances: [...DEFAULT_IGNORE_INSTANCES, ...(cfg.ignoreInstances ?? [])].map((r) => ({
      node: r.node === undefined ? undefined : new RegExp(r.node),
      instance: new RegExp(r.instance)
    })),
    quietAlerts: cfg.quietAlerts ?? DEFAULT_QUIET_ALERTS
  }
}

// ---- groups: the queries ------------------------------------------------------------------------------------------

/**
 * The built-in groups. Each is one request and one cell. Contexts are named, never `*`. Docker's context lists thousands of dead
 * containers in its summary (1.4 MB, 2 s), so it is read every 5 minutes. A name a group does not list is not watched.
 */
export const DEFAULT_GROUPS: readonly NetdataCloudGroupConfig[] = [
  { id: 'disk-space', name: 'Netdata disk space alerts', contexts: ['disk.space'], alerts: ['disk_space_usage', 'out_of_disk_space_time'], service: HOST_DISKS_SERVICE },
  { id: 'disk-inodes', name: 'Netdata disk inode alerts', contexts: ['disk.inodes'], alerts: ['disk_inode_usage', 'out_of_disk_inodes_time'], service: HOST_DISKS_SERVICE },
  {
    id: 'disk-health',
    name: 'Netdata RAID and NVMe alerts',
    contexts: ['md.health', 'nvme.device_critical_warnings_state'],
    alerts: ['mdstat_disks', 'nvme_device_critical_warnings_state'],
    service: HOST_DISKS_SERVICE
  },
  { id: 'clickhouse', name: 'Netdata ClickHouse alerts', contexts: ['clickhouse.*'], alerts: ['clickhouse_*'] },
  { id: 'docker', name: 'Netdata Docker health alerts', contexts: ['docker.container_health_status'], alerts: ['docker_container_unhealthy'], everySec: 300 },
  {
    id: 'host',
    name: 'Netdata host alerts (RAM, CPU, swap, clock, reboot)',
    contexts: [
      'mem.available',
      'mem.swap',
      'mem.oom_kill',
      'mem.hwcorrupt',
      'system.ram',
      // `10min_cpu_usage` lives here: it is the twin of the netdata-fleet HostCpuHot rule (fleet-rules.ts NETDATA_TWINS). Its two siblings on this
      // context are in DEFAULT_QUIET_ALERTS.
      'system.cpu',
      'system.uptime',
      'system.post_update_reboot_status',
      'system.clock_sync_state',
      'system.file_nr_utilization'
    ],
    alerts: ['*']
  }
]

const STATUSES = ['WARNING', 'CRITICAL'] as const
const GROUP_REQUEST_TIMEOUT_MS = 8000
const MAX_BODY_BYTES = 6 * 1024 * 1024
/** Requests one poll may make, including the refinements an ambiguous group costs. */
const MAX_REQUESTS_PER_POLL = 14
/** A node reported unreachable must stay so for this many polls before it is an alert (one poll is a blip). */
const UNREACHABLE_POLLS = 2
/** A poll slower than this is written to the log: a 60 s cadence with a poll near it would dash the cells. */
const SLOW_POLL_MS = 20_000
/** An agent clock further from ours than this is not used as the evaluation time. */
const CLOCK_SKEW_MS = 10 * 60_000

function queryBody(group: NetdataCloudGroupConfig, alerts: string[]): Record<string, unknown> {
  return {
    scope: { contexts: group.contexts },
    selectors: { nodes: ['*'], contexts: group.contexts, instances: ['*'], dimensions: ['*'], labels: ['*'], alerts },
    window: { after: -120, before: 0, points: 1 },
    aggregations: { metrics: [{ group_by: ['node', 'instance', 'dimension'], aggregation: 'sum' }], time: { time_group: 'average' } },
    format: 'json2',
    options: ['jsonwrap', 'minify', 'unaligned'],
    timeout: GROUP_REQUEST_TIMEOUT_MS
  }
}

/** The alert selectors that pick the instances in WARNING or CRITICAL for each of the group's names. */
export function groupSelectors(patterns: readonly string[]): string[] {
  return patterns.flatMap((p) => STATUSES.map((s) => `${p}:${s}`))
}

// ---- reading a data response --------------------------------------------------------------------------------------

interface DataNode {
  name: string
  guid: string
  /** HTTP status of this node's agent in Cloud's fan-out; 200 = it answered. */
  code: number
}
interface DataInstance {
  id: string
  node: string
  selected: boolean
  warnings: number
  criticals: number
}
interface NameCount {
  warnings: number
  criticals: number
}
export interface ParsedData {
  nodes: DataNode[]
  instances: DataInstance[]
  counts: Map<string, NameCount>
  /** The newest `agents[].now`, epoch seconds, or null. */
  agentNowSec: number | null
  /** How full a selected disk instance is, keyed by `${node}\n${instance}`. */
  values: Map<string, string>
  /** The same disks' percent used (space or inodes, one decimal), the number behind `values`, for the disk warning floor. */
  usedPct: Map<string, number>
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function parseData(body: unknown): ParsedData {
  if (!isRecord(body) || !isRecord(body.summary) || !Array.isArray(body.summary.nodes) || !Array.isArray(body.summary.instances)) {
    throw new Error('Netdata Cloud data response has an unexpected shape')
  }
  const nodes: DataNode[] = []
  const byIndex = new Map<number, DataNode>()
  for (const n of body.summary.nodes) {
    if (!isRecord(n) || typeof n.nm !== 'string') continue
    const code = isRecord(n.st) && typeof n.st.code === 'number' ? n.st.code : 200
    const node: DataNode = { name: n.nm, guid: typeof n.mg === 'string' ? n.mg : '', code }
    nodes.push(node)
    if (typeof n.ni === 'number') byIndex.set(n.ni, node)
  }
  const instances: DataInstance[] = []
  for (const i of body.summary.instances) {
    if (!isRecord(i) || typeof i.id !== 'string' || typeof i.ni !== 'number') continue
    const node = byIndex.get(i.ni)
    if (!node) continue
    const al = isRecord(i.al) ? i.al : {}
    instances.push({ id: i.id, node: node.name, selected: isRecord(i.ds) && num(i.ds.sl) > 0, warnings: num(al.wr), criticals: num(al.cr) })
  }
  const counts = new Map<string, NameCount>()
  if (Array.isArray(body.summary.alerts)) {
    for (const a of body.summary.alerts) if (isRecord(a) && typeof a.nm === 'string') counts.set(a.nm, { warnings: num(a.wr), criticals: num(a.cr) })
  }
  const nows = Array.isArray(body.agents) ? body.agents.flatMap((a) => (isRecord(a) && typeof a.now === 'number' && a.now > 0 ? [a.now] : [])) : []
  const read = readValues(body, nodes)
  return { nodes, instances, counts, agentNowSec: nows.length ? Math.max(...nows) : null, values: read.values, usedPct: read.usedPct }
}

const fixed = (n: number): string => (Math.round(n * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const whole = (n: number): string => Math.round(n).toLocaleString('en-US')

/**
 * How full each selected disk instance is, from the result's dimension columns (`used,disk_space./,<machine guid>`). Best effort:
 * a response without those columns just has no value.
 */
function readValues(body: Record<string, unknown>, nodes: DataNode[]): { values: Map<string, string>; usedPct: Map<string, number> } {
  const out = new Map<string, string>()
  const pcts = new Map<string, number>()
  const view = isRecord(body.view) ? body.view : {}
  const dims = isRecord(view.dimensions) ? view.dimensions : {}
  const result = isRecord(body.result) ? body.result : {}
  const ids = Array.isArray(dims.ids) ? dims.ids : []
  const rows = Array.isArray(result.data) ? result.data : []
  const row = rows.length ? rows[rows.length - 1] : undefined
  if (!Array.isArray(row) || ids.length === 0 || row.length - 1 !== ids.length) return { values: out, usedPct: pcts }
  const nameOf = new Map(nodes.map((n) => [n.guid, n.name]))
  const per = new Map<string, Record<string, number>>()
  for (const [k, id] of ids.entries()) {
    const cell = row[k + 1]
    const value = Array.isArray(cell) ? cell[0] : undefined
    if (typeof id !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) continue
    const first = id.indexOf(',')
    const last = id.lastIndexOf(',')
    if (first < 0 || last <= first) continue
    const node = nameOf.get(id.slice(last + 1))
    if (!node) continue
    const key = `${node}\n${id.slice(first + 1, last)}`
    per.set(key, { ...per.get(key), [id.slice(0, first)]: value })
  }
  const units = typeof view.units === 'string' && view.units ? view.units : ''
  for (const [key, d] of per) {
    const instance = key.slice(key.indexOf('\n') + 1)
    if (d.used === undefined || d.avail === undefined || d.used + d.avail <= 0) continue
    const pct = (d.used / (d.used + d.avail)) * 100
    const total = d.used + d.avail + (d.reserved ?? d['reserved for root'] ?? 0)
    if (instance.startsWith('disk_space.')) out.set(key, `${fixed(pct)}% used, ${fixed(d.avail)} ${units || 'GiB'} free of ${fixed(total)} ${units || 'GiB'}`)
    else if (instance.startsWith('disk_inodes.')) out.set(key, `${fixed(pct)}% of inodes used, ${whole(d.avail)} free of ${whole(total)}`)
    else continue
    pcts.set(key, Math.round(pct * 10) / 10)
  }
  return { values: out, usedPct: pcts }
}

// ---- finding which alert is in which state ------------------------------------------------------------------------

export interface Located {
  node: string
  instance: string
  alert: string
  level: NetdataLevel
  /** The status could only be guessed from the instance counters (the request budget ran out). */
  approximate?: boolean
}

/**
 * The instances a combined WARNING/CRITICAL query selected, with the alert name and state of each. The query cannot say which
 * alert of which instance selected it, so: when exactly one name in the scope is non-clear (summary.alerts) and no selected
 * instance has both a warning and a critical, the counters answer. Otherwise `refine` asks one query per (name, status) with a
 * non-zero count, and a selected instance is attributed to the (name, status) queries that select it.
 */
export async function locateAlerts(
  first: ParsedData,
  patterns: readonly string[],
  refine: (selector: string) => Promise<ParsedData | null>
): Promise<{ found: Located[]; values: Map<string, string>; usedPct: Map<string, number> }> {
  const selected = first.instances.filter((i) => i.selected)
  const values = new Map(first.values)
  const usedPct = new Map(first.usedPct)
  if (selected.length === 0) return { found: [], values, usedPct }
  const matches = (name: string): boolean => patterns.some((p) => globMatch(p, name))
  const counted = [...first.counts].filter(([name, c]) => matches(name) && (c.warnings > 0 || c.criticals > 0))
  const mixed = selected.some((i) => i.warnings > 0 && i.criticals > 0)
  if (counted.length === 1 && !mixed) {
    const name = counted[0][0]
    return { found: selected.map((i) => ({ node: i.node, instance: i.id, alert: name, level: i.criticals > 0 ? 'critical' : 'warning' })), values, usedPct }
  }
  // No counter for a pattern that is a plain name (it can still select): ask for it under that name.
  const asks: Array<{ name: string; level: NetdataLevel }> = []
  for (const [name, c] of counted) {
    if (c.criticals > 0) asks.push({ name, level: 'critical' })
    if (c.warnings > 0) asks.push({ name, level: 'warning' })
  }
  if (counted.length === 0) {
    for (const p of patterns) if (!p.includes('*')) asks.push({ name: p, level: 'critical' }, { name: p, level: 'warning' })
  }
  const found: Located[] = []
  const claimed = new Set<string>()
  const unanswered: string[] = []
  for (const ask of asks) {
    const reply = await refine(`${ask.name}:${ask.level === 'critical' ? 'CRITICAL' : 'WARNING'}`)
    if (!reply) {
      unanswered.push(ask.name)
      continue
    }
    for (const [k, v] of reply.values) if (!values.has(k)) values.set(k, v)
    for (const [k, v] of reply.usedPct) if (!usedPct.has(k)) usedPct.set(k, v)
    for (const i of reply.instances.filter((x) => x.selected)) {
      found.push({ node: i.node, instance: i.id, alert: ask.name, level: ask.level })
      claimed.add(`${i.node}\n${i.id}`)
    }
  }
  // Instances no refinement claimed: the budget ran out or the names were unknown. The counters are the best evidence left.
  const fallback = unanswered[0] ?? counted[0]?.[0] ?? patterns[0] ?? 'unknown'
  for (const i of selected) {
    if (claimed.has(`${i.node}\n${i.id}`)) continue
    found.push({ node: i.node, instance: i.id, alert: fallback, level: i.criticals > 0 ? 'critical' : 'warning', approximate: true })
  }
  return { found, values, usedPct }
}

// ---- the HTTP calls -----------------------------------------------------------------------------------------------

export type FailureKind = 'auth' | 'throttle' | 'server' | 'client' | 'network' | 'timeout' | 'parse' | 'size'

/** A failed request. The message names the call and the HTTP status only: no URL, no header, never the token. */
export class CloudError extends Error {
  readonly kind: FailureKind
  readonly retryAfterSec: number | undefined
  constructor(kind: FailureKind, message: string, retryAfterSec?: number) {
    super(message)
    this.name = 'CloudError'
    this.kind = kind
    this.retryAfterSec = retryAfterSec
  }
}

export async function readCapped(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new CloudError('size', `response is ${Math.round(declared / 1048576)} MB, over the ${Math.round(limit / 1048576)} MB limit (narrow the group's contexts)`)
  if (!res.body) return await res.text()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw new CloudError('size', `response is over the ${Math.round(limit / 1048576)} MB limit (narrow the group's contexts)`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function describeNetworkFailure(err: unknown, timeoutMs: number): CloudError {
  if (err instanceof CloudError) return err
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return new CloudError('timeout', `timed out after ${timeoutMs / 1000} s`)
    const code = (err.cause as { code?: unknown } | undefined)?.code
    if (typeof code === 'string') return new CloudError('network', code)
  }
  return new CloudError('network', 'network error')
}

/**
 * One authenticated request to the Cloud API: the token goes to `base` and nowhere else (a redirect is a failure), a refused token, a rate limit and a
 * server error are told apart (`CloudError.kind`), and a message names the call and the HTTP status only, never the URL or the token. Shared by the alert poll
 * and the fleet metrics poll (netdata-fleet.ts).
 */
export async function cloudCall(
  fetchFn: typeof fetch,
  base: string,
  timeoutMs: number,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  label: string,
  body?: unknown
): Promise<unknown> {
  let res: Response
  try {
    res = await fetchFn(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'ezo-watcher (+https://watch.example.com)',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // The token goes to the configured origin and nowhere else: a redirect is a failure, not a hop.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    const e = describeNetworkFailure(err, timeoutMs)
    throw new CloudError(e.kind, `${label} request failed: ${e.message}`)
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined)
    throw new CloudError('auth', `${label} was refused with HTTP ${res.status}: Netdata Cloud rejects the API token (rotate it, see watcher skills netdata)`)
  }
  if (res.status === 429) {
    await res.body?.cancel().catch(() => undefined)
    const wait = Number(res.headers.get('retry-after'))
    throw new CloudError('throttle', `${label} returned HTTP 429 (rate limited)`, Number.isFinite(wait) && wait > 0 ? wait : undefined)
  }
  if (!res.ok) {
    let code = ''
    try {
      const text = await readCapped(res, 16_384)
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed) && typeof parsed.errorMsgKey === 'string' && /^Err[A-Za-z]{1,40}$/.test(parsed.errorMsgKey)) code = ` (${parsed.errorMsgKey})`
    } catch {
      // The status alone is enough.
    }
    throw new CloudError(res.status >= 500 ? 'server' : 'client', `${label} returned HTTP ${res.status}${code}`)
  }
  let text: string
  try {
    text = await readCapped(res, MAX_BODY_BYTES)
  } catch (err) {
    const e = describeNetworkFailure(err, timeoutMs)
    throw new CloudError(e.kind, e.kind === 'size' ? `${label} ${e.message}` : `${label} request failed: ${e.message}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new CloudError('parse', `${label} returned a body that is not JSON`)
  }
}

// ---- the source ---------------------------------------------------------------------------------------------------

/** One node of the room, as the nodes call describes it. A field Cloud did not report is the empty string. */
export interface CloudNode {
  /** Cloud's node id (a uuid): the last part of the node's page. */
  id: string
  name: string
  state: string
  version: string
  /** The address of the default interface, when the agent reported a real one. */
  ip: string
  /** `Ubuntu 24.04.3 LTS` */
  os: string
  /** The running kernel: `6.8.0-71-generic`. */
  kernel: string
  /** `DigitalOcean Droplet`, `Supermicro` */
  vendor: string
}

const JUNK_HARDWARE = /^(none|unknown|system product name|to be filled by o\.e\.m\.|default string|not specified)$/i
const labelText = (labels: Record<string, unknown>, key: string): string => {
  const v = labels[key]
  return typeof v === 'string' ? clip(v.replace(/_/g, ' ').trim(), 80) : ''
}

function vendorOf(labels: Record<string, unknown>): string {
  const vendor = labelText(labels, '_hw_sys_vendor')
  const product = labelText(labels, '_hw_product_name')
  const v = JUNK_HARDWARE.test(vendor) ? '' : vendor
  const p = JUNK_HARDWARE.test(product) ? '' : product
  if (!p) return v
  return !v || lower(p).startsWith(lower(v)) ? p : `${v} ${p}`
}

/** `Ubuntu` + `24.04.3 LTS (Noble Numbat)` is `Ubuntu 24.04.3 LTS`: the code name in brackets is dropped. */
function osOf(n: Record<string, unknown>): string {
  const name = typeof n.osName === 'string' ? clip(n.osName.trim(), 40) : ''
  const raw = typeof n.osVersion === 'string' ? clip(n.osVersion.trim(), 80) : ''
  const cut = raw.indexOf(' (')
  return [name, cut > 0 ? raw.slice(0, cut) : raw].filter(Boolean).join(' ')
}

/** The nodes of the room from the nodes call. A deleted node and one without a name are left out. */
export function readCloudNodes(body: unknown): CloudNode[] {
  if (!Array.isArray(body)) throw new Error('Netdata Cloud nodes response is not a list')
  const out: CloudNode[] = []
  for (const n of body) {
    if (!isRecord(n) || typeof n.name !== 'string' || n.name === '' || n.isDeleted === true) continue
    const labels = isRecord(n.hostLabels) ? n.hostLabels : {}
    const ip = typeof labels._net_default_iface_ip === 'string' ? labels._net_default_iface_ip.trim() : ''
    out.push({
      id: typeof n.id === 'string' ? clip(n.id, 80) : '',
      name: n.name,
      state: typeof n.state === 'string' ? n.state : 'unknown',
      version: typeof n.version === 'string' ? n.version : '',
      // the agents in containers report `unknown`; only a real address is shown
      ip: isIP(ip) ? ip : '',
      os: osOf(n),
      kernel: typeof n.kernelVersion === 'string' ? clip(n.kernelVersion.trim(), 60) : '',
      vendor: vendorOf(labels)
    })
  }
  return out
}

/**
 * The page of one node in Netdata Cloud: the room's page and `/nodes/<id>`. Only the space and room of `cloudUrl` are used (it may end
 * in a slash, `/overview`, a query or a fragment). Nothing when the URL is not a room page or the id is empty.
 */
export function nodeUrl(cloudUrl: string | undefined, id: string): string | undefined {
  const safe = safeUrl(cloudUrl)
  if (!safe || id === '') return undefined
  const room = /^(https?:\/\/[^/?#]+\/spaces\/[^/?#]+\/rooms\/[^/?#]+)/.exec(safe)
  return room ? `${room[1]}/nodes/${encodeURIComponent(id)}` : undefined
}

/** The words that name one machine in an alert: who it is, what it runs, where to open it. */
export interface NodeIdentity {
  /** `print (print.example.com, 203.0.113.10)`: the name, then the public name and the address in brackets, whichever are known. */
  label: string
  id: string
  ip: string
  dns: string
  /** `DigitalOcean Droplet, Ubuntu 24.04.3 LTS, kernel 6.8.0-71-generic`, or empty. */
  platform: string
  kernel: string
  /** The config's sentence about the machine, or empty. */
  note: string
  /** The node's page in Netdata Cloud, or undefined. */
  url: string | undefined
}

export function nodeIdentity(name: string, node: CloudNode | undefined, note: NetdataNodeNote | undefined, cloudUrl: string | undefined): NodeIdentity {
  const dns = typeof note?.dns === 'string' && lower(note.dns) !== lower(name) ? note.dns : ''
  const ip = node?.ip ?? ''
  const bits = [dns, ip].filter(Boolean)
  const kernel = node?.kernel ?? ''
  return {
    label: bits.length > 0 ? `${name} (${bits.join(', ')})` : name,
    id: node?.id ?? '',
    ip,
    dns,
    platform: [node?.vendor ?? '', node?.os ?? '', kernel ? `kernel ${kernel}` : ''].filter(Boolean).join(', '),
    kernel,
    note: typeof note?.note === 'string' ? note.note.trim() : '',
    url: nodeUrl(cloudUrl, node?.id ?? '')
  }
}

interface GroupMemory {
  /** Alerts per node, kept for a node whose agent did not answer this time. */
  byNode: Map<string, Alert[]>
  cell: RuleCell
  ranAtMs: number
}

const sha16 = (...parts: string[]): string => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)

export function createNetdataCloudSource(cfg: NetdataCloudSourceConfig, deps: SourceDeps, loadNodes: readonly string[] = []): PolledSource {
  const origin = new URL(cfg.url).origin
  const base = `${origin}/api`
  const room = `/spaces/${encodeURIComponent(cfg.spaceId)}/rooms/${encodeURIComponent(cfg.roomId)}`
  const policy = netdataPolicyOf(cfg, loadNodes)
  const ignored = (name: string): boolean => has(policy.ignoreNodes, canonicalHost(name))
  const groups = cfg.groups ?? DEFAULT_GROUPS
  const timeoutMs = cfg.requestTimeoutMs ?? 10_000
  const pollMs = cfg.pollSec * 1000
  const link = safeUrl(cfg.cloudUrl)
  const notes = new Map<string, NetdataNodeNote>(Object.entries(cfg.nodes ?? {}).map(([k, v]) => [lower(k), v]))
  /** The room's nodes as of the last nodes call, by the name Cloud gives them. */
  let directory = new Map<string, CloudNode>()
  const memory = new Map<string, GroupMemory>()
  const unreachable = new Map<string, number>()
  let failures = 0
  let notBeforeMs = 0
  let lastFailure = ''
  /** The last failure logged per group: a query that keeps failing the same way is logged once, and again when it recovers and fails. */
  const logged = new Map<string, string>()

  const call = (token: string, method: 'GET' | 'POST', path: string, label: string, body?: unknown): Promise<unknown> =>
    cloudCall(deps.fetch, base, timeoutMs, token, method, path, label, body)

  /** Who a node is, for the words of an alert about it. A node Cloud does not list (missing from the room) has only its config note. */
  function whoIs(name: string): NodeIdentity {
    const host = canonicalHost(name)
    return nodeIdentity(host, directory.get(name), notes.get(lower(name)) ?? notes.get(lower(host)), cfg.cloudUrl)
  }

  function evaluatedAt(parsed: ParsedData, now: string): string {
    if (parsed.agentNowSec === null) return now
    const ms = parsed.agentNowSec * 1000
    return Math.abs(ms - Date.parse(now)) <= CLOCK_SKEW_MS ? new Date(ms).toISOString() : now
  }

  function cell(id: string, name: string, state: CellState, at: string | undefined, intervalSec: number | undefined): RuleCell {
    return { id: `${cfg.id}:${id}`, source: cfg.id, name, service: NETDATA_SERVICE, state, evaluatedAt: at, intervalSec, url: link }
  }

  function buildAlert(f: Located, v: Extract<NetdataVerdict, { show: true }>, groupId: string, value: string | undefined, now: string): Alert {
    const label = friendlyAlert(f.alert)
    const host = canonicalHost(f.node)
    const who = whoIs(f.node)
    const detail = instanceDetail(f.instance)
    const where = detail ? ` (${detail})` : ''
    const demoted = v.demoted ? ' Netdata calls this critical; only a full disk on a fleet node is a page here, so it is a warning.' : ''
    const watchOnly = v.watchOnly ? ` ${host} is not a fleet node, so nothing it reports pages.` : ''
    const joined = v.tier ? ` It shares the incident of Grafana's host-disk rule "${v.rule}".` : ''
    const twin = v.fleetRule ? ` It shares the incident of Watch's own ${RULE_INFO[v.fleetRule].alertname} rule (the netdata-fleet source reads this machine's metrics itself), so both are evidence in one incident.` : ''
    const labels: Record<string, string> = {
      alertname: f.alert,
      severity: v.severity === 'page' ? 'critical' : 'warning',
      netdata_severity: f.level,
      host,
      instance: host,
      component: v.service === HOST_DISKS_SERVICE ? 'host-disk' : 'netdata',
      service: v.service,
      system: 'Netdata',
      netdata_instance: clip(f.instance, 120),
      netdata_group: groupId
    }
    if (detail) labels.mountpoint = clip(detail, 120)
    addIdentityLabels(labels, who)
    const rebootPending = lower(f.alert) === 'system_post_update_reboot_status'
    const annotations: Record<string, string> = {
      summary: rebootPending ? `${who.label} needs a reboot to finish installing updates` : `${who.label} ${label}${where} is ${f.level === 'critical' ? 'critical' : 'at warning'}${value ? `: ${value}` : ''}`,
      description: `${describeAlert(f.alert, f.level, who)}${demoted}${watchOnly}${joined}${twin}${f.approximate ? ' The state was read from the instance counters, not confirmed by its own query.' : ''}`.trim(),
      where: `Netdata agent on ${who.label}${who.platform ? ` (${who.platform})` : ''}. ${who.note ? `${who.note} ` : ''}Chart instance ${f.instance}, read from Netdata Cloud (space ${cfg.spaceId}) by ${deps.brand ?? 'EZO Watcher'}.`
    }
    // The alert opens the node's own page in Cloud; the room is the fallback for a node Cloud gave no id.
    const open = who.url ?? link
    const links: AlertLinks = open ? { generator: open } : {}
    return makeAlert(
      {
        origin: cfg.id,
        fingerprint: sha16(host.toLowerCase(), f.alert.toLowerCase(), f.instance, v.rule),
        rule: v.rule,
        labels,
        annotations,
        startsAt: now,
        generatorURL: open,
        links,
        value,
        via: { source: cfg.id, kind: 'netdata-cloud', lastSeen: now, url: open },
        raw: { node: f.node, alert: f.alert, instance: f.instance, level: f.level, group: groupId, approximate: f.approximate === true }
      },
      deps.serviceMap,
      now
    )
  }

  /** Query one group. Throws a CloudError when the first request fails; refinements that fail are simply unanswered. */
  async function evaluateGroup(token: string, group: NetdataCloudGroupConfig, budget: { left: number }, now: string, known: Set<string>): Promise<GroupMemory> {
    const ask = async (alerts: string[]): Promise<ParsedData> => {
      budget.left -= 1
      const body = await call(token, 'POST', `/v3${room}/data`, `Netdata Cloud ${group.id} query`, queryBody(group, alerts))
      return parseData(body)
    }
    const first = await ask(groupSelectors(group.alerts))
    const located = await locateAlerts(first, group.alerts, async (selector) => {
      if (budget.left <= 0) return null
      try {
        return await ask([selector])
      } catch (err) {
        // A refused token or a rate limit ends the poll; any other failure just leaves that refinement unanswered.
        if (err instanceof CloudError && (err.kind === 'auth' || err.kind === 'throttle')) throw err
        return null
      }
    })
    const answered = first.nodes.filter((n) => n.code === 200 && !ignored(n.name))
    const previous = memory.get(group.id)?.byNode ?? new Map<string, Alert[]>()
    const byNode = new Map<string, Alert[]>()
    // A node whose agent did not answer keeps what it last said; a node that answered says it again, or says nothing.
    for (const [node, alerts] of previous) if (known.has(node) && !answered.some((n) => n.name === node)) byNode.set(node, alerts)
    for (const n of answered) byNode.set(n.name, [])
    const seen = new Set<string>()
    for (const f of located.found) {
      const verdict = classifyNetdataAlert({ node: f.node, alert: f.alert, instance: f.instance, level: f.level, groupService: group.service, usedPct: located.usedPct.get(`${f.node}\n${f.instance}`) }, policy)
      if (!verdict.show) continue
      const alert = buildAlert(f, verdict, group.id, located.values.get(`${f.node}\n${f.instance}`), now)
      if (seen.has(alert.key)) continue
      seen.add(alert.key)
      byNode.set(f.node, [...(byNode.get(f.node) ?? []), alert])
    }
    const firing = [...byNode.values()].some((a) => a.length > 0)
    const state: CellState = answered.length === 0 ? 'nodata' : firing ? 'firing' : 'ok'
    const at = answered.length === 0 ? undefined : evaluatedAt(first, now)
    return { byNode, cell: cell(group.id, group.name, state, at, group.everySec ?? cfg.pollSec), ranAtMs: Date.parse(now) }
  }

  function reachability(nodes: CloudNode[], now: string): { cell: RuleCell; alerts: Alert[] } {
    const expected = new Map<string, CloudNode | undefined>()
    for (const n of [...cfg.fleetNodes, ...(cfg.watchOnlyNodes ?? [])]) expected.set(n, undefined)
    for (const n of nodes) expected.set(n.name, n)
    const alerts: Alert[] = []
    let reachable = 0
    let waiting = false
    for (const [name, node] of expected) {
      if (node?.state === 'reachable') {
        reachable += 1
        unreachable.delete(name)
        continue
      }
      const streak = (unreachable.get(name) ?? 0) + 1
      unreachable.set(name, streak)
      if (streak < UNREACHABLE_POLLS) {
        waiting = true
        continue
      }
      const host = canonicalHost(name)
      const who = whoIs(name)
      const open = who.url ?? link
      const fleet = has(policy.fleetNodes, host)
      const state = node ? node.state : 'missing from the room'
      const labels: Record<string, string> = {
        alertname: 'NetdataNodeUnreachable',
        severity: fleet ? 'critical' : 'warning',
        host,
        instance: host,
        component: 'netdata',
        service: NETDATA_SERVICE,
        system: 'Netdata',
        netdata_node_state: state
      }
      addIdentityLabels(labels, who)
      alerts.push(
        makeAlert(
          {
            origin: cfg.id,
            fingerprint: sha16(host.toLowerCase(), 'unreachable'),
            rule: `Netdata: node unreachable (${host})`,
            labels,
            annotations: {
              summary: `${who.label} is ${node ? state : 'missing from the Netdata room'}: Netdata Cloud cannot reach its agent`,
              description: `Netdata Cloud has not reached the agent on ${who.label} for ${UNREACHABLE_POLLS} polls in a row (state: ${state}${node?.version ? `, agent ${node.version}` : ''}). A stopped or restarting agent or a lost uplink looks like this; it does not prove the machine is down.${fleet ? '' : ` ${host} is not a fleet node, so this is a warning.`}`,
              where: `The Netdata agent on ${who.label}${who.platform ? ` (${who.platform})` : ''}, as seen by Netdata Cloud (space ${cfg.spaceId}).${who.note ? ` ${who.note}` : ''}`
            },
            startsAt: now,
            generatorURL: open,
            links: open ? { generator: open } : {},
            via: { source: cfg.id, kind: 'netdata-cloud', lastSeen: now, url: open },
            raw: { node: name, state }
          },
          deps.serviceMap,
          now
        )
      )
    }
    for (const name of [...unreachable.keys()]) if (!expected.has(name)) unreachable.delete(name)
    const state: CellState = alerts.length > 0 ? 'firing' : waiting ? 'pending' : 'ok'
    return { cell: cell('nodes', `Netdata nodes reachable (${reachable}/${expected.size})`, state, now, cfg.pollSec), alerts }
  }

  async function runPoll(token: string, now: string): Promise<Observation> {
    // A node of ignoreNodes is not in the roster: not expected for reachability, not known, not answering for a group.
    const nodes = readCloudNodes(await call(token, 'GET', `/v2${room}/nodes`, 'Netdata Cloud nodes')).filter((n) => !ignored(n.name))
    directory = new Map(nodes.map((n) => [n.name, n]))
    const known = new Set([...nodes.map((n) => n.name), ...cfg.fleetNodes, ...(cfg.watchOnlyNodes ?? [])])
    const budget = { left: MAX_REQUESTS_PER_POLL - 1 }
    const nowMs = Date.parse(now)
    const cells: RuleCell[] = []
    let evaluated = 0
    let failed = 0
    let stopped = false
    let firstError: CloudError | null = null
    for (const group of groups) {
      const previous = memory.get(group.id)
      if (group.everySec && previous && nowMs - previous.ranAtMs < group.everySec * 1000 - 5000) {
        cells.push(previous.cell)
        evaluated += 1
        continue
      }
      if (stopped || budget.left <= 0) {
        cells.push(cell(group.id, group.name, 'error', undefined, group.everySec ?? cfg.pollSec))
        failed += 1
        continue
      }
      try {
        const result = await evaluateGroup(token, group, budget, now, known)
        memory.set(group.id, result)
        cells.push(result.cell)
        evaluated += 1
        logged.delete(group.id)
      } catch (err) {
        const e = err instanceof CloudError ? err : describeNetworkFailure(err, timeoutMs)
        // A refused token or a rate limit is the whole source's problem and ends the poll at once.
        if (e.kind === 'auth' || e.kind === 'throttle') throw e
        firstError ??= e
        failed += 1
        cells.push(cell(group.id, group.name, 'error', undefined, group.everySec ?? cfg.pollSec))
        if (logged.get(group.id) !== e.message) {
          logged.set(group.id, e.message)
          deps.log?.(`netdata-cloud group ${group.id} failed: ${e.message}`)
        }
        // Two failures in a row mean Cloud is struggling: the next request would wait as long, so the rest are not asked.
        if (failed >= 2) stopped = true
      }
    }
    if (evaluated === 0 && failed > 0 && firstError) throw firstError
    const reach = reachability(nodes, now)
    const firing: Alert[] = [...reach.alerts]
    const seen = new Set(firing.map((a) => a.key))
    for (const g of groups) {
      for (const alerts of memory.get(g.id)?.byNode.values() ?? []) {
        for (const a of alerts) {
          if (seen.has(a.key)) continue
          seen.add(a.key)
          firing.push(a)
        }
      }
    }
    return { source: cfg.id, kind: 'netdata-cloud', at: now, firing, resolved: [], complete: true, rules: [reach.cell, ...cells] }
  }

  async function poll(): Promise<Observation> {
    const token = deps.env[cfg.tokenEnv]?.trim()
    if (!token) throw new Error(`Netdata Cloud token missing: ${cfg.tokenEnv} is not set or is empty in the Watch environment file (see watcher skills netdata)`)
    const now = deps.nowIso()
    const nowMs = Date.parse(now)
    if (nowMs < notBeforeMs) throw new Error(`backing off after: ${lastFailure} (next request in ${Math.ceil((notBeforeMs - nowMs) / 1000)} s)`)
    const started = Date.now()
    try {
      const obs = await runPoll(token, now)
      failures = 0
      notBeforeMs = 0
      const took = Date.now() - started
      if (took > SLOW_POLL_MS) deps.log?.(`netdata-cloud poll took ${Math.round(took / 1000)} s`)
      return obs
    } catch (err) {
      failures += 1
      const e = err instanceof CloudError ? err : null
      lastFailure = (err as Error).message
      // One failure costs nothing extra; repeated ones double the wait up to 8 polls; a 429's Retry-After is honoured up to 15 minutes.
      const wait = failures <= 1 ? 0 : Math.min(pollMs * 2 ** (failures - 1), 8 * pollMs)
      const asked = e?.kind === 'throttle' ? Math.min((e.retryAfterSec ?? 0) * 1000, 15 * 60_000) : 0
      const hold = Math.max(wait, asked)
      notBeforeMs = hold > 0 ? nowMs + hold - 5000 : 0
      throw err
    }
  }

  return { id: cfg.id, kind: 'netdata-cloud', name: 'Netdata Cloud', pollSec: cfg.pollSec, poll }
}

// ---- wording ------------------------------------------------------------------------------------------------------

/** The part of a Netdata instance id a person reads: the mount point of a disk chart, the container of a Docker one. */
export function instanceDetail(instance: string): string {
  const disk = /^disk_(?:space|inodes)\.(.*)$/.exec(instance)
  if (disk) return disk[1] === '' || disk[1] === '_' ? '/' : disk[1]
  const container = /^docker[^.]*\.container_(.+)_health_status$/.exec(instance)
  if (container) return container[1]
  // Any other instance id is `context.name`; the name alone is a person's detail only when it is not just the context repeated.
  const rest = instance.includes('.') ? instance.slice(instance.indexOf('.') + 1) : ''
  return /^[a-z0-9_]+$/.test(rest) ? '' : rest
}

/** The labels that say which machine and how to find it: the node's Cloud id, its address, the public name it is reached by. */
function addIdentityLabels(labels: Record<string, string>, who: NodeIdentity): void {
  if (who.id) labels.netdata_node_id = who.id
  if (who.ip) labels.host_ip = who.ip
  if (who.dns) labels.host_dns = who.dns
}

const WHAT: Record<string, string> = {
  disk_space_usage: 'Netdata warns when the filesystem is more than 90 % used and goes critical above 98 % with under 5 GiB available.',
  out_of_disk_space_time: 'Netdata projects the filesystem to be full in under 8 hours (warning) or under 2 hours (critical) at its recent fill rate.',
  disk_inode_usage: 'Netdata warns when the filesystem has used most of its inodes and goes critical when it is nearly out.',
  out_of_disk_inodes_time: 'Netdata projects the filesystem to run out of inodes in under 8 hours (warning) or under 2 hours (critical).',
  mdstat_disks: 'A member disk of a Linux software RAID array is missing or failed.',
  nvme_device_critical_warnings_state: 'An NVMe drive reports a critical warning in its SMART data.',
  docker_container_unhealthy: 'A Docker container reports an unhealthy health check.',
  system_post_update_reboot_status: 'The system installed updates that need a reboot to finish.',
  '10min_cpu_usage': "Netdata's stock alert: the CPU use averaged over 10 minutes (user, system, softirq, irq, guest; not iowait, nice or steal) is above 85 % (warning) or 95 % (critical), and it clears under 75 %.",
  ram_in_use: "Netdata's stock alert: RAM in use is above 90 % (warning) or 98 % (critical), and it clears under 80 %.",
  ram_available: "Netdata's stock alert: the RAM available to programs without swapping is under 10 % of the total, and it clears above 15 %."
}
function describeAlert(alert: string, level: NetdataLevel, who: NodeIdentity): string {
  if (lower(alert) === 'system_post_update_reboot_status') {
    const running = who.kernel ? ` It is still running kernel ${who.kernel}, and an` : ' An'
    return `${WHAT.system_post_update_reboot_status}${running} updated kernel or library only takes effect after a restart. Nothing pages for this: schedule the restart.`
  }
  const what = WHAT[lower(alert)]
  return what ?? `Netdata's alert ${alert} is ${level === 'critical' ? 'critical' : 'at warning'}.`
}
