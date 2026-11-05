// Fleet metrics source: one Netdata Cloud data query a minute for every node's CPU, memory, load and disks, the last hour at one point a minute.
// It keeps the latest snapshot in memory (GET /api/fleet, src/shared/fleet.ts) and raises the fleet-load alerts for fleet nodes (fleet-rules.ts).
//
// Two calls per poll, over outbound HTTPS with the same Netdata Cloud token as the netdata-cloud source (scope grafana-plugin, read-only data), docs
// fetched 2026-10-15 (https://app.netdata.cloud/api/docs/, operation post-scope-data; the Grafana plugin's useGetChartData posts the same body):
//  - GET  /api/v2/spaces/{space}/rooms/{room}/nodes   name, id, state, agent version, and the host labels `_system_cores` and `_system_ram_total`.
//  - POST /api/v3/spaces/{space}/rooms/{room}/data    ONE query for the whole room: contexts system.cpu, system.load, system.ram, mem.available and disk.space
//    (every instance but the paths a disk view never wants, `FLEET_INSTANCES`), grouped by node, context, instance, dimension and the `filesystem` label,
//    60 points over -3600..0 (so a point is a minute), `unaligned` so the last point is the trailing minute. The response is a table:
//    `view.dimensions.ids[i]` is the column's group-by values joined by commas, in the order `view.dimensions.grouped_by` names
//    (`<dimension>,<instance>,<filesystem>,<machine guid>,<context>`), `view.dimensions.units[i]` its unit, for column i + 1 of every `result.data` row
//    `[time, cell, cell, ...]`; a cell is `[value, anomaly rate, partial anomaly]` (`result.point.value` is the index of the value) or null.
//    The response is about 480 kB and answered in 0.3 to 0.5 s for 13 nodes (2026-10-15: 361 kB with the root disk only; every disk.space instance
//    unfiltered is 623 kB, so the instance patterns below cut the pseudo mounts, 14 pod volumes on node-14 among them, at the source).
//
// What the columns mean (all measured against the live room on 2026-10-15, see skills/ezo-watcher/references/netdata.md "Fleet load"):
//  - CPU %      the sum of every `system.cpu` dimension that is returned. Netdata leaves `idle` out of the query by default (the summary reports one
//               excluded dimension per node), so that sum is total minus idle. macOS has user, system, nice.
//  - Memory %   Linux: 100 - `mem.available` / (free + used + cached + buffers of `system.ram`), the kernel's own estimate of what a program can still get.
//               A node without `mem.available` (macOS): the share of `system.ram` that is not free, inactive, speculative or purgeable.
//  - Load       `system.load` load1, load5, load15; per core = load5 / the node's `_system_cores` label.
//  - Disk %     per mount, `disk_space.<mount>`: used / (used + avail), the figure `df` calls Use% and Netdata's own disk alert reads. Free is `avail`, size is
//               used + avail + `reserved for root` (the "915 GiB" of Netdata's alert text). Which mounts are kept: `keepMount`.
// A figure Cloud did not return is null, never 0 (the query does not ask for null-to-zero), so a missing minute is a gap, not a cold node.

import { createHash } from 'node:crypto'
import type { Alert, CellState, Observation, RuleCell } from '../../shared/types.ts'
import { DISK_HOT_AT, DISK_WARM_AT, diskHeatOf } from '../../shared/fleet.ts'
import type { FleetGroup, FleetHeat, FleetMount, FleetNode, FleetNodeRule, FleetRole, FleetRuleId, FleetSeries, FleetSummary, FleetView } from '../../shared/fleet.ts'
import type { NetdataFleetSourceConfig } from '../config.ts'
import { makeAlert } from '../derive.ts'
import type { PolledSource, SourceDeps } from './types.ts'
import { CloudError, cloudCall, describeNetworkFailure, nodeUrl } from './netdata-cloud.ts'
import { FLEET_LOAD_SERVICE, NO_STATES, RULE_INFO, cellName, describeFinding, evaluateNode, fleetRuleTitle, fleetRulesOf, heatOf, thresholdsOf } from './fleet-rules.ts'
import type { FleetRules, Finding, RuleStates } from './fleet-rules.ts'
import { clip, isRecord, safeUrl } from './shared.ts'

export const DEFAULT_WINDOW_MIN = 60
const MIB = 1048576
/** A node that did not answer keeps the alerts it last had for this long, so a blip in Cloud's fan-out does not resolve and re-fire an incident. */
const KEEP_ALERTS_MS = 15 * 60_000
/** The view reads a poll older than this many intervals as stale. */
const STALE_POLLS = 3
const SLOW_POLL_MS = 20_000

/** The contexts the one query asks for. A whole-room query is tens of megabytes; these five answer in about 480 kB. */
export const FLEET_CONTEXTS: readonly string[] = ['system.cpu', 'system.load', 'system.ram', 'mem.available', 'disk.space']

/**
 * Mount points that are never a disk worth watching: boot partitions, snap images, the runtime, device and kernel trees (tmpfs and the per-pod
 * volumes under /run among them), and the container runtimes' overlay and pod volume paths. A prefix means that path and everything under it
 * (`/run` and `/run/user/0`, never `/runner`). One list: the query drops these at the source and `keepMount` drops them again from what is read.
 */
export const MOUNT_EXCLUDE_PREFIXES: readonly string[] = [
  '/boot',
  '/snap',
  '/var/snap',
  '/run',
  '/var/run',
  '/dev',
  '/sys',
  '/proc',
  '/var/lib/docker',
  '/var/lib/containerd',
  '/var/lib/kubelet',
  '/var/lib/containers',
  '/System'
]

/** The instances the one query asks for: the four host contexts' own, every disk instance but the excluded paths (`!` patterns, the first match wins). */
export const FLEET_INSTANCES: readonly string[] = [
  'system.cpu',
  'system.load',
  'system.ram',
  'mem.available',
  ...MOUNT_EXCLUDE_PREFIXES.flatMap((p) => [`!disk_space.${p}`, `!disk_space.${p}/*`]),
  'disk_space.*'
]

/** A mount other than `/` has to be at least this big (50 GiB) to be worth a line: the small ones are boot, EFI and scratch volumes. */
export const MOUNT_MIN_BYTES = 50 * 1024 ** 3

/** Filesystems that are memory, kernel or container plumbing, whatever path they are mounted on (`tmpfs` on /tmp is 93 GiB on a 188 GiB box). */
export const PSEUDO_FILESYSTEMS: ReadonlySet<string> = new Set([
  'tmpfs', 'devtmpfs', 'ramfs', 'overlay', 'squashfs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'efivarfs', 'nsfs', 'securityfs', 'debugfs', 'tracefs',
  'autofs', 'fusectl', 'mqueue', 'hugetlbfs', 'configfs', 'pstore', 'bpf'
])

export const mountExcluded = (path: string): boolean => MOUNT_EXCLUDE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))

/** Does this mount earn a place: `/` always; any other that is a real filesystem (not plumbing, by path or by type) of at least 50 GiB. */
export function keepMount(path: string, fs: string, sizeBytes: number | null): boolean {
  if (path === '/') return true
  if (mountExcluded(path) || PSEUDO_FILESYSTEMS.has(fs.toLowerCase())) return false
  return sizeBytes !== null && sizeBytes >= MOUNT_MIN_BYTES
}

export function fleetQuery(windowMin: number, timeoutMs: number): Record<string, unknown> {
  return {
    scope: { contexts: FLEET_CONTEXTS },
    selectors: { nodes: ['*'], contexts: FLEET_CONTEXTS, instances: FLEET_INSTANCES, dimensions: ['*'], labels: ['*'] },
    window: { after: -windowMin * 60, before: 0, points: windowMin },
    // The instance and the filesystem label are grouped by so each disk is its own column and says what it is; the other contexts have one instance
    // each, so they are the same columns as before with the instance named in their id.
    aggregations: { metrics: [{ group_by: ['node', 'context', 'instance', 'dimension', 'label'], group_by_label: ['filesystem'], aggregation: 'sum' }], time: { time_group: 'average' } },
    format: 'json2',
    options: ['jsonwrap', 'minify', 'unaligned'],
    timeout: Math.min(timeoutMs - 1000, 30_000)
  }
}

// ---- reading the responses ---------------------------------------------------------------------------------------

type Points = Array<number | null>

/** One node's raw columns, row for row, as the data response has them. */
export interface NodeColumns {
  name: string
  /** Netdata Cloud's node id (summary `nd`), the last part of the node's page. */
  id: string
  /** The agent's HTTP status in Cloud's fan-out; 200 = it answered. */
  code: number
  cpu: Points
  load1: Points
  load5: Points
  load15: Points
  /** Percent of RAM in use, by the rule above. */
  mem: Points
  /** Root filesystem percent used (the `/` mount's series, or all null). */
  disk: Points
  /** The mounts that matter (`keepMount`), in the response's column order. */
  mounts: ParsedMount[]
}

/** One kept mount's columns: used percent, and the three dimensions in bytes. A figure whose unit Cloud did not name is null. */
export interface ParsedMount {
  path: string
  fs: string
  pct: Points
  used: Points
  free: Points
  reserved: Points
}

export interface ParsedFleet {
  nodes: NodeColumns[]
  /** Epoch seconds of each row (the end of its minute). */
  times: number[]
  stepSec: number
  /** The agents' clock, epoch seconds, or null. */
  agentNowSec: number | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const r1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10)
const r2 = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100)

/** The value of one cell: `[value, arp, pa]`, a bare number, or null. */
function cellValue(cell: unknown, valueAt: number): number | null {
  if (Array.isArray(cell)) return num(cell[valueAt])
  return num(cell)
}

/** The bytes in one unit name Netdata puts on a disk or memory column. */
const UNIT_BYTES: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, PiB: 1024 ** 5 }

/** The group-by order of a response that predates the instance grouping: `used,<machine guid>,disk.space`. */
const LEGACY_ORDER: readonly string[] = ['dimension', 'node', 'context']

interface ColumnId {
  dim: string
  guid: string
  ctx: string
  /** The instance id (`disk_space./data/ssd1`), or an empty string when the response was not grouped by instance. */
  instance: string
  /** The `filesystem` label value; empty for `[unset]` or no label grouping. */
  fs: string
}

/**
 * A column id is the group-by values joined by commas in the order `grouped_by` names. A dimension (`reserved for root`), a guid, a context and a
 * label value hold spaces at most; only an instance id (a mount path) may hold a comma, so the instance is whatever sits between the values before
 * it and the values after it.
 */
export function splitColumnId(id: string, order: readonly string[] = LEGACY_ORDER): ColumnId | null {
  const parts = id.split(',')
  const at = order.indexOf('instance')
  const before = at < 0 ? order.length : at
  const after = at < 0 ? 0 : order.length - at - 1
  if (parts.length < order.length) return null
  const left = parts.slice(0, before)
  const right = after > 0 ? parts.slice(parts.length - after) : []
  const instance = at < 0 ? '' : parts.slice(before, parts.length - after).join(',')
  const named = [...left, ...right]
  const names = order.filter((o) => o !== 'instance')
  const pick = (name: string): string => named[names.indexOf(name)] ?? ''
  const label = names.find((n) => n.startsWith('label'))
  const fs = label ? pick(label) : ''
  const out: ColumnId = { dim: pick('dimension'), guid: pick('node'), ctx: pick('context'), instance, fs: fs === '[unset]' ? '' : fs }
  return out.dim && out.guid && out.ctx ? out : null
}

/** `disk_space./data/ssd1` is the mount `/data/ssd1`; an agent that names the root chart `disk_space._` means `/`. */
export function mountPath(instance: string): string {
  const path = instance.startsWith('disk_space.') ? instance.slice('disk_space.'.length) : instance
  return path === '_' || path === '' ? '/' : path
}

const sum = (xs: Array<number | null>): number | null => {
  let any = false
  let total = 0
  for (const x of xs) {
    if (x === null) continue
    any = true
    total += x
  }
  return any ? total : null
}

/**
 * The node memory in use, as a percent, from its `system.ram` dimensions and `mem.available` at one minute. Linux: 100 - available / total. No
 * `mem.available` and a `used` dimension (BSD): used / total. macOS (no `used`): everything that is not free, inactive, speculative or purgeable.
 */
export function memoryPercent(ram: Record<string, number | null>, avail: number | null): number | null {
  const parts = Object.values(ram)
  const total = sum(parts)
  if (total === null || total <= 0) return null
  let used: number | null
  if (avail !== null) used = total - avail
  else if (ram.used !== undefined && ram.used !== null) used = ram.used
  else if (ram.free !== undefined && ram.free !== null) used = total - ram.free - (ram.inactive ?? 0) - (ram.speculative ?? 0) - (ram.purgeable ?? 0)
  else used = null
  if (used === null) return null
  return Math.min(100, Math.max(0, (used / total) * 100))
}

export function parseFleetData(body: unknown): ParsedFleet {
  if (!isRecord(body) || !isRecord(body.summary) || !Array.isArray(body.summary.nodes) || !isRecord(body.view) || !isRecord(body.result)) {
    throw new Error('Netdata Cloud fleet data response has an unexpected shape')
  }
  const dims = isRecord(body.view.dimensions) ? body.view.dimensions : {}
  const ids = Array.isArray(dims.ids) ? dims.ids : []
  const units = Array.isArray(dims.units) ? dims.units : []
  const order = Array.isArray(dims.grouped_by) && dims.grouped_by.every((g) => typeof g === 'string') ? (dims.grouped_by as string[]) : LEGACY_ORDER
  const rows = Array.isArray(body.result.data) ? body.result.data : []
  const point = isRecord(body.result.point) ? body.result.point : {}
  const valueAt = typeof point.value === 'number' ? point.value : 0
  const times = rows.map((r) => (Array.isArray(r) && typeof r[0] === 'number' ? r[0] : 0))
  const stepSec = times.length >= 2 && times[1] > times[0] ? times[1] - times[0] : 60

  // machine guid -> node
  const byGuid = new Map<string, NodeColumns>()
  const nodes: NodeColumns[] = []
  const empty = (): Points => rows.map(() => null)
  for (const n of body.summary.nodes) {
    if (!isRecord(n) || typeof n.nm !== 'string' || typeof n.mg !== 'string') continue
    const st = isRecord(n.st) && typeof n.st.code === 'number' ? n.st.code : 200
    const node: NodeColumns = { name: n.nm, id: typeof n.nd === 'string' ? n.nd : '', code: st, cpu: empty(), load1: empty(), load5: empty(), load15: empty(), mem: empty(), disk: empty(), mounts: [] }
    byGuid.set(n.mg, node)
    nodes.push(node)
  }

  // node -> context -> instance -> dimension -> column (1-based: column 0 of a row is its time) and its unit and filesystem
  interface Col {
    at: number
    unit: string
    fs: string
  }
  const cols = new Map<NodeColumns, Map<string, Map<string, Map<string, Col>>>>()
  ids.forEach((raw, i) => {
    if (typeof raw !== 'string') return
    const c = splitColumnId(raw, order)
    const node = c ? byGuid.get(c.guid) : undefined
    if (!c || !node) return
    const perNode = cols.get(node) ?? new Map<string, Map<string, Map<string, Col>>>()
    const perCtx = perNode.get(c.ctx) ?? new Map<string, Map<string, Col>>()
    const perInst = perCtx.get(c.instance) ?? new Map<string, Col>()
    perInst.set(c.dim, { at: i + 1, unit: typeof units[i] === 'string' ? units[i] : '', fs: c.fs })
    perCtx.set(c.instance, perInst)
    perNode.set(c.ctx, perCtx)
    cols.set(node, perNode)
  })

  for (const [node, perNode] of cols) {
    const at = (row: unknown, col: number): number | null => (Array.isArray(row) ? cellValue(row[col], valueAt) : null)
    // the host contexts have one instance each: its dimensions are the context's
    const flat = (ctx: string): Map<string, number> | undefined => {
      const insts = perNode.get(ctx)
      if (!insts) return undefined
      const out = new Map<string, number>()
      for (const perInst of insts.values()) for (const [dim, c] of perInst) out.set(dim, c.at)
      return out
    }
    const cpu = flat('system.cpu')
    const load = flat('system.load')
    const ram = flat('system.ram')
    const avail = flat('mem.available')?.get('avail')
    rows.forEach((row, r) => {
      if (cpu) node.cpu[r] = sum([...cpu.values()].map((c) => at(row, c)))
      if (load) {
        node.load1[r] = at(row, load.get('load1') ?? -1)
        node.load5[r] = at(row, load.get('load5') ?? -1)
        node.load15[r] = at(row, load.get('load15') ?? -1)
      }
      if (ram) {
        const parts: Record<string, number | null> = {}
        for (const [dim, c] of ram) parts[dim] = at(row, c)
        node.mem[r] = memoryPercent(parts, avail === undefined ? null : at(row, avail))
      }
    })

    // disks: one mount per instance
    for (const [instance, perInst] of perNode.get('disk.space') ?? []) {
      const path = mountPath(instance)
      const used = perInst.get('used')
      const free = perInst.get('avail')
      const reserved = perInst.get('reserved for root')
      const mount: ParsedMount = { path, fs: [...perInst.values()][0]?.fs ?? '', pct: empty(), used: empty(), free: empty(), reserved: empty() }
      const bytes = (v: number | null, c: Col | undefined): number | null => {
        const factor = c ? UNIT_BYTES[c.unit || 'GiB'] : undefined
        return v === null || factor === undefined ? null : v * factor
      }
      rows.forEach((row, r) => {
        const u = used ? at(row, used.at) : null
        const f = free ? at(row, free.at) : null
        mount.pct[r] = u !== null && f !== null && u + f > 0 ? (u / (u + f)) * 100 : null
        mount.used[r] = bytes(u, used)
        mount.free[r] = bytes(f, free)
        mount.reserved[r] = reserved ? bytes(at(row, reserved.at), reserved) : null
      })
      const size = sizeNow(mount)
      if (!keepMount(path, mount.fs, size)) continue
      node.mounts.push(mount)
      if (path === '/') node.disk = mount.pct
    }
  }

  const nows = Array.isArray(body.agents) ? body.agents.flatMap((a) => (isRecord(a) && typeof a.now === 'number' && a.now > 0 ? [a.now] : [])) : []
  return { nodes, times, stepSec, agentNowSec: nows.length ? Math.max(...nows) : null }
}

/** A mount's size as `df` counts it, from its newest readings: used + available + reserved for root (a mount with no reserve counts none). Null with no used or no available reading. */
function sizeNow(m: Pick<ParsedMount, 'used' | 'free' | 'reserved'>): number | null {
  const used = latest(m.used, m.used.length)
  const free = latest(m.free, m.free.length)
  if (used === null || free === null) return null
  return used + free + (latest(m.reserved, m.reserved.length) ?? 0)
}

/** What the nodes call says about a node. */
export interface NodeSpec {
  id: string
  name: string
  state: string
  version: string
  cores: number | null
  ramBytes: number | null
}

/** The room's nodes with the two host labels the metrics need. A deleted node and one without a name are left out. */
export function readNodeSpecs(body: unknown): NodeSpec[] {
  if (!Array.isArray(body)) throw new Error('Netdata Cloud nodes response is not a list')
  const out: NodeSpec[] = []
  for (const n of body) {
    if (!isRecord(n) || typeof n.name !== 'string' || n.name === '' || n.isDeleted === true) continue
    const labels = isRecord(n.hostLabels) ? n.hostLabels : {}
    const cores = Number(labels._system_cores)
    const ram = Number(labels._system_ram_total)
    out.push({
      id: typeof n.id === 'string' ? clip(n.id, 80) : '',
      name: n.name,
      state: typeof n.state === 'string' ? n.state : 'unknown',
      version: typeof n.version === 'string' ? n.version : '',
      cores: Number.isFinite(cores) && cores > 0 ? Math.round(cores) : null,
      ramBytes: Number.isFinite(ram) && ram > 0 ? ram : null
    })
  }
  return out
}

// ---- the snapshot -------------------------------------------------------------------------------------------------

const lower = (s: string): string => s.toLowerCase()
const inList = (list: readonly string[] | undefined, name: string): boolean => (list ?? []).some((x) => lower(x) === lower(name))
const sha16 = (...parts: string[]): string => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)

/** `node-2` before `node-13`: the numbers inside a name compare as numbers. */
const byName = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true })

const GROUP_OF: Record<FleetRole, FleetGroup> = { fleet: 'servers', 'watch-only': 'watch only', k8s: 'k8s' }
const ROLE_RANK: Record<FleetRole, number> = { fleet: 0, 'watch-only': 1, k8s: 2 }

export function roleOf(name: string, cfg: Pick<NetdataFleetSourceConfig, 'fleetNodes' | 'watchOnlyNodes' | 'k8sNodes'>): FleetRole {
  if (inList(cfg.fleetNodes, name)) return 'fleet'
  if (inList(cfg.k8sNodes, name) || /^netdata-k8s/i.test(name)) return 'k8s'
  // A node in the room that is in no list counts as watch-only, as in the netdata-cloud source: nothing it says may page.
  return 'watch-only'
}

/** True for a node the config says not to watch at all (`ignoreNodes`); the case of the name does not matter. */
export function ignoredNode(name: string, cfg: Pick<NetdataFleetSourceConfig, 'ignoreNodes'>): boolean {
  return inList(Object.keys(cfg.ignoreNodes ?? {}), name)
}

/** The last non-null of the newest `lookback` points, or null. */
function latest(points: Points, lookback = 3): number | null {
  for (let i = points.length - 1; i >= Math.max(0, points.length - lookback); i--) if (points[i] !== null) return points[i]
  return null
}

function mean(points: Points, count: number): number | null {
  const tail = points.slice(-count).filter((v): v is number => v !== null)
  return tail.length >= Math.ceil(count * 0.6) ? tail.reduce((a, b) => a + b, 0) / tail.length : null
}

interface StoredNode {
  spec: NodeSpec | undefined
  name: string
  role: FleetRole
  live: boolean
  updatedAtSec: number | null
  cpu: Points
  mem: Points
  load1: Points
  load5: Points
  load15: Points
  loadPerCore: Points
  disk: Points
  mounts: ParsedMount[]
  findings: Array<Finding & { startsAtIso: string }>
}

interface Snapshot {
  polledAtMs: number
  dataAtSec: number | null
  from: number
  stepSec: number
  nodes: StoredNode[]
}

/** One mount as the view has it: the newest readings (null while the node has no fresh data), the whole series, the heat from the figure as shown. */
function mountView(m: ParsedMount, live: boolean): FleetMount {
  const usedPct = live ? r1(latest(m.pct)) : null
  const size = live ? sizeNow(m) : null
  const whole = (v: number | null): number | null => (live && v !== null ? Math.round(v) : null)
  return {
    path: m.path,
    fs: m.fs,
    usedPct,
    usedBytes: whole(latest(m.used)),
    freeBytes: whole(latest(m.free)),
    sizeBytes: size === null ? null : Math.round(size),
    series: m.pct.map(r1),
    heat: diskHeatOf(usedPct)
  }
}

/** The fullest mount first; no reading goes last, and between equals `/` leads, then the path. */
function byFullness(a: FleetMount, b: FleetMount): number {
  const pa = a.usedPct ?? -1
  const pb = b.usedPct ?? -1
  return pb - pa || (a.path === '/' ? -1 : 0) - (b.path === '/' ? -1 : 0) || byName(a.path, b.path)
}

/** The source, and the snapshot it holds. `view()` is what GET /api/fleet answers. */
export interface FleetSource extends PolledSource {
  view(nowMs?: number): FleetView
  /** The rules in force, for the replay script and the tests. */
  rules: FleetRules
}

export function createNetdataFleetSource(cfg: NetdataFleetSourceConfig, deps: SourceDeps, nowMs: () => number = Date.now): FleetSource {
  const origin = new URL(cfg.url).origin
  const base = `${origin}/api`
  const room = `/spaces/${encodeURIComponent(cfg.spaceId)}/rooms/${encodeURIComponent(cfg.roomId)}`
  const rules = fleetRulesOf(cfg.rules)
  const thresholds = thresholdsOf(rules)
  const windowMin = cfg.windowMin ?? DEFAULT_WINDOW_MIN
  const timeoutMs = cfg.requestTimeoutMs ?? 15_000
  const pollMs = cfg.pollSec * 1000
  const link = safeUrl(cfg.cloudUrl)

  let snapshot: Snapshot | null = null
  let lastOkMs: number | null = null
  let lastError: string | null = null
  let failures = 0
  let notBeforeMs = 0
  /** What each rule ended the last poll as, per node: the only memory the rules have (fleet-rules.ts). */
  const states = new Map<string, RuleStates>()
  /** When an open episode began, per alert key, for an episode that began before the series did. */
  const since = new Map<string, string>()
  /** The alerts a node had when it last answered, kept while it does not (KEEP_ALERTS_MS). */
  const kept = new Map<string, { atMs: number; alerts: Alert[] }>()

  const call = (token: string, method: 'GET' | 'POST', path: string, label: string, body?: unknown): Promise<unknown> => cloudCall(deps.fetch, base, timeoutMs, token, method, path, label, body)

  function buildAlert(node: StoredNode, f: Finding, startsAt: string, now: string, from: number, stepSec: number): Alert {
    const info = RULE_INFO[f.id]
    const host = node.name
    const url = nodeUrl(cfg.cloudUrl, node.spec?.id ?? '') ?? link
    const series = f.id === 'cpu-hot' ? node.cpu : f.id === 'memory-hot' ? node.mem : node.loadPerCore
    const recent = series.slice(-Math.max(30, f.forMin * 2)).map((v) => (v === null ? null : Math.round(v * 100) / 100))
    const reading = describeFinding(f)
    const specs = [node.spec?.cores ? `${node.spec.cores} cores` : '', node.spec?.ramBytes ? `${Math.round(node.spec.ramBytes / 1024 ** 3)} GiB RAM` : ''].filter(Boolean).join(', ')
    const what: Record<FleetRuleId, string> = {
      'cpu-hot': `CPU on ${host} has averaged ${reading}. HostCpuHot warns when the 10-minute CPU average is above ${rules.cpu.warnAbove}% (every dimension of system.cpu but idle) and clears under ${rules.cpu.clearBelow}%. Netdata's own 10min_cpu_usage alert (warns above 85%, clears under 75%) joins this incident when it fires too.`,
      'memory-hot': `Memory on ${host} is in use at ${reading}. HostMemoryHot warns when memory in use (100% minus MemAvailable) stays above ${rules.memoryWarn.warnAbove}% for ${rules.memoryWarn.forMin} min and pages above ${rules.memoryPage.warnAbove}% for ${rules.memoryPage.forMin} min; it clears under ${rules.memoryWarn.clearBelow}% (${rules.memoryPage.clearBelow}% for the page).`,
      'load-high': `Load on ${host} is ${reading}. HostLoadHigh warns when load5 divided by the core count stays above ${rules.load.warnAbove} for ${rules.load.forMin} min and clears under ${rules.load.clearBelow}.`
    }
    const summary: Record<FleetRuleId, string> = {
      'cpu-hot': `${host} CPU is hot: ${reading}`,
      'memory-hot': `${host} memory is ${f.level === 'page' ? 'nearly out' : 'hot'}: ${reading}`,
      'load-high': `${host} load is high: ${reading}`
    }
    return makeAlert(
      {
        origin: cfg.id,
        // The level is not in the fingerprint: a memory warning that grows into a page is the same alert, changed in place.
        fingerprint: sha16(host.toLowerCase(), f.id),
        rule: fleetRuleTitle(f.id, host),
        labels: {
          alertname: info.alertname,
          severity: f.level === 'page' ? 'critical' : 'warning',
          host,
          instance: host,
          component: 'fleet-load',
          service: FLEET_LOAD_SERVICE,
          system: 'Netdata',
          fleet_rule: f.id,
          ...(node.spec?.id ? { netdata_node_id: node.spec.id } : {})
        },
        annotations: {
          summary: summary[f.id],
          description: what[f.id],
          where: `Netdata Cloud metrics of ${host}${specs ? ` (${specs})` : ''}, read by ${deps.brand ?? 'EZO Watcher'} every ${cfg.pollSec} s (space ${cfg.spaceId}).`
        },
        startsAt,
        generatorURL: url,
        links: url ? { generator: url } : {},
        value: reading,
        via: { source: cfg.id, kind: 'netdata-fleet', lastSeen: now, url },
        raw: { node: host, rule: f.id, level: f.level, threshold: f.threshold, forMin: f.forMin, over: f.over, value: f.value, from, stepSec, recent }
      },
      deps.serviceMap,
      now
    )
  }

  /** Cells: one per rule, solid while the rule is being evaluated, plus one for the metrics read itself. */
  function cells(nodes: StoredNode[], dataAt: string, firing: Map<FleetRuleId, string[]>): RuleCell[] {
    const fleet = nodes.filter((n) => n.role === 'fleet')
    const live = fleet.filter((n) => n.live)
    const cell = (id: string, name: string, state: CellState, detail: string): RuleCell => ({
      id: `${cfg.id}:${id}`,
      source: cfg.id,
      name,
      service: FLEET_LOAD_SERVICE,
      state,
      evaluatedAt: dataAt,
      intervalSec: cfg.pollSec,
      detail,
      url: link
    })
    const out: RuleCell[] = []
    const missing = fleet.filter((n) => !n.live).map((n) => n.name)
    out.push(
      cell(
        'metrics',
        `Fleet metrics from Netdata Cloud (${live.length}/${fleet.length} servers)`,
        live.length === 0 ? 'nodata' : missing.length > 0 ? 'error' : 'ok',
        missing.length > 0 ? `no data from ${missing.join(', ')}` : `CPU, memory, load and disk of ${fleet.length} servers, ${windowMin} min at one point a minute`
      )
    )
    for (const id of ['cpu-hot', 'memory-hot', 'load-high'] as const) {
      const hot = firing.get(id) ?? []
      out.push(cell(id, cellName(id, rules), live.length === 0 ? 'nodata' : hot.length > 0 ? 'firing' : 'ok', hot.length > 0 ? `firing on ${hot.join(', ')}` : `evaluated on ${live.length} of ${fleet.length} fleet servers`))
    }
    return out
  }

  async function runPoll(token: string, now: string): Promise<Observation> {
    const specs = readNodeSpecs(await call(token, 'GET', `/v2${room}/nodes`, 'Netdata Cloud nodes'))
    const parsed = parseFleetData(await call(token, 'POST', `/v3${room}/data`, 'Netdata Cloud fleet metrics', fleetQuery(windowMin, timeoutMs)))
    const specByName = new Map(specs.map((s) => [lower(s.name), s]))
    const colsByName = new Map(parsed.nodes.map((n) => [lower(n.name), n]))
    const rows = parsed.times.length
    const from = rows > 0 ? parsed.times[0] : 0
    const blank = (): Points => Array.from({ length: rows }, () => null)
    const nowMsValue = Date.parse(now)

    // Every node of the room, plus a configured fleet node the room does not list (shown as not answering). A node of ignoreNodes is not watched: it has no
    // row, no rule and no count anywhere below.
    const names = new Map<string, string>()
    for (const s of specs) names.set(lower(s.name), s.name)
    for (const n of parsed.nodes) names.set(lower(n.name), n.name)
    for (const n of cfg.fleetNodes) if (!names.has(lower(n))) names.set(lower(n), n)
    for (const key of [...names.keys()]) if (ignoredNode(key, cfg)) names.delete(key)

    const nodes: StoredNode[] = []
    for (const [key, name] of names) {
      const spec = specByName.get(key)
      const cols = colsByName.get(key)
      const role = roleOf(name, cfg)
      const cores = spec?.cores ?? null
      const load5 = cols?.load5 ?? blank()
      const loadPerCore = cores ? load5.map((v) => (v === null ? null : v / cores)) : blank()
      const cpu = cols?.cpu ?? blank()
      const answered = !!cols && cols.code === 200 && [cols.cpu, cols.load1, cols.mem].some((p) => latest(p, 3) !== null)
      const lastRow = (() => {
        for (let i = rows - 1; i >= 0; i--) if (cpu[i] !== null || (cols?.load1[i] ?? null) !== null) return i
        return -1
      })()
      nodes.push({
        spec,
        name,
        role,
        live: answered && (spec ? spec.state === 'reachable' : true),
        updatedAtSec: lastRow >= 0 ? parsed.times[lastRow] : null,
        cpu,
        mem: cols?.mem ?? blank(),
        load1: cols?.load1 ?? blank(),
        load5,
        load15: cols?.load15 ?? blank(),
        loadPerCore,
        disk: cols?.disk ?? blank(),
        mounts: cols?.mounts ?? [],
        findings: []
      })
    }

    // Rules: fleet nodes only, and only on a node that answered.
    const firing: Alert[] = []
    const seen = new Set<string>()
    const firingBy = new Map<FleetRuleId, string[]>()
    const dataAtSec = parsed.times.length ? parsed.times[parsed.times.length - 1] : null
    for (const n of nodes) {
      if (n.role !== 'fleet') continue
      let alerts: Alert[] = []
      if (n.live) {
        const ev = evaluateNode({ cpu: n.cpu.map(r1), mem: n.mem.map(r1), loadPerCore: n.loadPerCore.map(r2) }, rules, states.get(lower(n.name)) ?? NO_STATES)
        states.set(lower(n.name), ev.states)
        for (const f of ev.findings) {
          const key = sha16(n.name.toLowerCase(), f.id)
          const startsAt = f.startIndex !== null ? new Date((from + f.startIndex * parsed.stepSec) * 1000).toISOString() : (since.get(key) ?? new Date(from * 1000).toISOString())
          if (f.startIndex !== null) since.set(key, startsAt)
          n.findings.push({ ...f, startsAtIso: startsAt })
          alerts.push(buildAlert(n, f, startsAt, now, from, parsed.stepSec))
        }
        // an episode that ended forgets its start
        for (const id of ['cpu-hot', 'memory-hot', 'load-high'] as const) if (!ev.findings.some((f) => f.id === id)) since.delete(sha16(n.name.toLowerCase(), id))
        kept.set(lower(n.name), { atMs: nowMsValue, alerts })
      } else {
        const k = kept.get(lower(n.name))
        if (k && nowMsValue - k.atMs <= KEEP_ALERTS_MS) alerts = k.alerts
        else kept.delete(lower(n.name))
      }
      for (const a of alerts) {
        if (seen.has(a.key)) continue
        seen.add(a.key)
        firing.push(a)
        const id = a.labels.fleet_rule as FleetRuleId
        firingBy.set(id, [...(firingBy.get(id) ?? []), n.name])
      }
    }

    snapshot = { polledAtMs: nowMsValue, dataAtSec, from, stepSec: parsed.stepSec, nodes }
    const dataAt = dataAtSec !== null ? new Date(dataAtSec * 1000).toISOString() : now
    return { source: cfg.id, kind: 'netdata-fleet', at: now, firing, resolved: [], complete: true, rules: cells(nodes, dataAt, firingBy) }
  }

  async function poll(): Promise<Observation> {
    const token = deps.env[cfg.tokenEnv]?.trim()
    if (!token) throw new Error(`Netdata Cloud token missing: ${cfg.tokenEnv} is not set or is empty in the Watch environment file (see watcher skills netdata)`)
    const now = deps.nowIso()
    const nowValue = Date.parse(now)
    if (nowValue < notBeforeMs) throw new Error(`backing off after: ${lastError} (next request in ${Math.ceil((notBeforeMs - nowValue) / 1000)} s)`)
    const started = Date.now()
    try {
      const obs = await runPoll(token, now)
      failures = 0
      notBeforeMs = 0
      lastOkMs = nowMs()
      lastError = null
      if (Date.now() - started > SLOW_POLL_MS) deps.log?.(`netdata-fleet poll took ${Math.round((Date.now() - started) / 1000)} s`)
      return obs
    } catch (err) {
      const e = err instanceof CloudError ? err : describeNetworkFailure(err, timeoutMs)
      failures += 1
      lastError = (err as Error).message
      // As the netdata-cloud source: one failure costs nothing extra, repeated ones double the wait up to 8 polls, a 429's Retry-After is honoured up to 15 minutes.
      const wait = failures <= 1 ? 0 : Math.min(pollMs * 2 ** (failures - 1), 8 * pollMs)
      const asked = e.kind === 'throttle' ? Math.min((e.retryAfterSec ?? 0) * 1000, 15 * 60_000) : 0
      const hold = Math.max(wait, asked)
      notBeforeMs = hold > 0 ? nowValue + hold - 5000 : 0
      throw err
    }
  }

  function view(at: number = nowMs()): FleetView {
    const generatedAt = new Date(at).toISOString()
    const ageSec = lastOkMs === null ? null : Math.max(0, Math.round((at - lastOkMs) / 1000))
    const stale = ageSec === null || ageSec > STALE_POLLS * cfg.pollSec
    const snap = snapshot
    const nodes: FleetNode[] = (snap?.nodes ?? [])
      .map((n): FleetNode => {
        const live = n.live && !stale
        const ruleList: FleetNodeRule[] = n.findings.map((f) => ({ id: f.id, alertname: RULE_INFO[f.id].alertname, level: f.level, since: f.startsAtIso, value: describeFinding(f) }))
        const cpu10 = live ? mean(n.cpu, rules.cpu.forMin) : null
        const mem = live ? latest(n.mem) : null
        const loadPerCore = live ? latest(n.loadPerCore) : null
        const updatedAt = n.updatedAtSec !== null ? new Date(n.updatedAtSec * 1000).toISOString() : null
        const heat: FleetHeat = n.role === 'k8s' ? 'unknown' : heatOf({ cpu10, mem, loadPerCore, firing: ruleList.length > 0 }, rules)
        const series: FleetSeries = { from: snap?.from ?? 0, stepSec: snap?.stepSec ?? 60, cpu: n.cpu.map(r1), mem: n.mem.map(r1), loadPerCore: n.loadPerCore.map(r2), disk: n.disk.map(r1) }
        const mounts = n.mounts.map((m): FleetMount => mountView(m, live)).sort(byFullness)
        const diskHeat = mounts[0]?.heat ?? 'unknown'
        const url = nodeUrl(cfg.cloudUrl, n.spec?.id ?? '')
        return {
          name: n.name,
          role: n.role,
          group: GROUP_OF[n.role],
          state: n.spec?.state ?? 'missing from the room',
          live,
          updatedAt,
          stale: !live || n.updatedAtSec === null || at - n.updatedAtSec * 1000 > STALE_POLLS * pollMs + 60_000,
          heat,
          cores: n.spec?.cores ?? null,
          ramBytes: n.spec?.ramBytes ?? null,
          version: n.spec?.version ?? '',
          cpu: live ? r1(latest(n.cpu)) : null,
          cpu10: r1(cpu10),
          mem: r1(mem),
          load1: live ? r2(latest(n.load1)) : null,
          load5: live ? r2(latest(n.load5)) : null,
          load15: live ? r2(latest(n.load15)) : null,
          loadPerCore: r2(loadPerCore),
          disk: live ? r1(latest(n.disk)) : null,
          mounts,
          diskHeat,
          series,
          rules: n.role === 'fleet' ? ruleList : [],
          ...(url ? { url } : {})
        }
      })
      .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || byName(a.name, b.name))
    const hosts = nodes.filter((n) => n.role !== 'k8s')
    const liveHosts = hosts.filter((n) => n.live && n.cpu !== null)
    const hottest = liveHosts.reduce<FleetNode | null>((best, n) => (best === null || (n.cpu ?? 0) > (best.cpu ?? 0) ? n : best), null)
    const servers = liveHosts.filter((n) => n.role === 'fleet')
    const summary: FleetSummary = {
      nodes: hosts.length,
      servers: hosts.filter((n) => n.role === 'fleet').length,
      watchOnly: hosts.filter((n) => n.role === 'watch-only').length,
      live: liveHosts.length,
      hot: hosts.filter((n) => n.heat === 'hot').length,
      warm: hosts.filter((n) => n.heat === 'warm').length,
      cold: hosts.filter((n) => n.heat === 'cold').length,
      hottest: hottest && hottest.cpu !== null ? { name: hottest.name, cpu: hottest.cpu } : null,
      fleetCpuAvg: servers.length ? r1(servers.reduce((a, n) => a + (n.cpu ?? 0), 0) / servers.length) : null
    }
    return {
      generatedAt,
      dataAt: snap?.dataAtSec ? new Date(snap.dataAtSec * 1000).toISOString() : null,
      ageSec,
      pollSec: cfg.pollSec,
      stale,
      error: lastError,
      windowMin,
      stepSec: snap?.stepSec ?? 60,
      thresholds: { ...thresholds, disk: { warmAt: DISK_WARM_AT, hotAt: DISK_HOT_AT } },
      summary,
      nodes,
      ...(link ? { cloudUrl: link } : {})
    }
  }

  return { id: cfg.id, kind: 'netdata-fleet', name: 'Netdata fleet metrics', pollSec: cfg.pollSec, poll, view, rules }
}
